// ═════════════════════════════════════════════════════════════════
//  Verity scoring engine — v9 (per-outcome evidence synthesis)
//
//  Replaces the v8 single-scalar vote count. Key changes, each tied to
//  a finding in REVIEW-2026-10.md:
//
//   §1.1  Null results are real evidence. An informative null (large
//         or meta-analytic) sits at the centre of the axis and pulls
//         the position toward "no effect" in proportion to its weight.
//   §1.2  One axis with one meaning: effect of the intervention on
//         people — harmful ← null → beneficial — independent of how
//         the question was phrased.
//   §1.3  Each prespecified outcome is scored separately (benefits and
//         harms are not averaged together), with one row per study
//         per outcome so multi-outcome papers don't get extra votes.
//   AUDIT §1.1  Magnitude no longer cancels: where ≥3 studies report a
//         ratio or SMD with a CI, a random-effects (HKSJ) pool is
//         computed and drives the evidence state.
//   AUDIT §1.3  "Insufficient", "no effect" and "conflicting" are
//         distinct evidence states instead of all rendering as 50%.
//   AUDIT §1.5  Design enters the weight once.
//   AUDIT §1.6  Contradiction index is 4LR/(L+R)², range [0, 1].
//   AUDIT §1.7  Certainty is GRADE-style and counts studies, not outcomes.
//   AUDIT §2.1  Funding risk-of-bias is actually wired in.
//
//  Everything in this file is deterministic and pure.
// ═════════════════════════════════════════════════════════════════
const { jeffreysInterval, kishNeff, randomEffectsHK, seFromRatioCI, seFromDiffCI } = require('./stats');

const ALGORITHM_VERSION = 'v9-per-outcome';

const DESIGN_PRIOR = {
  umbrella: 1.0, meta: 0.95, rct: 0.85,
  cohort: 0.60, nonrandomized_trial: 0.55, case_control: 0.45,
  obs: 0.40, unknown: 0.35, cross_sectional: 0.30,
  narrative_review: 0.15, case_report: 0.10,
};
const HIGH_DESIGNS = new Set(['umbrella', 'meta', 'rct']);
const NON_HUMAN = new Set(['animal', 'in_vitro']);
const DIRECTIONS = new Set(['beneficial', 'harmful', 'null', 'mixed']);
const RATIO_MEASURES = new Set(['RR', 'OR', 'HR', 'IRR', 'RATIO']);

// Sample size → precision weight. log-scaled: n=10→0.25, 100→0.5,
// 1,000→0.75, 10,000→1. Unknown n gets a modest weight and a flag.
function precisionWeight(n) {
  if (!(n > 0)) return 0.4;
  return Math.max(0.15, Math.min(1, Math.log10(n) / 4));
}

function relevanceWeight(ex) {
  const pop = clamp01(ex.populationMatch ?? 0.5);
  const int = clamp01(ex.interventionMatch ?? 0.5);
  return pop * 0.4 + int * 0.6;
}

// Risk-of-bias multiplier (a downgrade, not a design proxy)
function biasMultiplier(ex, finding) {
  let m = 1;
  const flags = [];
  if (ex.funding?.biasRisk === 'high') { m *= 0.8; flags.push('industry-funded'); }
  if (ex.preprint) { m *= 0.8; flags.push('preprint'); }
  if (finding.grounded === false) { m *= 0.6; flags.push('finding not quoted verbatim'); }
  if (!(ex.sampleSize > 0)) flags.push('sample size not reported');
  return { m, flags };
}

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }

// Deterministic small spread so dots don't stack — no Math.random().
function hashJitter(str, amp) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967295 - 0.5) * 2 * amp;
}

