// ─────────────────────────────────────────────────────────────────
//  Literature sources. Every fetcher returns normalised paper records
//  (see lib/papers.js) and never throws for "no results".
//
//  `http` is injected so the pipeline can be tested offline.
// ─────────────────────────────────────────────────────────────────
const { cleanText } = require('./text');
const { normDoi, designFromS2Types, designFromPubMedTypes, parsePubMedXML, summariseFunding, PREPRINT_VENUES } = require('./papers');

const CONTACT = process.env.CONTACT_EMAIL || 'hello@verity.science';
const UA = `Verity/9.0 (mailto:${CONTACT})`;

const withRank = list => list.map((p, i) => ({ ...p, rank: list.length > 1 ? i / (list.length - 1) : 0 }));

function makeSources(http = fetch) {
  async function getJSON(url, opts = {}) {
    const res = await http(url, { signal: AbortSignal.timeout(opts.timeout || 14000), headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    if (res.status === 429) {
      const err = new Error('rate limited'); err.status = 429; throw err;
    }
    if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
    return res.json();
  }

  // Retry once on 429 with a short backoff — S2's shared pool throttles often.
  async function withRetry(fn) {
    try { return await fn(); }
    catch (e) {
      if (e.status !== 429) throw e;
      await new Promise(r => setTimeout(r, 1500));
      return fn();
    }
  }

  // ── Semantic Scholar ──────────────────────────────────────────
  async function semanticScholar(query, { limit = 25, yearFrom }) {
    const url = 'https://api.semanticscholar.org/graph/v1/paper/search?' + new URLSearchParams({
      query, limit: String(limit),
      fields: 'title,abstract,year,venue,journal,citationCount,externalIds,publicationTypes',
      publicationDateOrYear: `${yearFrom}-`,
    });
    const headers = process.env.S2_API_KEY ? { 'x-api-key': process.env.S2_API_KEY } : {};
    const data = await withRetry(() => getJSON(url, { headers }));
    return withRank((data.data || [])
      .filter(p => p.abstract && p.abstract.length > 80)
      .map(p => {
        const journal = cleanText(p.journal?.name || p.venue || 'Unknown');
        return {
          title: cleanText(p.title), abstract: cleanText(p.abstract),
          year: p.year || null, journal,
          doi: normDoi(p.externalIds?.DOI), pmid: p.externalIds?.PubMed || null, openalexId: null,
          citations: p.citationCount || 0,
          design: designFromS2Types(p.publicationTypes), designFrom: 's2',
          pubTypes: p.publicationTypes || [], retracted: false,
          preprint: PREPRINT_VENUES.test(journal), humansMesh: null,
          sources: ['s2'], fundingData: null,
        };
      }));
  }

  // ── PubMed ────────────────────────────────────────────────────
  // Three searches: systematic reviews, RCTs, then general. Field tags
  // are added in code (not by the LLM) so they are always valid; if a
  // tagged query fails we simply lose that slice.
  async function pubmedIds(term, retmax, minDate) {
    const url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?' + new URLSearchParams({
      db: 'pubmed', term, retmax: String(retmax), retmode: 'json', sort: 'relevance',
      mindate: minDate, maxdate: '3000', datetype: 'pdat', tool: 'verity', email: CONTACT,
      ...(process.env.NCBI_API_KEY ? { api_key: process.env.NCBI_API_KEY } : {}),
    });
    const data = await getJSON(url, { timeout: 12000 });
    return data.esearchresult?.idlist || [];
  }

  async function pubmed(term, { limit = 20, yearFrom }) {
    const minDate = `${yearFrom}/01/01`;
    const slices = await Promise.allSettled([
      pubmedIds(`(${term}) AND (systematic[sb] OR meta-analysis[pt])`, Math.ceil(limit / 3), minDate),
      pubmedIds(`(${term}) AND randomized controlled trial[pt]`, Math.ceil(limit / 3), minDate),
      pubmedIds(term, limit, minDate),
    ]);
    const ordered = [];
    for (const s of slices) if (s.status === 'fulfilled') for (const id of s.value) if (!ordered.includes(id)) ordered.push(id);
    const ids = ordered.slice(0, Math.round(limit * 1.5));
    if (!ids.length) {
      const failed = slices.find(s => s.status === 'rejected');
      if (failed) throw failed.reason;
      return [];
    }
    const url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?' + new URLSearchParams({
      db: 'pubmed', id: ids.join(','), retmode: 'xml', rettype: 'abstract', tool: 'verity', email: CONTACT,
      ...(process.env.NCBI_API_KEY ? { api_key: process.env.NCBI_API_KEY } : {}),
    });
    const res = await http(url, { signal: AbortSignal.timeout(16000), headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`PubMed fetch ${res.status}`);
    const parsed = parsePubMedXML(await res.text());
    // Preserve search order (reviews, RCTs, then general relevance)
    const pos = new Map(ids.map((id, i) => [id, i]));
    parsed.sort((a, b) => (pos.get(a.pmid) ?? 1e9) - (pos.get(b.pmid) ?? 1e9));
    return withRank(parsed);
  }

  // ── OpenAlex ──────────────────────────────────────────────────
  async function openAlex(query, { limit = 15, yearFrom }) {
    const params = new URLSearchParams({
      search: query,
      filter: `publication_year:${yearFrom}-${new Date().getFullYear()},has_abstract:true`,
      sort: 'relevance_score:desc', 'per-page': String(limit),
      select: 'id,title,abstract_inverted_index,publication_year,primary_location,cited_by_count,doi,ids,type,is_retracted,grants',
      mailto: CONTACT,
    });
    const data = await getJSON(`https://api.openalex.org/works?${params}`, { timeout: 12000 });
    return withRank((data.results || []).map(w => {
      const pos = [];
      for (const [word, locs] of Object.entries(w.abstract_inverted_index || {})) for (const l of locs) pos[l] = word;
      const abstract = cleanText(pos.filter(Boolean).join(' '));
      if (abstract.length < 80) return null;
      const src = w.primary_location?.source || {};
      const journal = cleanText(src.display_name || 'Unknown');
      const pmid = (w.ids?.pmid || '').split('/').pop() || null;
      return {
        title: cleanText(w.title), abstract,
        year: w.publication_year || null, journal,
        doi: normDoi(w.doi), pmid, openalexId: w.id || null,
        citations: w.cited_by_count || 0,
        // OpenAlex "review" covers narrative AND systematic reviews.
        design: (w.type || '') === 'review' ? 'narrative_review' : 'unknown', designFrom: 'openalex',
        pubTypes: [w.type].filter(Boolean),
        retracted: !!w.is_retracted,
        preprint: (w.type || '') === 'preprint' || src.type === 'repository' || PREPRINT_VENUES.test(journal),
        humansMesh: null, sources: ['openalex'],
        fundingData: summariseFunding((w.grants || []).map(g => g.funder_display_name)),
      };
    }).filter(Boolean));
  }

  // ── Europe PMC ────────────────────────────────────────────────
  // Adds publication types, preprint flags and full abstracts for
  // records where S2/OpenAlex truncate.
  async function europePmc(query, { limit = 20, yearFrom }) {
    const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?' + new URLSearchParams({
      query: `(${query}) AND PUB_YEAR:[${yearFrom} TO ${new Date().getFullYear()}] AND HAS_ABSTRACT:y`,
      resultType: 'core', format: 'json', pageSize: String(limit), sort: 'RELEVANCE',
    });
    const data = await getJSON(url, { timeout: 12000 });
    return withRank((data.resultList?.result || []).map(r => {
      const abstract = cleanText(r.abstractText);
      if (abstract.length < 80) return null;
      const types = (r.pubTypeList?.pubType || []).map(String);
      const journal = cleanText(r.journalInfo?.journal?.isoabbreviation || r.journalInfo?.journal?.title || r.bookOrReportDetails?.publisher || 'Unknown');
      return {
        title: cleanText(r.title).replace(/\.$/, ''), abstract,
        year: r.pubYear ? parseInt(r.pubYear, 10) : null, journal,
        doi: normDoi(r.doi), pmid: r.pmid || null, openalexId: null,
        citations: r.citedByCount || 0,
        design: designFromPubMedTypes(types), designFrom: r.pmid ? 'pubmed' : 'europepmc',
        pubTypes: types,
        retracted: types.some(t => /retracted publication/i.test(t)),
        preprint: r.source === 'PPR',
        humansMesh: null, sources: ['europepmc'],
        fundingData: summariseFunding((r.grantsList?.grant || []).map(g => g.agency)),
      };
    }).filter(Boolean));
  }

  return { semanticScholar, pubmed, openAlex, europePmc };
}

module.exports = { makeSources };
