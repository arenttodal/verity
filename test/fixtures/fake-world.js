// ─────────────────────────────────────────────────────────────────
//  An offline "world" for end-to-end tests and UI previews:
//  fake literature/news APIs (http) and a fake Claude client whose
//  answers are derived from the request content.
//
//  Scenario: "Does creatine supplementation improve muscle strength?"
// ─────────────────────────────────────────────────────────────────

const PAPERS = [
  { pmid: '30001', doi: '10.1000/meta1', year: 2021, journal: 'Sports Med', design: 'meta', n: 1200, types: ['Meta-Analysis', 'Systematic Review'],
    title: 'Creatine supplementation and muscle strength in adults: a systematic review and meta-analysis',
    abstract: 'BACKGROUND: Creatine is widely used. METHODS: We pooled 22 randomized trials (n=1200). RESULTS: Creatine supplementation increased upper-body strength compared with placebo (SMD 0.32, 95% CI 0.18 to 0.46). CONCLUSIONS: Creatine combined with resistance training modestly improves strength.',
    quote: 'Creatine supplementation increased upper-body strength compared with placebo (SMD 0.32, 95% CI 0.18 to 0.46).', dir: 'beneficial', effect: { measure: 'SMD', point: 0.32, ciLow: 0.18, ciHigh: 0.46 }, grants: ['National Institutes of Health'] },
  { pmid: '30002', doi: '10.1000/rct1', year: 2022, journal: 'J Appl Physiol', design: 'rct', n: 140, types: ['Randomized Controlled Trial'],
    title: 'Creatine monohydrate and resistance training in older adults: a randomised controlled trial',
    abstract: 'We randomised 140 adults aged 60 to 80 years to creatine or placebo for 24 weeks. Leg press strength improved more with creatine than placebo (SMD 0.41, 95% CI 0.07 to 0.75). Adverse events were similar between groups.',
    quote: 'Leg press strength improved more with creatine than placebo (SMD 0.41, 95% CI 0.07 to 0.75).', dir: 'beneficial', effect: { measure: 'SMD', point: 0.41, ciLow: 0.07, ciHigh: 0.75 } },
  { pmid: '30003', doi: '10.1000/rct2', year: 2023, journal: 'Nutrients', design: 'rct', n: 90, types: ['Randomized Controlled Trial'],
    title: 'Short-term creatine loading does not improve sprint or strength performance in trained women',
    abstract: 'Ninety trained women received creatine or placebo for 4 weeks. Bench press one-repetition maximum did not differ between groups (SMD 0.05, 95% CI -0.36 to 0.46). Short-term creatine loading did not improve strength in this population.',
    quote: 'Bench press one-repetition maximum did not differ between groups (SMD 0.05, 95% CI -0.36 to 0.46).', dir: 'null', effect: { measure: 'SMD', point: 0.05, ciLow: -0.36, ciHigh: 0.46 }, industry: true, grants: ['AlzChem Trostberg GmbH'] },
  { pmid: '30004', doi: '10.1000/coh1', year: 2020, journal: 'Eur J Nutr', design: 'cohort', n: 3400, types: ['Observational Study'],
    title: 'Habitual creatine intake and grip strength in a population cohort',
    abstract: 'In a prospective cohort of 3400 adults followed for 6 years, higher dietary creatine intake was associated with greater grip strength (beta 0.8 kg per 1 g/day). Residual confounding cannot be excluded.',
    quote: 'higher dietary creatine intake was associated with greater grip strength (beta 0.8 kg per 1 g/day).', dir: 'beneficial', effect: null },
  { pmid: '30005', doi: '10.1000/ae1', year: 2022, journal: 'Clin Nutr', design: 'meta', n: 2900, types: ['Meta-Analysis'],
    title: 'Safety of creatine supplementation: a meta-analysis of adverse events in randomized trials',
    abstract: 'We pooled adverse event data from 35 trials (n=2900). Creatine was not associated with an increase in adverse events (RR 1.02, 95% CI 0.91 to 1.15). Renal markers were unchanged.',
    quote: 'Creatine was not associated with an increase in adverse events (RR 1.02, 95% CI 0.91 to 1.15).', dir: 'null', outcome: 'o2', effect: { measure: 'RR', point: 1.02, ciLow: 0.91, ciHigh: 1.15 } },
  { pmid: '30006', doi: '10.1000/rat1', year: 2021, journal: 'Amino Acids', design: 'animal', n: 40, types: ['Journal Article'], animals: true,
    title: 'Creatine feeding increases muscle force in aged rats',
    abstract: 'Forty aged rats were fed creatine or control chow for 8 weeks. Creatine-fed rats showed greater tetanic force in the soleus muscle. These findings support further study of creatine in sarcopenia.',
    quote: 'Creatine-fed rats showed greater tetanic force in the soleus muscle.', dir: 'beneficial', effect: null },
  { pmid: '30007', doi: '10.1000/retracted', year: 2019, journal: 'J Fake Res', design: 'rct', n: 30, types: ['Randomized Controlled Trial', 'Retracted Publication'],
    title: 'Creatine triples strength in eight days: a randomised trial',
    abstract: 'Thirty men took creatine for eight days. Strength tripled compared with placebo. These results are remarkable and should change practice immediately for all athletes everywhere.',
    quote: 'Strength tripled compared with placebo.', dir: 'beneficial', effect: null },
  { pmid: '30008', doi: '10.1000/rct3', year: 2024, journal: 'Med Sci Sports Exerc', design: 'rct', n: 210, types: ['Randomized Controlled Trial'],
    title: 'Creatine supplementation during 12 weeks of resistance training in young adults',
    abstract: 'Two hundred and ten young adults were randomised to creatine or placebo during 12 weeks of training. Squat strength gains were greater with creatine (SMD 0.36, 95% CI 0.09 to 0.63). Body mass increased by 1.1 kg.',
    quote: 'Squat strength gains were greater with creatine (SMD 0.36, 95% CI 0.09 to 0.63).', dir: 'beneficial', effect: { measure: 'SMD', point: 0.36, ciLow: 0.09, ciHigh: 0.63 } },
];

