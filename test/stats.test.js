const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/stats');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

test('t quantiles match reference tables', () => {
  close(s.tQuantile(0.975, 1), 12.706, 0.001);
  close(s.tQuantile(0.975, 4), 2.776, 0.001);
  close(s.tQuantile(0.975, 30), 2.042, 0.001);
  close(s.tQuantile(0.025, 4), -2.776, 0.001);
});

test('normal quantile', () => {
  close(s.normQuantile(0.975), 1.95996, 1e-4);
  close(s.normQuantile(0.5), 0, 1e-9);
});

test('incomplete beta / beta quantile are inverse', () => {
  const q = s.betaQuantile(0.3, 2.5, 4);
  close(s.incBeta(q, 2.5, 4), 0.3, 1e-8);
  close(s.incBeta(0.5, 1, 1), 0.5, 1e-12); // uniform
});

test('Jeffreys interval: 8/10 unweighted', () => {
  // Reference: Jeffreys 95% CI for 8/10 ≈ (0.4972, 0.9568)
  const r = s.jeffreysInterval(8, 10, 10);
  close(r.lo, 0.4972, 0.001);
  close(r.hi, 0.9568, 0.001);
});

test('Kish effective n penalises unequal weights', () => {
  assert.equal(s.kishNeff([1, 1, 1, 1]), 4);
  assert.ok(s.kishNeff([10, 0.1, 0.1, 0.1]) < 1.1);
});

test('random effects: homogeneous studies give τ²=0 and pooled ≈ common value', () => {
  const r = s.randomEffectsHK([{ y: 0.3, se: 0.1 }, { y: 0.3, se: 0.15 }, { y: 0.3, se: 0.12 }]);
  close(r.mu, 0.3, 1e-9);
  assert.equal(r.tau2, 0);
  assert.ok(r.ci[0] < 0.3 && r.ci[1] > 0.3);
  assert.ok(r.pi);
});

test('random effects: heterogeneity widens the prediction interval beyond the CI', () => {
  const r = s.randomEffectsHK([{ y: -0.2, se: 0.08 }, { y: 0.1, se: 0.08 }, { y: 0.5, se: 0.08 }, { y: 0.8, se: 0.08 }]);
  assert.ok(r.tau2 > 0);
  assert.ok(r.I2 > 0.8);
  assert.ok(r.pi[1] - r.pi[0] > r.ci[1] - r.ci[0]);
});

test('SE from ratio CI', () => {
  close(s.seFromRatioCI(0.8, 1.25), Math.log(1.25 / 0.8) / 3.919928, 1e-9);
  assert.equal(s.seFromRatioCI(-1, 2), null);
});
