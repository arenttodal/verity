// ─────────────────────────────────────────────────────────────────
//  News coverage: fetch, gate, rank, classify — and compare with the
//  science on the same axis (harmful ← null → beneficial).
// ─────────────────────────────────────────────────────────────────
const { cleanText, buildMatcher } = require('./text');
const llm = require('./llm');

const OUTLET_WEIGHTS = {
  // Tier 4 — Peer-reviewed journals with news arms / top-tier science press
  'theguardian.com': 4, 'nytimes.com': 4, 'bbc.co.uk': 4, 'bbc.com': 4,
  'reuters.com': 4, 'washingtonpost.com': 4, 'nature.com': 4,
  'science.org': 4, 'nejm.org': 4, 'thelancet.com': 4, 'bmj.com': 4,
  'jamanetwork.com': 4, 'cell.com': 4, 'pnas.org': 4,
  'nih.gov': 4, 'cdc.gov': 4, 'who.int': 4,
  'pubmed.ncbi.nlm.nih.gov': 4, 'cochranelibrary.com': 4,

  // Tier 3 — Specialist science/health journalism, evidence-adjacent
  'statnews.com': 3, 'newscientist.com': 3, 'sciencedaily.com': 3,
  'healthline.com': 3, 'medicalnewstoday.com': 3, 'time.com': 3,
  'theatlantic.com': 3, 'vox.com': 3, 'webmd.com': 3,
  'medscape.com': 3, 'medpagetoday.com': 3, 'healio.com': 3,
  'sciencenews.org': 3, 'scientificamerican.com': 3,
  'technologyreview.com': 3, 'theconversation.com': 3,
  'arstechnica.com': 3, 'wired.com': 3,
  'mayoclinic.org': 3, 'clevelandclinic.org': 3, 'hopkinsmedicine.org': 3,
  'examine.com': 3, 'verywellhealth.com': 3, 'verywellmind.com': 3,
  'psychiatryadvisor.com': 3, 'mdedge.com': 3,
  'eurekaalert.org': 3,

  // Tier 2 — General press with health sections, variable quality
  'cnn.com': 2, 'nbcnews.com': 2, 'abcnews.go.com': 2,
  'cbsnews.com': 2, 'usatoday.com': 2, 'forbes.com': 2,
  'menshealth.com': 2, 'womenshealthmag.com': 2, 'prevention.com': 2,
  'self.com': 2, 'health.com': 2, 'shape.com': 2,
  'dailymail.co.uk': 2, 'nypost.com': 2,
  'huffingtonpost.com': 2, 'huffpost.com': 2,
  'independent.co.uk': 2, 'telegraph.co.uk': 2, 'thetimes.co.uk': 2,
  'foxnews.com': 2,
};

// Outlet name → domain, for feeds where only the name is known.
const OUTLET_NAMES = {
  'the guardian': 'theguardian.com', 'new york times': 'nytimes.com', 'the new york times': 'nytimes.com',
  'bbc': 'bbc.co.uk', 'bbc news': 'bbc.co.uk', 'reuters': 'reuters.com', 'the washington post': 'washingtonpost.com',
  'stat': 'statnews.com', 'new scientist': 'newscientist.com', 'sciencedaily': 'sciencedaily.com',
  'cnn': 'cnn.com', 'nbc news': 'nbcnews.com', 'daily mail': 'dailymail.co.uk', 'fox news': 'foxnews.com',
  'the conversation': 'theconversation.com', 'scientific american': 'scientificamerican.com',
};

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function outletWeight(domainOrUrl, outletName) {
  const host = domainOrUrl && domainOrUrl.includes('/') ? hostOf(domainOrUrl) : String(domainOrUrl || '').replace(/^www\./, '');
  const candidates = [host, OUTLET_NAMES[String(outletName || '').toLowerCase().trim()]].filter(Boolean);
  for (const h of candidates) {
    for (const [domain, w] of Object.entries(OUTLET_WEIGHTS)) if (h === domain || h.endsWith('.' + domain)) return w;
  }
  return 2;
}

// Bing RSS links are click-trackers: the article URL is in ?url=
function unwrapBing(link) {
  try {
    const u = new URL(link);
    const inner = u.searchParams.get('url');
    return inner ? decodeURIComponent(inner) : link;
  } catch { return link; }
}

function parseRssItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const pick = re => { const x = b.match(re); return x ? x[1] : ''; };
    items.push({
      title: cleanText(pick(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)),
      link: pick(/<link[^>]*>(?:<!\[CDATA\[)?\s*(https?:[^\s<"\]]+)/),
      date: pick(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/),
      desc: cleanText(pick(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)),
      sourceName: cleanText(pick(/<source[^>]*>([\s\S]*?)<\/source>/)),
      sourceUrl: pick(/<source[^>]*url="([^"]+)"/),
    });
  }
  return items;
}

const yearOf = d => { const y = new Date(d).getFullYear(); return Number.isFinite(y) ? y : null; };

function makeMedia(http = fetch) {
  async function guardian(q, fromDate, toDate) {
    const params = new URLSearchParams({
      q, 'from-date': fromDate, 'to-date': toDate, 'order-by': 'relevance', 'page-size': '30',
      'show-fields': 'headline,trailText', 'api-key': process.env.GUARDIAN_API_KEY || 'test',
    });
    const res = await http(`https://content.guardianapis.com/search?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Guardian ${res.status}`);
    const data = await res.json();
    return (data.response?.results || []).map(r => ({
      title: cleanText(r.webTitle || r.fields?.headline), snippet: cleanText(r.fields?.trailText),
      outlet: 'The Guardian', url: r.webUrl || '', year: yearOf(r.webPublicationDate), weight: 4,
    }));
  }

  async function nyt(q, fromDate, toDate) {
    if (!process.env.NYT_API_KEY) return [];
    const params = new URLSearchParams({
      q, begin_date: fromDate.replace(/-/g, ''), end_date: toDate.replace(/-/g, ''), sort: 'relevance', 'api-key': process.env.NYT_API_KEY,
    });
    const res = await http(`https://api.nytimes.com/svc/search/v2/articlesearch.json?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`NYT ${res.status}`);
    const data = await res.json();
    return (data.response?.docs || []).map(r => ({
      title: cleanText(r.headline?.main || r.abstract), snippet: cleanText(r.abstract || r.lead_paragraph),
      outlet: 'New York Times', url: r.web_url || '', year: yearOf(r.pub_date), weight: 4,
    }));
  }

  async function googleNews(q, fromYear) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} after:${fromYear}-01-01`)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await http(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Verity/9.0)' } });
    if (!res.ok) throw new Error(`Google News ${res.status}`);
    return parseRssItems(await res.text()).map(it => {
      const dash = it.title.lastIndexOf(' - ');
      const title = dash > 20 ? it.title.slice(0, dash).trim() : it.title;
      const outlet = it.sourceName || (dash > 20 ? it.title.slice(dash + 3).trim() : 'News');
      // The <link> is a news.google.com redirect; the real outlet
      // domain is in <source url="…">.
      return { title, snippet: '', outlet, url: it.link, year: yearOf(it.date), weight: outletWeight(it.sourceUrl, outlet) };
    });
  }

  async function bingNews(q) {
    const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&count=30`;
    const res = await http(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Verity/9.0)' } });
    if (!res.ok) throw new Error(`Bing ${res.status}`);
    return parseRssItems(await res.text()).map(it => {
      const real = unwrapBing(it.link);
      return { title: it.title, snippet: it.desc.slice(0, 200), outlet: hostOf(real) || 'News', url: real, year: yearOf(it.date), weight: outletWeight(real) };
    });
  }

  // Full media pipeline. Returns { articles, stancePct, failures }.
  async function fetchMedia(client, frame, { deepMode = false } = {}) {
    const queries = await llm.mediaQueries(client, frame, deepMode);
    const fromYear = new Date().getFullYear() - 5;
    const fromDate = `${fromYear}-01-01`;
    const toDate = new Date().toISOString().slice(0, 10);

    // Fewer outbound requests than v8 (which sent ~25 per search and
    // risked being blocked): 2 sources × queries, plus NYT once.
    const jobs = queries.flatMap(q => [guardian(q, fromDate, toDate), googleNews(q, fromYear)]);
    jobs.push(bingNews(queries[0]), nyt(queries[0], fromDate, toDate));
    const settled = await Promise.allSettled(jobs);
    const failures = settled.filter(s => s.status === 'rejected').length;

    const seen = new Set();
    const subject = buildMatcher([...(frame.mediaSubjectTerms || []), ...frame.requiredTerms, ...frame.synonyms.slice(0, 6)]);
    const raw = settled.filter(s => s.status === 'fulfilled').flatMap(s => s.value).filter(a => {
      if (!a.title || a.title.length < 15) return false;
      if (a.year && a.year < fromYear) return false;
      const k = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 70);
      if (seen.has(k)) return false;
      seen.add(k);
      // Cheap deterministic pre-gate: the subject must be named.
      return subject.terms.length === 0 || subject.test(`${a.title} ${a.snippet}`);
    });

    const relevant = await llm.filterMedia(client, raw.slice(0, 60), frame);
    const maxN = deepMode ? 25 : 15;
    const thisYear = new Date().getFullYear();
    const ranked = relevant
      .map(a => ({ ...a, _rank: a.weight * 0.65 + Math.max(0, 1 - (thisYear - (a.year || thisYear - 5)) / 6) * 0.35 }))
      .sort((a, b) => b._rank - a._rank)
      .slice(0, maxN)
      .map(({ _rank, ...a }) => a);

    if (ranked.length < 3) return { articles: [], summary: null, failures, rawCount: raw.length };

    const stances = await llm.classifyMedia(client, ranked, frame).catch(() => []);
    const byIdx = new Map(stances.map(s => [Number(s.i), s]));
    const articles = ranked.map((a, i) => ({
      ...a,
      stance: ['harmful', 'beneficial', 'null', 'neutral'].includes(byIdx.get(i)?.stance) ? byIdx.get(i).stance : 'neutral',
      framing: String(byIdx.get(i)?.framing || ''),
    }));
    return { articles, summary: summariseMedia(articles), failures, rawCount: raw.length };
  }

  return { fetchMedia, guardian, googleNews, bingNews, nyt };
}

// Same construction as the science score so the two are comparable:
// outlet-weighted (beneficial − harmful) / all framed headlines.
function summariseMedia(articles) {
  let ben = 0, harm = 0, nul = 0;
  for (const a of articles) {
    if (a.stance === 'beneficial') ben += a.weight;
    else if (a.stance === 'harmful') harm += a.weight;
    else if (a.stance === 'null') nul += a.weight;
  }
  const denom = ben + harm + nul;
  const score = denom > 0 ? Math.round(100 * (ben - harm) / denom) : 0;
  const rightPct = Math.round((score + 100) / 2);
  return { score, rightPct, leftPct: 100 - rightPct, framed: articles.filter(a => a.stance !== 'neutral').length, total: articles.length };
}

module.exports = { makeMedia, summariseMedia, outletWeight, unwrapBing, parseRssItems, OUTLET_WEIGHTS };