// ── Pool numeric effects, if enough are available ───────────────
function poolEffects(rows, outcome) {
  const ratio = [], smd = [];
  for (const r of rows) {
    const e = r.effect;
    if (!e || r.effectGrounded === false) continue;
    const measure = String(e.measure || '').toUpperCase();
    if (RATIO_MEASURES.has(measure)) {
      const se = seFromRatioCI(e.ciLow, e.ciHigh);
      if (se && e.point > 0) ratio.push({ y: Math.log(e.point), se, ref: r.ref });
    } else if (measure === 'SMD') {
      const se = seFromDiffCI(e.ciLow, e.ciHigh);
      if (se && Number.isFinite(e.point)) smd.push({ y: e.point, se, ref: r.ref });
    }
  }
  const pick = ratio.length >= smd.length ? { kind: 'ratio', s: ratio } : { kind: 'SMD', s: smd };
  if (pick.s.length < 3) return null;
  const re = randomEffectsHK(pick.s);
  if (!re) return null;

  const isRatio = pick.kind === 'ratio';
  const back = v => isRatio ? Math.exp(v) : v;
  const nullV = 0; // log(1) or SMD 0
  // Which side of null is "better" for this outcome?
  // higherIsBetter: an effect above null helps people.
  const better = outcome.higherIsBetter !== false ? 1 : -1;
  const sig = re.ci[0] > nullV || re.ci[1] < nullV;
  const favours = !sig ? 'null' : (Math.sign(re.mu) === better ? 'beneficial' : 'harmful');
  // "Precise null": CI sits inside a modest equivalence band
  // (ratio 0.8–1.25, SMD ±0.2 — conventional small-effect thresholds).
  const band = isRatio ? Math.log(1.25) : 0.2;
  const preciseNull = !sig && re.ci[0] > -band && re.ci[1] < band;

  return {
    measure: isRatio ? 'ratio (RR/OR/HR)' : 'SMD',
    k: re.k,
    estimate: round(back(re.mu), 3),
    ci: [round(back(re.ci[0]), 3), round(back(re.ci[1]), 3)],
    pi: re.pi ? [round(back(re.pi[0]), 3), round(back(re.pi[1]), 3)] : null,
    I2: round(re.I2, 3),
    tau2: round(re.tau2, 4),
    significant: sig,
    favours,
    preciseNull,
    method: 'Random effects (DerSimonian–Laird τ², Hartung–Knapp CI)',
    refs: pick.s.map(s => s.ref),
  };
}

function round(x, d) { const f = 10 ** d; return Math.round(x * f) / f; }

const CERTAINTY_LABELS = ['Very low', 'Very low', 'Low', 'Moderate', 'High'];

