const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/papers');
const { pubmedXML, PAPERS } = require('./fixtures/fake-world');

test('PubMed parser: design from curated types, retraction, MeSH, DOI, grants', () => {
  const parsed = P.parsePubMedXML(pubmedXML(PAPERS));
  const by = Object.fromEntries(parsed.map(p => [p.pmid, p]));
  assert.equal(by['30001'].design, 'meta');
  assert.equal(by['30002'].design, 'rct');
  assert.equal(by['30004'].design, 'obs');
  assert.equal(by['30007'].retracted, true);
  assert.equal(by['30006'].humansMesh, false);
  assert.equal(by['30001'].doi, '10.1000/meta1');
  assert.equal(by['30001'].year, 2021);
  assert.equal(by['30001'].fundingData.categories[0], 'government');
  assert.equal(by['30003'].fundingData.industrySponsored, true);
  assert.ok(!by['30001'].title.endsWith('.'));
});

test('design labels: Review is not a meta-analysis; Clinical Trial is not an RCT (REVIEW §1.8)', () => {
  assert.equal(P.designFromS2Types(['Review']), 'narrative_review');
  assert.equal(P.designFromS2Types(['Meta-Analysis']), 'meta');
  assert.equal(P.designFromPubMedTypes(['Clinical Trial']), 'nonrandomized_trial');
  assert.equal(P.designFromPubMedTypes(['Randomized Controlled Trial', 'Clinical Trial']), 'rct');
  assert.equal(P.designFromPubMedTypes(['Review']), 'narrative_review');
});

test('merge-dedupe keeps PubMed metadata when S2 arrives first (REVIEW §1.7)', () => {
  const s2 = { title: 'A Trial of X', abstract: 'short abstract '.repeat(6), doi: '10.1/abc', pmid: null, year: 2020, journal: 'J', citations: 50,
    design: 'unknown', designFrom: 's2', pubTypes: [], retracted: false, preprint: false, sources: ['s2'], fundingData: null, rank: 0 };
  const pm = { title: 'A trial of X.', abstract: 'a much longer structured abstract '.repeat(6), doi: '10.1/ABC'.toLowerCase(), pmid: '123', year: 2020, journal: 'J',
    citations: 0, design: 'rct', designFrom: 'pubmed', pubTypes: ['Randomized Controlled Trial'], retracted: true, preprint: false,
    sources: ['pubmed'], fundingData: { sources: ['NIH'], categories: ['government'], industrySponsored: false, biasRisk: 'low' }, rank: 0.5 };
  const out = P.mergeDedupe([s2, pm]);
  assert.equal(out.length, 1);
  const m = out[0];
  assert.equal(m.design, 'rct');
  assert.equal(m.pmid, '123');
  assert.equal(m.citations, 50);
  assert.equal(m.retracted, true);
  assert.deepEqual(m.sources.sort(), ['pubmed', 's2']);
  assert.ok(m.abstract.startsWith('a much longer'));
  assert.equal(m.fundingData.sources[0], 'NIH');
});

test('dedupe by normalised title when DOIs are missing', () => {
  const a = { title: 'Coffee & Mortality: A Cohort', abstract: 'x'.repeat(100), sources: ['s2'], design: 'unknown', designFrom: 's2' };
  const b = { title: 'Coffee and mortality — a cohort', abstract: 'x'.repeat(100), sources: ['openalex'], design: 'unknown', designFrom: 'openalex' };
  // "&" vs "and" differ, so these are (correctly) not merged; identical-but-punctuated titles are:
  const c = { ...a, title: 'Coffee & Mortality: a cohort.', sources: ['openalex'] };
  assert.equal(P.mergeDedupe([a, b]).length, 2);
  assert.equal(P.mergeDedupe([a, c]).length, 1);
});

test('selection: citations only break ties, narrative reviews rank below trials', () => {
  const rct = { design: 'rct', rank: 0.5, citations: 0 };
  const review = { design: 'narrative_review', rank: 0, citations: 100000 };
  assert.ok(P.selectionScore(rct) > P.selectionScore(review));
});

test('funder classification', () => {
  assert.equal(P.classifyFunder('National Institutes of Health'), 'government');
  assert.equal(P.classifyFunder('Pfizer Inc'), 'industry');
  assert.equal(P.classifyFunder('Wellcome Trust'), 'foundation');
});
