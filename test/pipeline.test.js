// End-to-end: the full pipeline against fake literature/news APIs and
// a fake Claude client. No network, no API key.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAnalysis, PipelineError } = require('../lib/pipeline');
const { makeHttp, makeClient } = require('./fixtures/fake-world');

const run = (opts = {}) => runAnalysis('Does creatine improve strength?', {}, {
  client: makeClient(opts), http: makeHttp(opts),
});

test('pipeline: excludes retracted, off-topic and non-human papers', async () => {
  const r = await run();
  assert.equal(r.meta.flow.retractedExcluded, 1);
  assert.ok(!r.papers.some(p => /JAK\/STAT/.test(p.title)), 'entity gate removed the off-topic paper');
  assert.equal(r.meta.flow.nonHumanExcluded, 1);
  assert.ok(r.meta.retractedTitles[0].includes('triples'));
});

test('pipeline: merges the S2 + PubMed duplicate and trusts PubMed design over the LLM', async () => {
  const r = await run();
  const rct = r.papers.find(p => p.doi === '10.1000/rct1');
  assert.deepEqual(rct.sources.sort(), ['pubmed', 's2']);
  assert.equal(rct.design, 'rct'); // LLM said "cohort"
  assert.equal(rct.citations, 55);
});

test('pipeline: per-outcome scoring with pooled effect', async () => {
  const r = await run();
  const strength = r.analysis.outcomes.find(o => o.id === 'o1');
  assert.equal(strength.evidenceState, 'consistent_benefit');
  assert.equal(strength.pooled.measure, 'SMD');
  assert.equal(strength.pooled.k, 4);
  assert.equal(strength.studies, 5);
  const ae = r.analysis.outcomes.find(o => o.id === 'o2');
  assert.equal(ae.evidenceState, 'insufficient');
  assert.equal(r.analysis.debate.primaryOutcome, 'Muscle strength');
});

test('pipeline: synthesis sentences with invented numbers are removed', async () => {
  const r = await run();
  const text = r.analysis.synthesis.paragraphs.map(p => p.text).join(' ');
  assert.ok(!text.includes('87.5'));
  assert.ok(text.includes('SMD 0.32'));
  assert.equal(r.meta.synthesisSentencesDropped, 1);
});

test('pipeline: hallucinated quotes are flagged and down-weighted', async () => {
  const r = await run({ hallucinate: true });
  const rct = r.papers.find(p => p.doi === '10.1000/rct1');
  assert.equal(rct.findings[0].grounded, false);
  assert.equal(r.meta.ungroundedFindings, 1);
});

test('pipeline: media uses real outlet domains and a deterministic score', async () => {
  const r = await run();
  const stat = r.media.find(m => m.url.includes('statnews'));
  assert.ok(stat, 'Bing redirect was unwrapped');
  assert.equal(stat.weight, 3);
  const reuters = r.media.find(m => m.outlet === 'Reuters');
  assert.equal(reuters.weight, 4, 'Google News <source url> used for weight');
  assert.equal(typeof r.mediaAnalysis.rightPct, 'number');
  assert.ok(r.divergenceAnalysis);
  assert.ok(!r.divergenceAnalysis.signals.some(s => /Industry funding detected in \d+ papers/.test(s) && !/of/.test(s)));
});

test('pipeline: source failures are reported, not hidden', async () => {
  const r = await run({ failS2: true });
  const s2 = r.meta.sources.find(s => s.name === 'Semantic Scholar');
  assert.equal(s2.status, 'error');
  assert.ok(r.meta.warnings.some(w => w.includes('Semantic Scholar')));
});

test('pipeline: thinking disabled on current models', async () => {
  const client = makeClient();
  await runAnalysis('q', {}, { client, http: makeHttp() });
  assert.ok(client.calls.every(c => c.thinking?.type === 'disabled'));
});

test('pipeline: all sources empty → 502 PipelineError', async () => {
  const http = async url => {
    if (url.includes('esearch')) return { ok: true, status: 200, json: async () => ({ esearchresult: { idlist: [] } }) };
    return { ok: true, status: 200, json: async () => ({ data: [], results: [], resultList: { result: [] } }), text: async () => '' };
  };
  await assert.rejects(runAnalysis('q', {}, { client: makeClient(), http }), e => e instanceof PipelineError && e.status === 502);
});
