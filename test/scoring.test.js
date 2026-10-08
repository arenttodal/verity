const test = require('node:test');
const assert = require('node:assert/strict');
const { computeConsensus } = require('../lib/scoring');

const O = [{ id: 'o1', name: 'strength', type: 'benefit', higherIsBetter: true, critical: true }];
let n = 0;
function study(direction, design = 'rct', sampleSize = 5000, extra = {}) {
  return {
    ref: `r${n++}`, design, sampleSize, year: 2020, populationMatch: 1, interventionMatch: 1, humans: true,
    findings: [{ outcomeId: 'o1', direction, grounded: true, ...(extra.finding || {}) }],
    ...(extra.study || {}),
  };
}
const many = (k, ...a) => Array.from({ length: k }, () => study(...a));

test('§1.1 ten precise null RCTs are strong evidence of no effect', () => {
  const r = computeConsensus(many(10, 'null'), O);
  assert.equal(r.evidenceState, 'consistent_null');
  assert.equal(r.certainty, 'High');
  assert.equal(r.rightPct, 50);
});

test('§1.1 one small survey cannot override ten null RCTs', () => {
  const r = computeConsensus([...many(10, 'null'), study('beneficial', 'cross_sectional', 40)], O);
  assert.equal(r.evidenceState, 'consistent_null');
  assert.ok(r.rightPct <= 52, `rightPct ${r.rightPct}`);
});

test('§1.1 a single small study is "insufficient", never "Strong"', () => {
  const r = computeConsensus([study('beneficial', 'cross_sectional', 40)], O);
  assert.equal(r.evidenceState, 'insufficient');
  assert.equal(r.directionalConf, 'Insufficient');
  assert.equal(r.certainty, 'Very low');
});

test('§1.3 multi-outcome papers get one vote per outcome', () => {
  const multi = study('harmful');
  multi.findings = Array(5).fill({ outcomeId: 'o1', direction: 'harmful', grounded: true });
  const r = computeConsensus([study('beneficial'), multi, study('beneficial'), study('harmful')], O);
  assert.equal(r.rightPct, 50);
});

test('§1.3 benefits and harms are scored as separate outcomes', () => {
  const OO = [O[0], { id: 'o2', name: 'diabetes', type: 'harm', higherIsBetter: false }];
  const ex = many(6, 'beneficial').map((s, i) => ({ ...s, findings: [s.findings[0], { outcomeId: 'o2', direction: 'harmful', grounded: true }] }));
  const r = computeConsensus(ex, OO);
  const [o1, o2] = r.outcomes;
  assert.equal(o1.evidenceState, 'consistent_benefit');
  assert.equal(o2.evidenceState, 'consistent_harm');
  assert.equal(o1.contradiction, 0); // not reported as "contradiction"
});

test('AUDIT §1.2 score does not depend on input order', () => {
  const pos = many(6, 'beneficial', 'cohort', 800);
  const neg = many(6, 'harmful', 'cohort', 800);
  const a = computeConsensus([...pos, ...neg], O);
  const b = computeConsensus([...neg, ...pos], O);
  assert.equal(a.rightPct, b.rightPct);
  assert.equal(a.rightPct, 50);
});

test('AUDIT §1.6 contradiction spans [0,1]', () => {
  const r = computeConsensus([...many(4, 'beneficial'), ...many(4, 'harmful')], O);
  assert.equal(r.contradiction, 1);
  assert.equal(r.evidenceState, 'conflicting');
});

test('AUDIT §1.4 "mixed" findings do not lean toward benefit', () => {
  const r = computeConsensus(many(8, 'mixed'), O);
  assert.equal(r.rightPct, 50);
});

test('observational-only evidence starts at Low certainty (GRADE)', () => {
  const r = computeConsensus(many(8, 'beneficial', 'cohort', 20000), O);
  assert.equal(r.evidenceState, 'consistent_benefit');
  assert.equal(r.certainty, 'Low');
});

test('pooled ratio CI excluding 1 sets the evidence state; lower-is-better handled', () => {
  const OM = [{ id: 'o1', name: 'mortality', type: 'harm', higherIsBetter: false, critical: true }];
  const eff = (p, l, h) => ({ finding: { effect: { measure: 'RR', point: p, ciLow: l, ciHigh: h }, effectGrounded: true } });
  const r = computeConsensus([
    study('beneficial', 'rct', 5000, eff(0.80, 0.72, 0.89)),
    study('beneficial', 'rct', 5000, eff(0.83, 0.75, 0.92)),
    study('beneficial', 'rct', 5000, eff(0.78, 0.69, 0.88)),
  ], OM);
  assert.equal(r.outcomes[0].pooled.favours, 'beneficial');
  assert.equal(r.evidenceState, 'consistent_benefit');
  assert.ok(r.outcomes[0].pooled.estimate < 1);
});

test('ungrounded findings are down-weighted and ungrounded effects never pooled', () => {
  const eff = { measure: 'SMD', point: 2, ciLow: 1.5, ciHigh: 2.5 };
  const bad = study('beneficial', 'rct', 500, { finding: { grounded: false, effect: eff, effectGrounded: false } });
  const good = study('beneficial', 'rct', 500);
  const r = computeConsensus([bad, good], O);
  const [cb, cg] = [r.contributions.find(c => c.ref === bad.ref), r.contributions.find(c => c.ref === good.ref)];
  assert.ok(cb.weight < cg.weight);
  assert.equal(r.outcomes[0].pooled, null);
});

test('non-human studies are excluded from human consensus', () => {
  const r = computeConsensus([...many(3, 'beneficial'), study('harmful', 'animal', 40)], O);
  assert.equal(r.excluded.nonHuman.length, 1);
  assert.equal(r.outcomes[0].counts.harmful, 0);
});

test('industry funding downgrades weight (AUDIT §2.1)', () => {
  const ind = study('beneficial', 'rct', 500, { study: { funding: { biasRisk: 'high' } } });
  const ind2 = study('beneficial', 'rct', 500);
  const r = computeConsensus([ind, ind2], O);
  const w = ref => r.contributions.find(c => c.ref === ref).weight;
  assert.ok(w(ind.ref) < w(ind2.ref));
});

test('strip positions are deterministic', () => {
  const ex = many(5, 'beneficial');
  const a = computeConsensus(ex, O).positions;
  const b = computeConsensus(ex, O).positions;
  assert.deepEqual(a, b);
  for (const p of Object.values(a)) assert.ok(p.x > 0.5);
});
