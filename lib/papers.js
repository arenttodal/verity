// ─────────────────────────────────────────────────────────────────
//  Paper records: parsing, design labelling, merge-dedupe, ranking.
//
//  Every source is normalised to the same shape:
//    { title, abstract, year|null, journal, doi|null, pmid|null,
//      openalexId|null, citations, design, designFrom, pubTypes[],
//      retracted, preprint, sources[], rank, fundingData|null }
// ─────────────────────────────────────────────────────────────────
const { cleanText, norm } = require('./text');

function normDoi(doi) {
  if (!doi) return null;
  const d = String(doi).trim().toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
  return d.startsWith('10.') ? d : null;
}

function normTitleKey(title) {
  return norm(title).replace(/[^a-z0-9]/g, '').slice(0, 100);
}

const PREPRINT_VENUES = /\b(medrxiv|biorxiv|arxiv|ssrn|research square|preprints?\.org|psyarxiv|osf preprints)\b/i;

// ── Design from curated metadata ────────────────────────────────
// Only labels we can trust go here. "Review" is NOT a meta-analysis,
// and "Clinical Trial" is NOT necessarily randomised.
function designFromPubMedTypes(types) {
  const t = types.map(x => x.toLowerCase());
  const has = re => t.some(x => re.test(x));
  if (has(/^meta-analysis$/) || has(/^systematic review$/)) return 'meta';
  if (has(/^randomized controlled trial$/) || has(/^pragmatic clinical trial$/) || has(/^equivalence trial$/)) return 'rct';
  if (has(/^case reports$/)) return 'case_report';
  if (has(/^observational study$/)) return 'obs';
  if (has(/^controlled clinical trial$/) || has(/^clinical trial/)) return 'nonrandomized_trial';
  if (has(/^review$/)) return 'narrative_review';
  return 'unknown';
}

function designFromS2Types(types) {
  const t = types || [];
  if (t.includes('Meta-Analysis') || t.includes('SystematicReview')) return 'meta';
  if (t.includes('CaseReport')) return 'case_report';
  if (t.includes('Review')) return 'narrative_review';
  // S2 'ClinicalTrial' does not distinguish randomised from not
  if (t.includes('ClinicalTrial')) return 'unknown';
  return 'unknown';
}

// ── PubMed XML ──────────────────────────────────────────────────
function parsePubMedXML(xml) {
  const papers = [];
  for (const m of xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)) {
    const a = m[1];
    const titleM = a.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/);
    const title = titleM ? cleanText(titleM[1]).replace(/\.$/, '') : '';
    if (!title) continue;

    // Keep section labels (RESULTS: …) — they tell the extractor
    // where the effect sizes are.
    const sections = [...a.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(x => {
      const label = (x[1].match(/Label="([^"]+)"/) || [])[1];
      const body = cleanText(x[2]);
      return label ? `${label.toUpperCase()}: ${body}` : body;
    });
    const abstract = sections.join(' ').trim();
    if (abstract.length < 80) continue;

    const articleBlock = (a.match(/<Article[ >][\s\S]*?<\/Article>/) || [a])[0];
    const yearM = articleBlock.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/) ||
                  articleBlock.match(/<PubDate>[\s\S]*?<MedlineDate>(\d{4})/) ||
                  articleBlock.match(/<ArticleDate[^>]*>[\s\S]*?<Year>(\d{4})<\/Year>/);
    const jM = a.match(/<ISOAbbreviation>([\s\S]*?)<\/ISOAbbreviation>/) ||
               a.match(/<Title>([\s\S]*?)<\/Title>/);
    // Prefer the article's own ELocationID DOI; the ArticleIdList DOI
    // regex can otherwise hit a reference-list entry.
    const doiM = articleBlock.match(/<ELocationID[^>]*EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/) ||
                 (a.match(/<PubmedData>[\s\S]*?<ArticleIdList>([\s\S]*?)<\/ArticleIdList>/) || ['', ''])[1]
                   .match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/);
    const pmidM = a.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pubTypes = [...a.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)]
      .map(x => cleanText(x[1]));
    const retracted = pubTypes.some(t => /^retracted publication$|^retraction of publication$/i.test(t)) ||
                      /RefType="RetractionIn"/.test(a);
    const humans = /<MeshHeading>[\s\S]*?>Humans<\/DescriptorName>/.test(a) ? true :
                   /<MeshHeading>[\s\S]*?>Animals<\/DescriptorName>/.test(a) ? false : null;

    papers.push({
      title, abstract,
      year: yearM ? parseInt(yearM[1], 10) : null,
      journal: jM ? cleanText(jM[1]) : 'Unknown',
      doi: normDoi(doiM ? cleanText(doiM[1]) : null),
      pmid: pmidM ? pmidM[1] : null,
      openalexId: null,
      citations: 0,
      design: designFromPubMedTypes(pubTypes),
      designFrom: 'pubmed',
      pubTypes,
      retracted,
      humansMesh: humans,
      preprint: false,
      sources: ['pubmed'],
      fundingData: extractPubMedFunding(a),
    });
  }
  return papers;
}