// ── Score one outcome ───────────────────────────────────────────
function scoreOutcome(outcome, rows) {
  const k = rows.length;
  const W = { beneficial: 0, harmful: 0, nullInf: 0, nullUn: 0, mixed: 0 };
  let highW = 0, totalW = 0, biasW = 0, relSum = 0, knownN = 0;
  const highBen = rows.some(r => r.direction === 'beneficial' && HIGH_DESIGNS.has(r.design));
  const highHarm = rows.some(r => r.direction === 'harmful' && HIGH_DESIGNS.has(r.design));

  for (const r of rows) {
    totalW += r.weight;
    if (HIGH_DESIGNS.has(r.design)) highW += r.weight;
    if (r.biasFlags.some(f => f !== 'sample size not reported')) biasW += r.weight;
    relSum += r.R * r.weight;
    if (r.sampleSize > 0) knownN += r.sampleSize;
    if (r.direction === 'beneficial') W.beneficial += r.weight;
    else if (r.direction === 'harmful') W.harmful += r.weight;
    else if (r.direction === 'mixed') W.mixed += r.weight;
    else if (r.informativeNull) W.nullInf += r.weight;
    else W.nullUn += r.weight;
  }

  const dirW = W.beneficial + W.harmful;
  const denom = dirW + W.nullInf + 0.5 * W.nullUn + 0.5 * W.mixed;
  const score = denom > 0 ? Math.round(100 * (W.beneficial - W.harmful) / denom) : 0;
  const contradiction = dirW > 0 ? round(4 * W.beneficial * W.harmful / (dirW * dirW), 3) : 0;

  const dirRows = rows.filter(r => r.direction === 'beneficial' || r.direction === 'harmful');
  const interval = jeffreysInterval(W.beneficial, dirW, kishNeff(dirRows.map(r => r.weight)));
  const pooled = poolEffects(rows, outcome);

  // ── Evidence state ─────────────────────────────────────────────
  let state;
  if (k < 3 || totalW < 0.5) state = 'insufficient';
  else if (pooled && pooled.significant) state = pooled.favours === 'beneficial' ? 'consistent_benefit' : 'consistent_harm';
  else if (pooled && pooled.preciseNull) state = 'consistent_null';
  else if (contradiction >= 0.6 && highBen && highHarm) state = 'conflicting';
  else if (W.nullInf >= dirW && W.nullInf >= 0.4 * totalW) state = 'consistent_null';
  else if (interval.lo > 0.5 && W.beneficial >= 0.5 * totalW) state = 'consistent_benefit';
  else if (interval.hi < 0.5 && W.harmful >= 0.5 * totalW) state = 'consistent_harm';
  else if (contradiction >= 0.6) state = 'conflicting';
  else state = 'inconclusive';

  // ── Certainty (GRADE-style) ────────────────────────────────────
  const reasons = [];
  let level = highW >= 0.5 * totalW ? 4 : 2;
  reasons.push(level === 4 ? 'mostly randomised trials / meta-analyses' : 'mostly observational or unclassified designs');
  if (contradiction >= 0.5 || (pooled && pooled.I2 >= 0.75)) { level--; reasons.push('inconsistency between studies'); }
  const nullVal = pooled?.measure === 'SMD' ? 0 : 1;
  const piSpansNull = !!(pooled?.pi && !pooled.preciseNull && pooled.pi[0] < nullVal && pooled.pi[1] > nullVal);
  if (k < 5 || (knownN > 0 && knownN < 400) || piSpansNull) {
    level--; reasons.push('imprecision (few studies, small samples, or a prediction interval spanning no effect)');
  }
  if (totalW > 0 && biasW / totalW >= 0.5) { level--; reasons.push('risk of bias (funding, preprints or unverified extractions)'); }
  if (totalW > 0 && relSum / totalW < 0.6) { level--; reasons.push('indirectness (populations or interventions differ from the question)'); }
  const certainty = state === 'insufficient' ? 'Very low' : CERTAINTY_LABELS[Math.max(0, level)];

  // ── Directional confidence ─────────────────────────────────────
  const directionalConf =
    state === 'insufficient'      ? 'Insufficient' :
    state === 'consistent_null'   ? 'No clear effect' :
    state === 'conflicting'       ? 'Mixed' :
    (interval.lo > 0.75 || interval.hi < 0.25) && dirRows.length >= 5 ? 'Strong' :
    (interval.lo > 0.5 || interval.hi < 0.5) ? 'Moderate' :
    contradiction >= 0.5 ? 'Mixed' : 'Inconclusive';

  const highDesignShare = totalW > 0 ? highW / totalW : 0;
  return {
    id: outcome.id,
    name: outcome.name,
    type: outcome.type || 'benefit',
    critical: !!outcome.critical,
    studies: k,
    participants: knownN || null,
    counts: {
      beneficial: rows.filter(r => r.direction === 'beneficial').length,
      harmful: rows.filter(r => r.direction === 'harmful').length,
      null: rows.filter(r => r.direction === 'null').length,
      mixed: rows.filter(r => r.direction === 'mixed').length,
    },
    score,
    rightPct: Math.round((score + 100) / 2),
    directionalShare: interval.p == null ? null : {
      beneficial: round(interval.p, 3), lo: round(interval.lo, 3), hi: round(interval.hi, 3),
      method: 'Jeffreys interval on weighted beneficial share of directional findings (Kish effective n)',
    },
    contradiction,
    pooled,
    evidenceState: state,
    certainty,
    certaintyReasons: reasons,
    directionalConf,
    designQuality: highDesignShare >= 0.5 ? 'RCT/meta-dominant' : highDesignShare >= 0.2 ? 'mixed designs' : 'mostly observational',
  };
}

