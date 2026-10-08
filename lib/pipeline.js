// ═════════════════════════════════════════════════════════════════
//  Verity analysis pipeline (v9)
//
//   1. frame        PICO + 1-3 prespecified outcomes + search terms
//   2. retrieve     PubMed (reviews / RCTs / general) + Europe PMC +
//                   Semantic Scholar + OpenAlex, in parallel
//   3. merge        field-level merge-dedupe; retractions excluded
//   4. gate         deterministic entity filter (phrase + plural aware)
//   5. select       design + source relevance; citations tie-break only
//   6. screen       LLM relevance screen (failures disclosed, not hidden)
//   7. extract      per-paper findings with verbatim quotes
//   8. verify       quotes and effect sizes checked against the abstract
//   9. score        lib/scoring.js — deterministic, per outcome
//  10. narrate      synthesis with citations + verdict, number-checked
//  11. media        headline framing on the same axis, divergence
//
//  All I/O is injected (client, http, store) so the whole pipeline
//  runs offline in tests.
// ═════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const { buildMatcher, quoteIsGrounded, numbersGrounded, cleanText } = require('./text');
const { mergeDedupe, paperRef, selectionScore, summariseFunding } = require('./papers');
const { computeConsensus, ALGORITHM_VERSION } = require('./scoring');
const { makeSources } = require('./sources');
const { makeMedia } = require('./media');
const llm = require('./llm');

const DESIGNS = new Set(['umbrella', 'meta', 'rct', 'nonrandomized_trial', 'cohort', 'case_control',
  'cross_sectional', 'obs', 'narrative_review', 'case_report', 'animal', 'in_vitro', 'unknown']);
// Curated PubMed labels we trust over the LLM's reading of the abstract
const TRUSTED_API_DESIGNS = new Set(['meta', 'rct', 'case_report', 'nonrandomized_trial']);

class PipelineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ── Grounding: join + verify one extraction against its paper ───
function verifyExtraction(ex, paper) {
  const source = `${paper.title} ${paper.abstract}`;
  const findings = (Array.isArray(ex.findings) ? ex.findings : []).map(f => {
    const quote = String(f?.quote || '');
    const grounded = quoteIsGrounded(quote, source);
    let effect = null, effectGrounded = false;
    const e = f?.effect;
    if (e && Number.isFinite(Number(e.point))) {
      effect = {
        measure: String(e.measure || 'other').toUpperCase(),
        point: Number(e.point),
        ciLow: e.ciLow == null || !Number.isFinite(Number(e.ciLow)) ? null : Number(e.ciLow),
        ciHigh: e.ciHigh == null || !Number.isFinite(Number(e.ciHigh)) ? null : Number(e.ciHigh),
      };
      const nums = [effect.point, effect.ciLow, effect.ciHigh].filter(v => v != null).map(String).join(' ');
      effectGrounded = numbersGrounded(nums, [paper.abstract]);
      if (!effectGrounded) effect = null; // never pool numbers we can't find in the source
    }
    return {
      outcomeId: String(f?.outcomeId || 'other'),
      direction: ['beneficial', 'harmful', 'null', 'mixed'].includes(f?.direction) ? f.direction : null,
      effect, effectGrounded, grounded,
      quote: quote.slice(0, 600),
      note: cleanText(f?.note || '').slice(0, 300),
    };
  }).filter(f => f.direction);

  // Design: trust curated PubMed publication types where present
  let design = DESIGNS.has(ex.design) ? ex.design : 'unknown';
  if (paper.designFrom === 'pubmed' && TRUSTED_API_DESIGNS.has(paper.design) &&
      !['animal', 'in_vitro', 'umbrella'].includes(design)) design = paper.design;

  const llmIndustry = ex.industryFunding === true;
  const funding = paper.fundingData || (llmIndustry ? summariseFunding(['industry (stated in abstract)']) : null);
  if (funding && llmIndustry) { funding.industrySponsored = true; funding.biasRisk = 'high'; }

  return {
    ref: paper.ref,
    design,
    humans: ex.humans === false || paper.humansMesh === false ? false : true,
    sampleSize: Number.isFinite(Number(ex.sampleSize)) && Number(ex.sampleSize) > 0 ? Math.round(Number(ex.sampleSize)) : null,
    year: paper.year,
    populationMatch: Number(ex.populationMatch ?? 0.5),
    interventionMatch: Number(ex.interventionMatch ?? 0.5),
    funding,
    fundingStatement: ex.fundingStatement ? String(ex.fundingStatement).slice(0, 300) : null,
    preprint: !!paper.preprint,
    findings,
  };
}