// Off-topic paper the entity gate must reject (no "creatine")
const JAK = { title: 'JAK/STAT signalling in skeletal muscle building', abstract: 'We review how JAK/STAT signalling regulates skeletal muscle hypertrophy and building of muscle mass in response to training stimuli across a range of models.', year: 2022 };

function pubmedXML(ps) {
  return '<PubmedArticleSet>' + ps.map(p => `<PubmedArticle><MedlineCitation><PMID Version="1">${p.pmid}</PMID><Article PubModel="Print"><Journal><JournalIssue><PubDate><Year>${p.year}</Year></PubDate></JournalIssue><Title>${p.journal}</Title><ISOAbbreviation>${p.journal}</ISOAbbreviation></Journal><ArticleTitle>${p.title}.</ArticleTitle><ELocationID EIdType="doi" ValidYN="Y">${p.doi}</ELocationID><Abstract><AbstractText>${p.abstract.replace(/</g, '&lt;')}</AbstractText></Abstract>${p.grants ? `<GrantList>${p.grants.map(g => `<Grant><Agency>${g}</Agency><Country>United States</Country></Grant>`).join('')}</GrantList>` : ''}<PublicationTypeList>${p.types.map(t => `<PublicationType UI="D0">${t}</PublicationType>`).join('')}</PublicationTypeList></Article><MeshHeadingList><MeshHeading><DescriptorName UI="D1">${p.animals ? 'Animals' : 'Humans'}</DescriptorName></MeshHeading></MeshHeadingList></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${p.pmid}</ArticleId><ArticleId IdType="doi">${p.doi}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`).join('') + '</PubmedArticleSet>';
}

const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const text = body => ({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body });