// ── Funding classification (shared by PubMed / OpenAlex / Crossref) ──
function classifyFunder(name) {
  const n = ` ${String(name || '').toLowerCase()} `;
  if (/\b(nih|nsf|cdc|nhmrc|cihr|nihr|mrc|esrc|dfg|anr|nsfc|va|ukri|european (commission|research council)|horizon 2020)\b|national institute|national science|government|ministry|department of health|research council/.test(n)) return 'government';
  if (/\b(pfizer|novartis|merck|roche|gsk|glaxo|sanofi|abbvie|astrazeneca|bayer|lilly|amgen|johnson & johnson|janssen|boehringer|takeda|novo nordisk|nestl[eé]|danone|pepsico|coca-cola|monsanto)\b|pharmaceut|biotech|\binc\b|\bcorp\b|\bltd\b|\bllc\b|\bgmbh\b|\bs\.a\.|company|industries/.test(n)) return 'industry';
  if (/foundation|trust|charity|wellcome|gates|society|association|fund\b/.test(n)) return 'foundation';
  if (/universit|college|hospital|medical center|institute|school of/.test(n)) return 'academic';
  return 'unknown';
}

function summariseFunding(sources) {
  const uniq = [...new Set(sources.filter(Boolean))];
  if (!uniq.length) return null;
  const categories = uniq.map(classifyFunder);
  const industry = categories.filter(c => c === 'industry').length;
  const known = categories.filter(c => c !== 'unknown').length;
  return {
    sources: uniq,
    categories: [...new Set(categories)],
    industrySponsored: industry > 0,
    biasRisk: !known ? 'unknown' : industry / known > 0.5 ? 'high' : industry > 0 ? 'moderate' : 'low',
  };
}

function extractPubMedFunding(xml) {
  const agencies = [...xml.matchAll(/<Grant>[\s\S]*?<Agency>([\s\S]*?)<\/Agency>/g)].map(m => cleanText(m[1]));
  return summariseFunding(agencies);
}

// ── Merge-dedupe ────────────────────────────────────────────────
// The old dedupe kept whichever copy arrived first, which threw away
// PubMed's publication types and grant data whenever Semantic Scholar
// also returned the paper. Here records are merged field by field:
//   design / pubTypes / retraction / funding → PubMed wins
//   citations → max across sources
//   abstract → longest
const DESIGN_TRUST = { pubmed: 3, europepmc: 2, s2: 2, openalex: 1 };

function mergeRecords(a, b) {
  const out = { ...a };
  out.sources = [...new Set([...a.sources, ...b.sources])];
  out.doi = a.doi || b.doi;
  out.pmid = a.pmid || b.pmid;
  out.openalexId = a.openalexId || b.openalexId;
  out.year = a.year || b.year;
  if ((b.abstract || '').length > (a.abstract || '').length) out.abstract = b.abstract;
  if ((!a.journal || a.journal === 'Unknown') && b.journal) out.journal = b.journal;
  out.citations = Math.max(a.citations || 0, b.citations || 0);
  const ta = DESIGN_TRUST[a.designFrom] || 0, tb = DESIGN_TRUST[b.designFrom] || 0;
  if ((b.design !== 'unknown' && tb > ta) || a.design === 'unknown') {
    if (b.design !== 'unknown') { out.design = b.design; out.designFrom = b.designFrom; }
  }
  out.pubTypes = [...new Set([...(a.pubTypes || []), ...(b.pubTypes || [])])];
  out.retracted = !!(a.retracted || b.retracted);
  out.preprint = !!(a.preprint || b.preprint);
  out.humansMesh = a.humansMesh ?? b.humansMesh ?? null;
  if (!a.fundingData && b.fundingData) out.fundingData = b.fundingData;
  else if (a.fundingData && b.fundingData) {
    out.fundingData = summariseFunding([...a.fundingData.sources, ...b.fundingData.sources]);
  }
  out.rank = Math.min(a.rank ?? 1, b.rank ?? 1);
  return out;
}

function mergeDedupe(papers) {
  const out = [];
  const byKey = new Map();
  for (const p of papers) {
    const keys = [p.doi && `doi:${p.doi}`, p.pmid && `pmid:${p.pmid}`, `t:${normTitleKey(p.title)}`].filter(Boolean);
    const hit = keys.map(k => byKey.get(k)).find(i => i !== undefined);
    if (hit === undefined) {
      const idx = out.push(p) - 1;
      keys.forEach(k => byKey.set(k, idx));
    } else {
      out[hit] = mergeRecords(out[hit], p);
      [out[hit].doi && `doi:${out[hit].doi}`, out[hit].pmid && `pmid:${out[hit].pmid}`, ...keys]
        .filter(Boolean).forEach(k => byKey.set(k, hit));
    }
  }
  return out;
}

// Stable reference used to join extractions back to papers.
function paperRef(p, i) {
  return p.doi ? `doi:${p.doi}` : p.pmid ? `pmid:${p.pmid}` : p.openalexId ? `oa:${p.openalexId.split('/').pop()}` : `paper-${i + 1}`;
}

// ── Pre-extraction ranking ──────────────────────────────────────
// Citation count is deliberately only a tie-breaker: ranking by it
// imports citation bias (positive/surprising results are cited more).
const DESIGN_RANK = {
  umbrella: 4, meta: 4, rct: 3, cohort: 2, case_control: 1.5, nonrandomized_trial: 1.5,
  obs: 1.2, unknown: 1.2, cross_sectional: 1, narrative_review: 0.6, case_report: 0.3,
  animal: 0.2, in_vitro: 0.2,
};
function selectionScore(p) {
  return (DESIGN_RANK[p.design] ?? 1) + 1.5 * (1 - (p.rank ?? 1)) + 0.02 * Math.log10(1 + (p.citations || 0));
}

module.exports = {
  normDoi, normTitleKey, PREPRINT_VENUES,
  designFromPubMedTypes, designFromS2Types, parsePubMedXML,
  classifyFunder, summariseFunding, extractPubMedFunding,
  mergeRecords, mergeDedupe, paperRef, selectionScore,
};