// ═════════════════════════════════════════════════════════════════
//  Main entry point
//
//  extractions: [{
//    ref, design, humans, sampleSize, year, populationMatch,
//    interventionMatch, funding, preprint,
//    findings: [{ outcomeId, direction, effect, grounded,
//                 effectGrounded, quote, note }]
//  }]
//  outcomes: [{ id, name, type, higherIsBetter, critical }]
// ═════════════════════════════════════════════════════════════════
function computeConsensus(extractions, outcomes) {
  const outcomeById = new Map((outcomes || []).map(o => [o.id, o]));
  const excluded = { nonHuman: [], irrelevant: [], unlinkedFindings: 0 };

  // Meta-analyses per outcome, for overlap control below
  const metaYears = new Map();
  for (const ex of extractions) {
    if (!['meta', 'umbrella'].includes(ex.design)) continue;
    for (const f of ex.findings || []) {
      if (!outcomeById.has(f.outcomeId)) continue;
      metaYears.set(f.outcomeId, Math.max(metaYears.get(f.outcomeId) || 0, ex.year || 0));
    }
  }

  const rowsByOutcome = new Map([...outcomeById.keys()].map(id => [id, []]));
  for (const ex of extractions) {
    if (NON_HUMAN.has(ex.design) || ex.humans === false) { excluded.nonHuman.push(ex.ref); continue; }
    const R = relevanceWeight(ex);
    if (R < 0.3) { excluded.irrelevant.push(ex.ref); continue; }

    const seen = new Set();
    for (const f of ex.findings || []) {
      if (!outcomeById.has(f.outcomeId)) { excluded.unlinkedFindings++; continue; }
      if (!DIRECTIONS.has(f.direction)) continue;
      if (seen.has(f.outcomeId)) continue; // one row per study per outcome
      seen.add(f.outcomeId);

      const D = DESIGN_PRIOR[ex.design] ?? DESIGN_PRIOR.unknown;
      const P = precisionWeight(ex.sampleSize);
      const { m: B, flags } = biasMultiplier(ex, f);
      // Overlap control: a primary study published no later than a
      // meta-analysis on the same outcome is probably already pooled
      // inside it. Halve it rather than count it twice.
      const myMeta = metaYears.get(f.outcomeId);
      const overlap = !['meta', 'umbrella'].includes(ex.design) && myMeta && ex.year && ex.year <= myMeta;
      const O = overlap ? 0.5 : 1;
      const weight = D * P * R * B * O;
      if (overlap) flags.push('likely included in a meta-analysis here (weight halved)');

      rowsByOutcome.get(f.outcomeId).push({
        ref: ex.ref, design: ex.design, outcomeId: f.outcomeId,
        direction: f.direction, effect: f.effect || null,
        grounded: f.grounded, effectGrounded: f.effectGrounded,
        informativeNull: f.direction === 'null' && (['meta', 'umbrella'].includes(ex.design) || ex.sampleSize >= 300),
        sampleSize: ex.sampleSize || null,
        quote: f.quote || '', note: f.note || '',
        D, P, R: round(R, 3), B, O, weight: round(weight, 4), biasFlags: flags,
      });
    }
  }

  const perOutcome = (outcomes || []).map(o => scoreOutcome(o, rowsByOutcome.get(o.id) || []));

  // Headline = first critical outcome with usable evidence, else the
  // outcome with the most studies. Benefits and harms stay separate.
  const usable = perOutcome.filter(o => o.evidenceState !== 'insufficient');
  const primary = usable.find(o => o.critical) || [...perOutcome].sort((a, b) => b.studies - a.studies)[0] || null;

  const allRows = [...rowsByOutcome.values()].flat();
  const maxW = Math.max(1e-9, ...allRows.map(r => r.weight));

  // Strip positions: one dot per paper, placed by its finding on the
  // primary outcome (or its first linked finding).
  const positions = {};
  for (const ex of extractions) {
    const row = (primary && rowsByOutcome.get(primary.id)?.find(r => r.ref === ex.ref)) ||
                allRows.find(r => r.ref === ex.ref);
    if (!row) continue;
    const rel = row.weight / maxW;
    const j = hashJitter(ex.ref, 0.03);
    const x =
      row.direction === 'beneficial' ? 0.60 + 0.32 * rel + j :
      row.direction === 'harmful'    ? 0.40 - 0.32 * rel + j :
      row.direction === 'mixed'      ? 0.50 + hashJitter(ex.ref + 'm', 0.10) :
                                       0.50 + hashJitter(ex.ref + 'n', 0.06);
    positions[ex.ref] = {
      x: round(Math.min(0.96, Math.max(0.04, x)), 3),
      direction: row.direction, outcomeId: row.outcomeId, weight: row.weight,
    };
  }

  const headline = primary || scoreOutcome({ id: 'none', name: 'none' }, []);
  const topDrivers = [...allRows].sort((a, b) => b.weight - a.weight).slice(0, 8);

  return {
    algorithm: ALGORITHM_VERSION,
    primaryOutcomeId: primary?.id || null,
    outcomes: perOutcome,
    // Headline fields (kept for the existing meter UI)
    score: headline.score,
    rightPct: Math.min(99, Math.max(1, headline.rightPct)),
    leftPct: 100 - Math.min(99, Math.max(1, headline.rightPct)),
    evidenceState: headline.evidenceState,
    certainty: headline.certainty,
    directionalConf: headline.directionalConf,
    designQuality: headline.designQuality,
    contradiction: headline.contradiction,
    evidenceCount: new Set(allRows.map(r => r.ref)).size,
    contributions: allRows,
    topDrivers,
    positions,
    excluded,
  };
}

module.exports = {
  ALGORITHM_VERSION, DESIGN_PRIOR, computeConsensus, scoreOutcome, poolEffects, precisionWeight, hashJitter,
};