// ── Drop sentences that contain numbers not found in the evidence ─
function groundParagraphs(paragraphs, rows, summaries) {
  let dropped = 0;
  const out = paragraphs.map(p => {
    const cites = (Array.isArray(p.cites) ? p.cites : []).map(Number).filter(n => rows[n - 1]);
    // Numbers must exist somewhere in the evidence given to the model
    // (a mis-numbered citation is a lesser error than an invented number).
    const pool = [...summaries, ...rows.map(r => r.text)];
    // Split on sentence-final punctuation followed by whitespace, so
    // decimals like "87.5%" are not treated as sentence breaks.
    const sentences = String(p.text || '').split(/(?<=[.!?])\s+(?=[A-Z0-9"“(*])/).filter(Boolean);
    const kept = sentences.filter(s => {
      const ok = numbersGrounded(s, pool);
      if (!ok) dropped++;
      return ok;
    });
    return { text: kept.join(' ').replace(/\s+/g, ' ').trim(), cites };
  }).filter(p => p.text);
  return { paragraphs: out, dropped };
}

const STATE_TEXT = {
  insufficient: 'there is not enough evidence to say',
  consistent_benefit: 'the evidence consistently points to a benefit',
  consistent_harm: 'the evidence consistently points to harm',
  consistent_null: 'studies consistently find no clear effect',
  conflicting: 'well-designed studies disagree',
  inconclusive: 'the evidence does not point clearly in either direction',
};
function fallbackVerdict(scoring) {
  const o = scoring.outcomes.find(x => x.id === scoring.primaryOutcomeId) || scoring.outcomes[0];
  if (!o) return 'Not enough evidence was found to summarise.';
  return `For ${o.name}, ${STATE_TEXT[o.evidenceState]} (${o.studies} studies). Certainty in this evidence is ${o.certainty.toLowerCase()}.`;
}

function fundingSummary(extractions) {
  const total = extractions.length;
  const cat = { government: 0, industry: 0, foundation: 0, academic: 0, mixed: 0, unknown: 0 };
  const sources = [];
  for (const ex of extractions) {
    const f = ex.funding;
    if (!f || !f.categories?.length) { cat.unknown++; continue; }
    const known = f.categories.filter(c => c !== 'unknown');
    if (!known.length) cat.unknown++;
    else if (known.length > 1) cat.mixed++;
    else cat[known[0]]++;
    sources.push(...f.sources);
  }
  const pct = n => total ? Math.round(100 * n / total) : 0;
  const industryPct = pct(cat.industry);
  const unknownPct = pct(cat.unknown);
  const biasAlerts = [];
  if (industryPct > 50) biasAlerts.push(`Industry-funded: ${industryPct}% of studies`);
  if (cat.industry > 0 && cat.government + cat.foundation === 0) biasAlerts.push('No independently funded studies identified');
  return {
    totalStudies: total, categories: cat,
    fundingSources: [...new Set(sources)].slice(0, 30),
    biasRisk: industryPct > 50 ? 'high' : industryPct > 25 || unknownPct > 40 ? 'moderate' : 'low',
    biasAlerts, industryPct, governmentPct: pct(cat.government),
    independentPct: pct(cat.government + cat.foundation), unknownPct,
  };
}

// ═════════════════════════════════════════════════════════════════
async function runAnalysis(query, { deepMode = false } = {}, deps = {}) {
  const { client, http = fetch, store = null, log = () => {} } = deps;
  const t0 = Date.now();
  const sources = makeSources(http);
  const mediaApi = makeMedia(http);
  const warnings = [];

  // 1. Frame
  const frame = await llm.frameQuery(client, query);
  log(`frame: "${frame.plain}" outcomes=${frame.outcomes.map(o => o.name).join(' | ')}`);

  // 2. Retrieve (+ media in parallel)
  const yearsBack = deepMode ? 20 : 15;
  const yearFrom = new Date().getFullYear() - yearsBack;
  const L = deepMode ? { s2: 40, pm: 40, oa: 25, epmc: 30 } : { s2: 25, pm: 24, oa: 15, epmc: 20 };
  const st = frame.searchTerms;
  const named = [
    ['Semantic Scholar', sources.semanticScholar(st.semantic || query, { limit: L.s2, yearFrom }), st.semantic || query],
    ['PubMed', sources.pubmed(st.pubmed || query, { limit: L.pm, yearFrom }), st.pubmed || query],
    ['OpenAlex', sources.openAlex(st.openAlex || query, { limit: L.oa, yearFrom }), st.openAlex || query],
    ['Europe PMC', sources.europePmc(st.pubmed || query, { limit: L.epmc, yearFrom }), st.pubmed || query],
  ];
  const mediaP = mediaApi.fetchMedia(client, frame, { deepMode }).catch(e => {
    warnings.push(`News search failed: ${e.message}`);
    return { articles: [], summary: null, failures: 1 };
  });
  const settled = await Promise.allSettled(named.map(n => n[1]));
  const sourceReport = named.map(([name, , q], i) => ({
    name, query: q,
    status: settled[i].status === 'fulfilled' ? 'ok' : 'error',
    count: settled[i].status === 'fulfilled' ? settled[i].value.length : 0,
    error: settled[i].status === 'rejected' ? String(settled[i].reason?.message || settled[i].reason).slice(0, 120) : undefined,
  }));
  sourceReport.filter(s => s.status === 'error').forEach(s => warnings.push(`${s.name} search failed (${s.error})`));
  const rawAll = settled.flatMap(s => s.status === 'fulfilled' ? s.value : []);
  if (!rawAll.length) throw new PipelineError(502, 'No papers returned from any database. All literature searches failed or came back empty.');

  // 3. Merge-dedupe, exclude retractions
  const merged = mergeDedupe(rawAll);
  const retracted = merged.filter(p => p.retracted);
  const live = merged.filter(p => !p.retracted);

  // 4. Deterministic entity gate
  let gateTerms = [...frame.requiredTerms, ...frame.synonyms];
  if (!gateTerms.length) gateTerms = String(frame.intervention || '').split(/\s+/).filter(w => w.length > 3);
  const gate = buildMatcher(gateTerms);
  const gated = live.filter(p => gate.test(`${p.title} ${p.abstract}`));
  if (gated.length < 3) {
    throw new PipelineError(404, `Only ${gated.length} paper(s) mentioning ${gate.terms.slice(0, 3).join(' / ') || 'the topic'} were found. The topic may be too niche or use different terminology — try rephrasing, e.g. "${frame.intervention}".`);
  }

  // 5. Select
  const maxPapers = deepMode ? 60 : 30;
  const selected = [...gated].sort((a, b) => selectionScore(b) - selectionScore(a)).slice(0, maxPapers);

  // 6. Relevance screen
  const screen = await llm.screenRelevance(client, selected, frame);
  if (screen.failures) warnings.push(`Relevance screening failed for ${screen.failures} batch(es); those papers were kept unscreened.`);
  const papers = screen.papers.map((p, i) => ({ ...p, ref: paperRef(p, i) }));
  if (papers.length < 3) throw new PipelineError(404, `Only ${papers.length} relevant paper(s) remained after screening.`);
  const byRef = new Map(papers.map(p => [p.ref, p]));

  // 7. Extract (with per-paper cache for run-to-run stability)
  const outcomeSig = frame.outcomes.map(o => `${o.id}:${o.name}:${o.higherIsBetter}`).join('|');
  const cacheKey = ref => crypto.createHash('sha256').update(`${llm.PROMPT_VERSION}|${llm.MODEL_REASONING}|${frame.intervention}|${outcomeSig}|${ref}`).digest('hex');
  const extractions = new Map();
  if (store) {
    const hits = await store.getExtractions(papers.map(p => cacheKey(p.ref))).catch(() => new Map());
    for (const p of papers) { const h = hits.get(cacheKey(p.ref)); if (h) extractions.set(p.ref, h); }
  }
  const todo = papers.filter(p => !extractions.has(p.ref));
  const BATCH = 6;
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH).map(p => ({ p, ref: p.ref })));
  let extractionFailures = 0;
  await mapLimit(batches, 5, async batch => {
    try {
      const out = await llm.extractBatch(client, batch, frame);
      for (const ex of out) if (ex && byRef.has(String(ex.ref))) extractions.set(String(ex.ref), ex);
    } catch (e) {
      extractionFailures += batch.length;
      log(`extraction batch failed: ${e.message}`);
    }
  });
  if (store) {
    const fresh = todo.filter(p => extractions.has(p.ref)).map(p => [cacheKey(p.ref), extractions.get(p.ref)]);
    store.putExtractions(fresh).catch(() => {});
  }
  const missing = papers.filter(p => !extractions.has(p.ref)).length;
  if (missing) warnings.push(`${missing} of ${papers.length} papers could not be extracted and are not counted in the score.`);

  // 8. Verify
  const verified = papers.filter(p => extractions.has(p.ref)).map(p => verifyExtraction(extractions.get(p.ref), p));
  const allFindings = verified.flatMap(v => v.findings);
  const ungrounded = allFindings.filter(f => !f.grounded).length;

  // 9. Score
  const scoring = computeConsensus(verified, frame.outcomes);
  log(`score: ${scoring.evidenceState} ${scoring.rightPct}% certainty=${scoring.certainty}`);

  // 10–11. Narrate + media
  const [synth, verdictRaw, media] = await Promise.all([
    llm.synthesize(client, frame, scoring, byRef).catch(e => { warnings.push('Synthesis text unavailable.'); log(e.message); return null; }),
    llm.generateVerdict(client, frame, scoring).catch(() => ''),
    mediaP,
  ]);
  let synthesis = { paragraphs: [], droppedSentences: 0, rows: [] };
  if (synth) {
    const g = groundParagraphs(synth.paragraphs, synth.rows, synth.summaries);
    synthesis = { paragraphs: g.paragraphs, droppedSentences: g.dropped, rows: synth.rows.map(r => ({ n: r.n, ref: r.ref })) };
  }
  const verdict = verdictRaw && numbersGrounded(verdictRaw, scoring.outcomes.map(o => JSON.stringify(o)))
    ? verdictRaw : fallbackVerdict(scoring);

  // Divergence — only with real facts
  let divergenceAnalysis = null;
  const mediaSummary = media.summary;
  if (mediaSummary && scoring.evidenceState !== 'insufficient' && media.articles.length >= 3) {
    const divAmt = Math.abs(mediaSummary.rightPct - scoring.rightPct);
    if (divAmt >= 10) {
      const industry = verified.filter(v => v.funding?.industrySponsored).length;
      const high = verified.filter(v => ['meta', 'umbrella', 'rct'].includes(v.design)).length;
      const avgOutlet = media.articles.reduce((s, a) => s + a.weight, 0) / media.articles.length;
      const facts = [
        `Science (primary outcome): ${scoring.rightPct}% toward beneficial on a harmful←null→beneficial scale; state ${scoring.evidenceState}; certainty ${scoring.certainty}.`,
        `Headlines: ${mediaSummary.rightPct}% toward beneficial on the same scale (${mediaSummary.framed} of ${mediaSummary.total} headlines take a position).`,
        `Divergence: ${divAmt} points; media is ${mediaSummary.rightPct > scoring.rightPct ? 'more optimistic' : 'more alarming'}.`,
        `Study designs: ${high} of ${verified.length} are RCTs or meta-analyses.`,
        `Industry funding identified (grant metadata or abstract statements): ${industry} of ${verified.length} studies.`,
        `Average outlet credibility weight: ${avgOutlet.toFixed(1)} / 4.`,
      ];
      try {
        const d = await llm.explainDivergence(client, frame, facts, media.articles.slice(0, 12).map(a => a.title));
        divergenceAnalysis = {
          category: d.category || 'unknown', confidence: d.confidence || 'low',
          headline: d.headline || 'Coverage diverges from the evidence', explanation: d.explanation || '',
          caveat: d.caveat || '', signals: facts, divAmt,
          divDir: mediaSummary.rightPct > scoring.rightPct ? 'right' : 'left',
        };
      } catch (e) { log(`divergence failed: ${e.message}`); }
    }
  }

  // ── Assemble the response ─────────────────────────────────────
  const exByRef = new Map(verified.map(v => [v.ref, v]));
  const outName = new Map(frame.outcomes.map(o => [o.id, o.name]));
  const paperOut = papers.map(p => {
    const v = exByRef.get(p.ref);
    const pos = scoring.positions[p.ref];
    return {
      ref: p.ref, title: p.title, abstract: p.abstract, year: p.year, journal: p.journal,
      doi: p.doi, pmid: p.pmid, citations: p.citations, sources: p.sources,
      design: v?.design || p.design, sampleSize: v?.sampleSize ?? null,
      preprint: !!p.preprint, humans: v ? v.humans : null,
      relevanceUnchecked: !!p.relevanceUnchecked,
      funding: v?.funding || p.fundingData || null, fundingStatement: v?.fundingStatement || null,
      findings: (v?.findings || []).map(f => ({ ...f, outcomeName: outName.get(f.outcomeId) || 'Other outcome' })),
      extracted: !!v,
      position: pos ? pos.x : null,
      direction: pos ? pos.direction : null,
      weight: pos ? pos.weight : 0,
    };
  });

  const mediaArticles = (media.articles || []).map(a => ({
    title: a.title, outlet: a.outlet, url: /^https?:\/\//.test(a.url) ? a.url : '', year: a.year,
    weight: a.weight, stance: a.stance, framing: a.framing,
  }));

  const primary = scoring.outcomes.find(o => o.id === scoring.primaryOutcomeId);
  return {
    queryMeta: {
      plain: frame.plain, population: frame.population, intervention: frame.intervention, comparator: frame.comparator,
      leftSide: frame.leftClaim, leftDesc: frame.leftDesc, rightSide: frame.rightClaim, rightDesc: frame.rightDesc,
      axisLeftLabel: frame.axisLeftLabel || 'Harmful', axisRightLabel: frame.axisRightLabel || 'Beneficial',
      isDebatable: frame.isDebatable, domain: frame.domain, outcomes: frame.outcomes,
    },
    papers: paperOut,
    fundingAnalysis: fundingSummary(verified),
    analysis: {
      verdict,
      synthesis,
      outcomes: scoring.outcomes,
      primaryOutcomeId: scoring.primaryOutcomeId,
      debate: {
        leftLabel: frame.leftClaim, leftDesc: frame.leftDesc, rightLabel: frame.rightClaim, rightDesc: frame.rightDesc,
        axisLeftLabel: frame.axisLeftLabel || 'Harmful', axisRightLabel: frame.axisRightLabel || 'Beneficial',
        leftPct: scoring.leftPct, rightPct: scoring.rightPct,
        isDebated: frame.isDebatable,
        evidenceState: scoring.evidenceState,
        certainty: scoring.certainty, certaintyReasons: primary?.certaintyReasons || [],
        directionalConf: scoring.directionalConf, designQuality: scoring.designQuality,
        contradiction: scoring.contradiction, score: scoring.score,
        primaryOutcome: primary?.name || null,
      },
    },
    media: mediaArticles,
    mediaAnalysis: mediaSummary
      ? { ...mediaSummary, divergence: Math.abs(mediaSummary.rightPct - scoring.rightPct) }
      : { leftPct: null, rightPct: null, divergence: null, noRelevantMedia: true },
    divergenceAnalysis,
    meta: {
      algorithm: ALGORITHM_VERSION, promptVersion: llm.PROMPT_VERSION,
      models: { reasoning: llm.MODEL_REASONING, classifier: llm.MODEL_CLASSIFIER },
      searchedAt: new Date().toISOString(),
      yearFrom, deepMode: !!deepMode,
      sources: sourceReport,
      flow: {
        retrieved: rawAll.length, unique: merged.length, retractedExcluded: retracted.length,
        passedEntityGate: gated.length, selected: selected.length, passedScreening: papers.length,
        extracted: verified.length, scored: scoring.evidenceCount,
        nonHumanExcluded: scoring.excluded.nonHuman.length, lowRelevanceExcluded: scoring.excluded.irrelevant.length,
      },
      retractedTitles: retracted.slice(0, 10).map(p => p.title),
      gateTerms: gate.terms,
      extractionFailures, ungroundedFindings: ungrounded, totalFindings: allFindings.length,
      synthesisSentencesDropped: synthesis.droppedSentences,
      warnings,
      paperCount: papers.length,
      certainty: scoring.certainty, score: scoring.score,
      durationMs: Date.now() - t0,
      fromCache: false,
    },
    _scoring: { certainty: scoring.certainty, score: scoring.score },
  };
}

module.exports = { runAnalysis, verifyExtraction, groundParagraphs, fundingSummary, fallbackVerdict, PipelineError };