function makeHttp({ failS2 = false } = {}) {
  const calls = [];
  async function http(url) {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.semanticscholar.org') {
      if (failS2) return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
      // S2 returns the RCT twice-covered paper (also in PubMed) with no
      // usable design label, plus the off-topic JAK/STAT paper.
      return json({ data: [
        { title: PAPERS[1].title, abstract: PAPERS[1].abstract, year: PAPERS[1].year, journal: { name: PAPERS[1].journal }, citationCount: 55, externalIds: { DOI: PAPERS[1].doi.toUpperCase(), PubMed: PAPERS[1].pmid }, publicationTypes: ['JournalArticle'] },
        { title: JAK.title, abstract: JAK.abstract, year: JAK.year, journal: { name: 'Cell' }, citationCount: 900, externalIds: {}, publicationTypes: ['Review'] },
      ] });
    }
    if (u.hostname === 'eutils.ncbi.nlm.nih.gov' && u.pathname.includes('esearch')) {
      return json({ esearchresult: { idlist: PAPERS.map(p => p.pmid) } });
    }
    if (u.hostname === 'eutils.ncbi.nlm.nih.gov' && u.pathname.includes('efetch')) {
      const ids = u.searchParams.get('id').split(',');
      return text(pubmedXML(PAPERS.filter(p => ids.includes(p.pmid))));
    }
    if (u.hostname === 'api.openalex.org') return json({ results: [] });
    if (u.hostname === 'www.ebi.ac.uk') return json({ resultList: { result: [] } });
    if (u.hostname === 'content.guardianapis.com') {
      return json({ response: { results: [
        { webTitle: 'Creatine: the supplement that really does make you stronger', webUrl: 'https://www.theguardian.com/a', webPublicationDate: '2024-03-01T00:00:00Z', fields: { trailText: 'Strength gains from creatine are real' } },
        { webTitle: 'Is creatine bad for your kidneys? Doctors warn of strength supplement risks', webUrl: 'https://www.theguardian.com/b', webPublicationDate: '2023-05-01T00:00:00Z', fields: { trailText: 'creatine muscle strength risks' } },
      ] } });
    }
    if (u.hostname === 'news.google.com') {
      return text(`<rss><channel>
        <item><title>Creatine supercharges muscle strength, miracle study finds - Daily Mail</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><source url="https://www.dailymail.co.uk">Daily Mail</source></item>
        <item><title>Creatine boosts strength in older adults, trial shows - Reuters</title><link>https://news.google.com/rss/articles/def</link><pubDate>Mon, 01 Jul 2024 00:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
      </channel></rss>`);
    }
    if (u.hostname === 'www.bing.com') {
      return text(`<rss><channel><item><title>Creatine strength gains are mostly water weight, experts say</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fwww.statnews.com%2fcreatine&amp;c=1</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>creatine muscle strength</description></item></channel></rss>`);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  }
  http.calls = calls;
  return http;
}

// ── Fake Claude ──────────────────────────────────────────────────
function reply(obj) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

const FRAME = {
  plain: 'Does creatine supplementation improve muscle strength in adults?',
  population: 'adults', intervention: 'creatine supplementation', comparator: 'placebo',
  outcomes: [
    { id: 'o1', name: 'Muscle strength', type: 'benefit', higherIsBetter: true, critical: true },
    { id: 'o2', name: 'Adverse events', type: 'harm', higherIsBetter: false, critical: false },
  ],
  humanQuestion: true,
  requiredTerms: ['creatine'], synonyms: ['creatine monohydrate', 'phosphocreatine'],
  searchTerms: { semantic: 'creatine supplementation muscle strength', pubmed: 'creatine AND (strength OR muscle)', openAlex: 'creatine supplementation strength' },
  axisLeftLabel: 'Worsens', axisRightLabel: 'Improves',
  leftClaim: 'reduces strength', leftDesc: 'Creatine impairs strength or causes harm', rightClaim: 'improves strength', rightDesc: 'Creatine increases strength with training',
  gdeltQuery: 'creatine strength', mediaSubjectTerms: ['creatine'], mediaOutcomeTerms: ['strength', 'muscle'],
  isDebatable: false, domain: 'exercise_science',
};

