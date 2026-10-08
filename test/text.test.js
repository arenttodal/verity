const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../lib/text');

test('entity gate: "vitamin d" must not match "vitamin c" (REVIEW §1.4)', () => {
  const m = t.buildMatcher(['vitamin d']);
  assert.equal(m.test('Vitamin C and the common cold'), false);
  assert.equal(m.test('Vitamin D supplementation and fractures'), true);
  assert.equal(m.test('vitamin-D status in older adults'), true);
});

test('entity gate: plurals match (REVIEW §1.4)', () => {
  const m = t.buildMatcher(['statin']);
  assert.equal(m.test('Statins and dementia risk'), true);
  assert.equal(m.test('statin therapy'), true);
  assert.equal(m.test('nystatin cream'), false); // no substring matches
});

test('entity gate: B-12 is not vacuous', () => {
  const m = t.buildMatcher(['B-12']);
  assert.equal(m.test('Quantum effects in superconductors'), false);
  assert.equal(m.test('Vitamin B12 deficiency'), false); // phrase "b 12"/"b-12" only
  assert.equal(m.test('Vitamin B-12 deficiency'), true);
  assert.equal(m.test('vitamin b 12 levels'), true);
});

test('entity gate: hyphen/space interchangeable, omega-3', () => {
  const m = t.buildMatcher(['omega-3']);
  assert.equal(m.test('Omega 3 fatty acids'), true);
  assert.equal(m.test('omega-3 supplementation'), true);
  assert.equal(m.test('omega-6 intake'), false);
});

test('entity decoding', () => {
  assert.equal(t.cleanText('p &lt; 0.05 and &#x2265;3 &amp; <i>in vivo</i>'), 'p < 0.05 and ≥3 & in vivo');
});

test('quote grounding tolerates whitespace/dash/case differences only', () => {
  const src = 'RESULTS: Creatine increased strength (SMD 0.32, 95% CI 0.18–0.46).';
  assert.equal(t.quoteIsGrounded('creatine increased strength (SMD 0.32, 95% CI 0.18-0.46)', src), true);
  assert.equal(t.quoteIsGrounded('Creatine doubled strength in all participants.', src), false);
  assert.equal(t.quoteIsGrounded('short', src), false);
});

test('numbers grounded: invented numbers are detected', () => {
  assert.equal(t.numbersGrounded('Strength rose (SMD 0.32).', ['SMD 0.32 (95% CI 0.18–0.46)']), true);
  assert.equal(t.numbersGrounded('Strength rose by 87.5%.', ['SMD 0.32']), false);
  assert.equal(t.numbersGrounded('Three trials since 2019 found this.', ['nothing']), true); // small ints & years ignored
});

test('escapeHtml', () => {
  assert.equal(t.escapeHtml(`<img src=x onerror="a('b')">`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;');
});