function makeClient({ hallucinate = false, inject = false } = {}) {
  const calls = [];
  async function create(params) {
    const sys = params.system.map(b => b.text).join(' ');
    const user = typeof params.messages[0].content === 'string' ? params.messages[0].content : '';
    calls.push({ sys: sys.slice(0, 60), model: params.model, thinking: params.thinking });

    if (sys.includes('systematic review methodologist')) return reply(FRAME);
    if (sys.includes('screen search results')) {
      const n = (user.match(/<paper /g) || []).length;
      return reply({ decisions: Array.from({ length: n }, (_, i) => ({ i: i + 1, relevant: true })) });
    }
    if (sys.includes('data extractor')) {
      const refs = [...user.matchAll(/<paper ref="([^"]+)">Title: ([^\n]+)/g)].map(m => ({ ref: m[1], title: m[2] }));
      return reply({ extractions: refs.map(({ ref, title }) => {
        const p = PAPERS.find(x => x.title === title);
        if (!p) return { ref, design: 'unknown', findings: [] };
        const quote = hallucinate && p.pmid === '30002' ? 'Creatine doubled leg strength in every participant.' : p.quote;
        return {
          ref, design: p.design === 'meta' && p.pmid === '30005' ? 'meta' : (p.pmid === '30002' ? 'cohort' : p.design), // LLM mislabels the RCT; PubMed type should win
          humans: !p.animals, sampleSize: p.n, populationMatch: 0.9, interventionMatch: 1,
          fundingStatement: null, industryFunding: p.industry ? true : null,
          findings: [
            { outcomeId: p.outcome || 'o1', direction: p.dir, effect: p.effect, quote, note: quote },
            // a second finding on the same outcome must not add a second vote
            ...(p.pmid === '30001' ? [{ outcomeId: 'o1', direction: 'beneficial', effect: null, quote: p.quote, note: 'dup' }] : []),
          ],
        };
      }) });
    }
    if (sys.includes('calibrated plain-language')) {
      return reply({ paragraphs: [
        { text: 'Randomised trials and a meta-analysis show **creatine modestly improves strength** when combined with training (SMD 0.32).', cites: [1, 2] },
        { text: 'One trial in trained women found no difference, and a made-up statistic of 87.5% should be removed. Most trials are small.', cites: [3] },
        ...(inject ? [{ text: '<img src=x onerror=alert(1)> injected', cites: [1] }] : []),
      ] });
    }
    if (sys.includes('two-sentence bottom line')) return reply({ verdict: 'Creatine taken alongside resistance training modestly increases strength in adults. The evidence comes mainly from randomised trials and is fairly consistent, though many studies are small.' });
    if (sys.includes('news search queries')) return reply({ queries: ['creatine muscle strength', 'creatine strength study'] });
    if (sys.includes('which news headlines')) {
      const n = (user.match(/<headline /g) || []).length;
      return reply({ relevant: Array.from({ length: n }, (_, i) => i) });
    }
    if (sys.includes('classify how news headlines')) {
      const items = [...user.matchAll(/<headline i="(\d+)"[^>]*>([^<]+)</g)];
      return reply({ stances: items.map(m => ({ i: Number(m[1]), stance: /warn|bad|risk|water/i.test(m[2]) ? 'harmful' : 'beneficial', framing: 'Headline framing summary.' })) });
    }
    if (sys.includes('science-communication researcher')) return reply({ category: 'wellness_hype', confidence: 'moderate', headline: 'Headlines oversell modest strength gains as miracle results', explanation: 'Tabloid headlines describe a "miracle" while trials show modest effects.', caveat: 'Headline framing is only a proxy for article content.' });
    throw new Error('fake client: unrecognised prompt: ' + sys.slice(0, 80));
  }
  return { messages: { create }, calls };
}

module.exports = { makeHttp, makeClient, PAPERS, FRAME, pubmedXML };
