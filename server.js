// ═════════════════════════════════════════════════════════════════
//  Verity — Evidence Synthesis Engine  v6.0
//
//  ROOT CAUSE FIX (v5 → v6):
//    The v5 filter required any 2 words from the plain question.
//    "building" + "muscle" appeared in a JAK/STAT paper, so it passed.
//    "creatine" never needed to appear at all. That is the bug.
//
//    Fix: Claude now returns requiredTerms[] (the specific entity
//    that MUST appear in a paper's title or abstract) and synonyms[]
//    (alternative phrasings that also count). The filter is now a
//    hard deterministic check: if none of (requiredTerms ∪ synonyms)
//    appear in the paper text → REJECTED. No exceptions.
//
//  Full pipeline:
//    1. frameQuery      → PICO framing + requiredTerms + synonyms
//    2. fetchAll        → Semantic Scholar + PubMed + OpenAlex (parallel)
//    3. hardFilter      → DETERMINISTIC: requiredTerms/synonyms must appear
//    4. extractOutcomes → Claude extracts structured per-paper outcomes
//    5. computeConsensus→ DETERMINISTIC scoring: w=D×B×P×R×U, c=S×M×w
//    6. synthesize      → Claude writes prose AFTER scores are computed
//    7. media           → GDELT + framing analysis
// ═════════════════════════════════════════════════════════════════

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const crypto    = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool }  = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname)));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────────────
//  DATABASE — PostgreSQL cache layer
//  CONNECTION: Railway sets DATABASE_URL automatically when you
//  provision a Postgres instance. If not set, caching is skipped
//  gracefully and the pipeline runs fresh every time.
// ─────────────────────────────────────────────────────────────────
let db = null;

if (process.env.DATABASE_URL) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 5,
  });
  db.on('error', err => console.error('DB pool error:', err.message));
}

async function initDB() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS query_cache (
        id           SERIAL PRIMARY KEY,
        query_hash   CHAR(64) UNIQUE NOT NULL,
        query_raw    TEXT NOT NULL,
        query_plain  TEXT,
        result_json  JSONB NOT NULL,
        paper_count  INT,
        certainty    TEXT,
        score        INT,
        hit_count    INT DEFAULT 1,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_query_hash ON query_cache(query_hash);
      CREATE INDEX IF NOT EXISTS idx_updated    ON query_cache(updated_at);
    `);
    console.log('✓ DB cache table ready');
  } catch (e) {
    console.warn('DB init failed:', e.message);
    db = null; // disable cache if init fails
  }
}

// Normalise query for consistent cache hits
// "Is a vegan diet healthy?" and "vegan diet health" should share a cache key
function normaliseQuery(raw) {
  return raw.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(is|are|does|do|can|will|what|the|a|an|in|of|for|and|or|to|how)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .sort()      // order-independent: "diet vegan" = "vegan diet"
    .join(' ');
}

function queryHash(raw) {
  return crypto.createHash('sha256').update(normaliseQuery(raw)).digest('hex');
}

const CACHE_TTL_DAYS = 30;

async function getCached(raw) {
  if (!db) return null;
  try {
    const hash = queryHash(raw);
    const r = await db.query(
      `SELECT result_json, certainty, score, paper_count, created_at, hit_count
       FROM query_cache
       WHERE query_hash = $1
         AND updated_at > NOW() - INTERVAL '${CACHE_TTL_DAYS} days'`,
      [hash]
    );
    if (!r.rows.length) return null;
    // Increment hit count asynchronously
    db.query('UPDATE query_cache SET hit_count = hit_count + 1 WHERE query_hash = $1', [hash])
      .catch(() => {});
    console.log(`  ✓ CACHE HIT (${r.rows[0].hit_count + 1} hits, created ${r.rows[0].created_at.toISOString().slice(0,10)})`);
    return r.rows[0].result_json;
  } catch (e) {
    console.warn('Cache read error:', e.message);
    return null;
  }
}

async function setCached(raw, plain, result, scoring) {
  if (!db) return;
  try {
    const hash = queryHash(raw);
    await db.query(
      `INSERT INTO query_cache (query_hash, query_raw, query_plain, result_json, paper_count, certainty, score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (query_hash) DO UPDATE SET
         result_json = EXCLUDED.result_json,
         paper_count = EXCLUDED.paper_count,
         certainty   = EXCLUDED.certainty,
         score       = EXCLUDED.score,
         updated_at  = NOW(),
         hit_count   = query_cache.hit_count + 1`,
      [hash, raw, plain, JSON.stringify(result), result.meta?.paperCount || 0, scoring.certainty, scoring.score]
    );
    console.log('  ✓ Result cached');
  } catch (e) {
    console.warn('Cache write error:', e.message);
  }
}

// Admin: force-refresh a specific query
app.delete('/api/cache', async (req, res) => {
  if (!db) return res.json({ ok: false, reason: 'no database' });
  const { query, all } = req.body;
  if (all) {
    await db.query('DELETE FROM query_cache').catch(() => {});
    return res.json({ ok: true, action: 'cleared all' });
  }
  if (query) {
    await db.query('DELETE FROM query_cache WHERE query_hash = $1', [queryHash(query)]).catch(() => {});
    return res.json({ ok: true, action: `cleared: ${query}` });
  }
  res.status(400).json({ error: 'provide query or all:true' });
});

// Admin: inspect cache stats
app.get('/api/cache/stats', async (req, res) => {
  if (!db) return res.json({ enabled: false });
  try {
    const r = await db.query(`
      SELECT COUNT(*) as total,
             AVG(hit_count)::INT as avg_hits,
             MIN(created_at) as oldest,
             MAX(updated_at) as newest
      FROM query_cache
    `);
    const top = await db.query(`
      SELECT query_raw, certainty, score, hit_count, updated_at
      FROM query_cache ORDER BY hit_count DESC LIMIT 10
    `);
    res.json({ enabled: true, stats: r.rows[0], top_queries: top.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'verity.html')));
app.get('/health', async (_, res) => {
  const dbOk = db ? await db.query('SELECT 1').then(() => true).catch(() => false) : false;
  res.json({ ok: true, version: '7.0', cache: dbOk ? 'connected' : (db ? 'error' : 'disabled') });
});

// ─────────────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────────────
const stripHtml = str => String(str || '').replace(/<[^>]*>/g, '').trim();

function parseJSON(text) {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function dedupe(papers) {
  const byDoi   = new Map();
  const byTitle = new Map();
  const out     = [];
  for (const p of papers) {
    const doi   = (p.doi   || '').toLowerCase().trim();
    const title = (p.title || '').toLowerCase().trim().slice(0, 120);
    if (doi   && byDoi.has(doi))    continue;
    if (title && byTitle.has(title)) continue;
    if (doi)   byDoi.set(doi, true);
    if (title) byTitle.set(title, true);
    out.push(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
//  DESIGN PRIOR WEIGHTS  (starting prior — bias/precision adjust below)
// ─────────────────────────────────────────────────────────────────
const DESIGN_PRIOR = {
  umbrella:         0.95,
  meta:             0.90,
  rct:              0.78,
  cohort:           0.62,
  case_control:     0.50,
  cross_sectional:  0.35,
  obs:              0.40,
  narrative_review: 0.15,
  unknown:          0.38,
};

// ─────────────────────────────────────────────────────────────────
//  STEP 1 — PICO frame + search term generation
//
//  KEY CHANGE FROM v5:
//  Now generates requiredTerms[] (specific entity word that MUST
//  appear) and synonyms[] (alternative phrasings). These are used
//  by hardFilter() as a strict gate — not a soft score.
// ─────────────────────────────────────────────────────────────────
async function frameQuery(raw) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1100,
    system: 'You are a PICO-trained systematic review methodologist and biomedical search expert. Respond ONLY with valid JSON. No markdown, no explanation.',
    messages: [{
      role: 'user',
      content: `Frame this query as a structured evidence synthesis problem: "${raw}"

Return ONLY this JSON:
{
  "plain": "<the exact research question, specific and answerable>",
  "population":    "<who is being studied>",
  "intervention":  "<the specific exposure/treatment/substance being studied>",
  "comparator":    "<what it is compared against>",
  "outcomes":      ["<primary outcome 1>", "<primary outcome 2>", "<primary outcome 3>"],

  "requiredTerms": ["<the specific word that MUST appear in any relevant paper's title or abstract>"],
  "synonyms":      ["<alternative spelling or phrasing that is equally acceptable>", "..."],

  "searchTerms": {
    "semantic":  "<natural language, 4-7 words, topic-specific for Semantic Scholar>",
    "pubmed":    "<keyword query for PubMed esearch, use AND/OR, no field tags, no brackets around single terms>",
    "openAlex":  "<5-8 specific keywords>"
  },

  "gdeltQuery":    "<2-4 word news query>",
  "isDebatable":   <true if real scientific debate, false if near-consensus>,
  "leftClaim":     "<3-6 words: the skeptical/concern/null/harmful position>",
  "leftDesc":      "<8-12 words describing it>",
  "rightClaim":    "<3-6 words: the beneficial/positive/effective position>",
  "rightDesc":     "<8-12 words describing it>",
  "domain":        "<nutrition|pharmacology|exercise_science|mental_health|environmental|clinical|other>"
}

CRITICAL RULES FOR requiredTerms and synonyms:
requiredTerms must be the SPECIFIC IDENTIFYING WORD(S) for the intervention/topic.
This word must appear in virtually every directly relevant paper.
It is used as a HARD GATE: if none of (requiredTerms ∪ synonyms) appear in a paper → the paper is rejected.

Examples:
- "creatine muscle" → requiredTerms: ["creatine"], synonyms: ["creatine monohydrate", "creatine phosphate", "phosphocreatine"]
- "carnivore diet"  → requiredTerms: ["carnivore"], synonyms: ["all-meat diet", "meat-only diet", "zero carb diet", "zero-carb"]
- "vegan diet"      → requiredTerms: ["vegan"],     synonyms: ["plant-based diet", "plant based diet", "whole food plant"]
- "statins cholesterol" → requiredTerms: ["statin"], synonyms: ["atorvastatin", "rosuvastatin", "simvastatin", "hydroxymethylglutaryl"]
- "coffee cancer"   → requiredTerms: ["coffee"],    synonyms: ["caffeine", "coffeehouse", "espresso"]
- "intermittent fasting" → requiredTerms: ["fasting"], synonyms: ["intermittent fasting", "time-restricted", "time restricted eating", "16:8", "alternate day fasting"]
- "omega-3 heart"   → requiredTerms: ["omega-3"],   synonyms: ["omega 3", "n-3 fatty", "fish oil", "eicosapentaenoic", "EPA", "DHA"]

CRITICAL RULES FOR searchTerms:
- semantic: natural language, NOT a question, just key terms. "creatine supplementation muscle strength performance"
- pubmed: simple AND/OR without MeSH field tags. "creatine AND (muscle OR strength OR hypertrophy OR performance)"
- DO NOT use [MeSH Terms] or [Title/Abstract] field tags — they silently fail if wrong

CRITICAL RULES FOR isDebatable:
- false for: smoking causes cancer, vaccines are safe and effective, exercise improves health, creatine improves strength (near-consensus)
- true for: carnivore diet long-term safety, coffee and mortality, red meat cancer risk (genuine debate)`
    }]
  });
  return parseJSON(msg.content[0].text);
}

// ─────────────────────────────────────────────────────────────────
//  STEP 2 — Three parallel sources
// ─────────────────────────────────────────────────────────────────

// SOURCE A: Semantic Scholar — handles natural language, returns citation counts
async function fetchSemanticScholar(query, limit = 25) {
  const yearFrom = new Date().getFullYear() - 10;
  const url = 'https://api.semanticscholar.org/graph/v1/paper/search?' +
    new URLSearchParams({
      query,
      limit: String(limit),
      fields: 'title,abstract,year,journal,citationCount,externalIds,publicationTypes',
      publicationDateOrYear: `${yearFrom}-`,
    });

  const res = await fetch(url, {
    signal: AbortSignal.timeout(14000),
    headers: { 'User-Agent': 'Verity/6.0 (hello@verity.science)' }
  });

  if (res.status === 429) { console.warn('  S2: rate limited'); return []; }
  if (!res.ok) throw new Error(`S2 ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();

  return (data.data || [])
    .filter(p => p.abstract && p.abstract.length > 80)
    .map(p => {
      const types  = p.publicationTypes || [];
      const isMeta = types.some(t => ['Review', 'Meta-Analysis', 'SystematicReview'].includes(t));
      const isRCT  = types.some(t => t === 'ClinicalTrial');
      const cites = p.citationCount || 0;
      const citW  = cites >= 400 ? 5 : cites >= 150 ? 4 : cites >= 50 ? 3 : cites >= 10 ? 2 : 1;
      const design = isMeta ? 'meta' : isRCT ? 'rct' : 'unknown';
      return {
        title:     stripHtml(p.title || ''),
        abstract:  p.abstract,
        year:      p.year || 2020,
        journal:   p.journal?.name || 'Unknown',
        doi:       p.externalIds?.DOI    || null,
        pmid:      p.externalIds?.PubMed || null,
        citations: cites,
        weight:    Math.min(5, design === 'meta' ? citW + 1 : citW),
        design,
        source:    'semantic',
      };
    });
}

// SOURCE B: PubMed — simple keyword search, proper XML parsing
async function fetchPubMed(term, maxResults = 20, yearsBack = 10) {
  const minDate = (new Date().getFullYear() - yearsBack) + '/01/01';

  const sRes = await fetch(
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?' +
    new URLSearchParams({
      db: 'pubmed', term, retmax: String(maxResults),
      retmode: 'json', sort: 'relevance',
      mindate: minDate, datetype: 'pdat',
      tool: 'verity', email: 'hello@verity.science',
    }),
    { signal: AbortSignal.timeout(12000) }
  );
  if (!sRes.ok) throw new Error(`PubMed search ${sRes.status}`);
  const sData = await sRes.json();
  const ids = sData.esearchresult?.idlist || [];
  if (!ids.length) return [];

  const fRes = await fetch(
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?' +
    new URLSearchParams({
      db: 'pubmed', id: ids.join(','),
      retmode: 'xml', rettype: 'abstract',
      tool: 'verity', email: 'hello@verity.science',
    }),
    { signal: AbortSignal.timeout(14000) }
  );
  if (!fRes.ok) throw new Error(`PubMed fetch ${fRes.status}`);
  return parsePubMedXML(await fRes.text());
}

function parsePubMedXML(xml) {
  const papers = [];
  for (const m of xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)) {
    const a = m[1];
    const titleM = a.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/);
    const title  = titleM ? stripHtml(titleM[1]).replace(/\.$/, '') : '';
    if (!title) continue;

    const abstract = [...a.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)]
      .map(x => stripHtml(x[1])).join(' ').trim();
    if (abstract.length < 80) continue;

    const yearM  = a.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);
    const jM     = a.match(/<ISOAbbreviation>([\s\S]*?)<\/ISOAbbreviation>/) ||
                   a.match(/<Title>([\s\S]*?)<\/Title>/);
    const doiM   = a.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/);
    const pmidM  = a.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pubTypes = [...a.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)]
      .map(x => x[1].trim());

    const isMeta = pubTypes.some(t => /systematic review|meta.?analysis/i.test(t));
    const isRCT  = pubTypes.some(t => /randomized controlled trial|clinical trial/i.test(t));
    const isCohort = pubTypes.some(t => /observational|cohort/i.test(t));

    const pmDesign = isMeta ? 'meta' : isRCT ? 'rct' : isCohort ? 'cohort' : 'unknown';
    papers.push({
      title, abstract,
      year:      yearM ? parseInt(yearM[1]) : 2020,
      journal:   jM ? stripHtml(jM[1]) : 'Unknown',
      doi:       doiM  ? doiM[1].trim()  : null,
      pmid:      pmidM ? pmidM[1]        : null,
      citations: 0,
      weight:    pmDesign === 'meta' ? 4 : pmDesign === 'rct' ? 3 : 2,
      design:    pmDesign,
      source:    'pubmed',
    });
  }
  return papers;
}

// SOURCE C: OpenAlex — broadest coverage
async function fetchOpenAlex(query, limit = 15) {
  const yearFrom = new Date().getFullYear() - 10;
  const params = new URLSearchParams({
    search:     query,
    filter:     `publication_year:${yearFrom}-${new Date().getFullYear()},has_abstract:true`,
    sort:       'relevance_score:desc',
    'per-page': String(limit),
    select:     'id,title,abstract_inverted_index,publication_year,primary_location,cited_by_count,doi,type',
    mailto:     'hello@verity.science',
  });

  const res = await fetch(`https://api.openalex.org/works?${params}`,
    { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = await res.json();

  return (data.results || []).map(w => {
    const pos = [];
    if (w.abstract_inverted_index)
      for (const [word, locs] of Object.entries(w.abstract_inverted_index))
        for (const l of locs) pos[l] = word;
    const abstract = pos.filter(Boolean).join(' ').trim();
    if (abstract.length < 80) return null;
    const isReview = (w.type || '').toLowerCase().includes('review');
    const oaCites  = w.cited_by_count || 0;
    const oaCitW   = oaCites >= 400 ? 5 : oaCites >= 150 ? 4 : oaCites >= 50 ? 3 : oaCites >= 10 ? 2 : 1;
    const oaDesign = isReview ? 'meta' : 'unknown';
    return {
      title:     stripHtml(w.title || ''),
      abstract,
      year:      w.publication_year || 2020,
      journal:   stripHtml(w.primary_location?.source?.display_name || 'Unknown'),
      doi:       w.doi ? w.doi.replace('https://doi.org/', '') : null,
      pmid:      null,
      citations: oaCites,
      weight:    Math.min(5, oaDesign === 'meta' ? oaCitW + 1 : oaCitW),
      design:    oaDesign,
      source:    'openalex',
    };
  }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────
//  STEP 3 — HARD DETERMINISTIC FILTER
//
//  THE FIX: at least one of (requiredTerms ∪ synonyms) MUST appear
//  in the paper's title + abstract. No exceptions. No LLM.
//
//  This is the exact bug that produced JAK/STAT for creatine:
//    v5 required any 2 words from plain question
//    "building" + "muscle" appeared in JAK/STAT paper → passed
//    "creatine" never needed to appear → bug
//
//  v6 requires the specific entity word → JAK/STAT has no "creatine"
//  → rejected immediately regardless of citation count.
// ─────────────────────────────────────────────────────────────────
function hardFilter(papers, frame) {
  const required = (frame.requiredTerms || []).map(t => t.toLowerCase().trim());
  const synonyms = (frame.synonyms      || []).map(t => t.toLowerCase().trim());
  const allTerms = [...new Set([...required, ...synonyms])].filter(t => t.length > 1);

  if (allTerms.length === 0) {
    // Safety: if Claude failed to generate terms, use intervention word
    const fallback = (frame.intervention || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    allTerms.push(...fallback);
  }

  const filtered = papers.filter(p => {
    const text = (p.title + ' ' + p.abstract).toLowerCase();
    // HARD RULE: at least one required/synonym term must appear
    return allTerms.some(term => text.includes(term));
  });

  console.log(`  Filter: ${papers.length} → ${filtered.length} papers`);
  console.log(`  Required terms: [${allTerms.slice(0,5).join(', ')}]`);

  // Log rejections for the first few to verify correctness
  const rejected = papers.filter(p => {
    const text = (p.title + ' ' + p.abstract).toLowerCase();
    return !allTerms.some(term => text.includes(term));
  }).slice(0, 3);
  if (rejected.length) {
    console.log('  Rejected (sample):');
    rejected.forEach(p => console.log(`    ✗ "${p.title.slice(0, 70)}"`));
  }

  return filtered;
}

// ─────────────────────────────────────────────────────────────────
//  STEP 4 — Claude: structured outcome extraction
//  Claude's ONLY role: extract what each paper actually found.
//  No scoring. No percentages. Pure extraction.
// ─────────────────────────────────────────────────────────────────
async function extractOutcomes(papers, frame) {
  const BATCH_SIZE = 8;
  const allExtractions = [];

  for (let i = 0; i < papers.length; i += BATCH_SIZE) {
    const batch = papers.slice(i, i + BATCH_SIZE);
    const block = batch.map((p, j) => {
      const ref = p.doi  ? `doi:${p.doi}`  :
                  p.pmid ? `pmid:${p.pmid}` :
                  `paper-${i + j + 1}`;
      return `[${i + j + 1}] REF:${ref}\nTitle: ${p.title}\nJournal: ${p.journal} (${p.year})\nAbstract: ${p.abstract.slice(0, 800)}`;
    }).join('\n\n───\n\n');

    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2400,
      system:     'Systematic review data extractor. Extract exactly what is stated in each abstract. Do not add interpretation beyond what is written. Respond ONLY with valid JSON.',
      messages: [{
        role: 'user',
        content: `Extract structured outcome data from these papers.

Query: "${frame.plain}"
Left claim: "${frame.leftClaim}"
Right claim: "${frame.rightClaim}"
Outcomes of interest: ${(frame.outcomes || []).join(', ')}

PAPERS:
${block}

Return ONLY:
{
  "extractions": [
    {
      "ref":                "<REF value from paper header>",
      "design":             "<umbrella|meta|rct|cohort|cross_sectional|case_control|narrative_review|obs|unknown>",
      "sampleSize":         <integer total N or null if not stated>,
      "populationMatch":    <0.0-1.0: 1.0=exactly the population the query is about, 0.5=related, 0.1=different population>,
      "interventionMatch":  <0.0-1.0: 1.0=paper directly studies the exact intervention in the query, 0.5=related, 0.1=tangential>,
      "fundingConcern":     <true only if abstract explicitly states industry funding with clear commercial conflict>,
      "outcomes": [
        {
          "name":      "<outcome name>",
          "direction": "<supports_right|supports_left|neutral|mixed>",
          "magnitude": <0.0-1.0: extract from effect sizes if mentioned. 0=null/trivial, 0.3=small, 0.5=moderate, 0.8=large, 1.0=very large>,
          "precision": <0.0-1.0: 0.9=large n+narrow CI stated, 0.6=moderate n, 0.3=small n or wide CI, 0.1=no uncertainty stated>,
          "note":      "<one sentence: the exact finding with numbers if available, e.g. 'Creatine increased lean mass by 1.37 kg (95% CI 0.97-1.77) vs placebo'>"
        }
      ]
    }
  ]
}

DESIGN CLASSIFICATION RULES (be accurate):
- meta: "systematic review", "meta-analysis", "pooled analysis" in abstract
- rct: "randomized", "randomised", "double-blind", "placebo-controlled"
- cohort: "prospective cohort", "longitudinal", "follow-up study"
- cross_sectional: "cross-sectional", "survey"
- obs: "observational" without specifying type
- narrative_review: "review" without systematic/meta

DIRECTION RULES:
- supports_right: paper shows the intervention has positive/beneficial effects on this outcome
- supports_left: paper shows harm, null effect, or that the concern is valid
- neutral: no difference found, p>0.05 on primary outcome
- mixed: paper reports both positive and negative effects on same outcome

MAGNITUDE: use stated effect sizes. If none stated, use language: "significantly improved/reduced" → 0.6, "modest improvement" → 0.35, "no significant difference" → 0.05, "trend toward" → 0.15`
      }]
    });

    try {
      const parsed = parseJSON(msg.content[0].text);
      allExtractions.push(...(parsed.extractions || []));
    } catch (e) {
      console.warn(`  Extraction batch ${i}–${i + BATCH_SIZE} failed:`, e.message);
    }
  }

  return allExtractions;
}

// ─────────────────────────────────────────────────────────────────
//  STEP 5 — DETERMINISTIC SCORING ENGINE
//  No LLM below this line.
//  Formula: w_i = D×B×P×R×U | c_i = S×M×w_i
// ─────────────────────────────────────────────────────────────────

function biasWeight(design, fundingConcern) {
  const base = {
    umbrella:         0.90,
    meta:             0.85,
    rct:              0.80,
    cohort:           0.70,
    case_control:     0.60,
    cross_sectional:  0.48,
    obs:              0.55,
    narrative_review: 0.18,
    unknown:          0.52,
  }[design] || 0.52;
  return fundingConcern ? base * 0.68 : base;
}

function precisionWeight(sampleSize, abstractPrecision) {
  // Weight from extracted precision score, adjusted by sample size if known
  const base = Math.max(0.1, Math.min(1.0, abstractPrecision || 0.5));
  if (!sampleSize) return base * 0.88; // slight penalty for unstated N
  if (sampleSize >= 10000) return Math.min(1.0, base + 0.08);
  if (sampleSize >= 1000)  return base;
  if (sampleSize >= 200)   return Math.max(0.15, base - 0.12);
  if (sampleSize >= 50)    return Math.max(0.10, base - 0.22);
  return Math.max(0.08, base - 0.35); // very small study
}

function directionScore(direction) {
  return { supports_right: 1.0, supports_left: -1.0, neutral: 0.0, mixed: 0.15 }[direction] ?? 0.0;
}

function computeConsensus(extractions) {
  if (!extractions.length) {
    return { score: 0, rightPct: 50, leftPct: 50, certainty: 'Very low', contradiction: 0, contributions: [], evidenceCount: 0 };
  }

  // Independence weights: penalise papers from the same design/year cluster
  // (proxy for overlapping research families)
  const familyCounts = new Map();
  const independenceWeight = extractions.map(ex => {
    const key = `${ex.design || 'unk'}_${Math.floor(((ex.year || 2020) - 2000) / 3)}`;
    const n = (familyCounts.get(key) || 0) + 1;
    familyCounts.set(key, n);
    // First paper from family = 1.0, second = 0.70, third+ = 0.45
    return n === 1 ? 1.0 : n === 2 ? 0.70 : 0.45;
  });

  const contributions = [];
  let weightedSum  = 0;
  let totalWeight  = 0;
  let leftMass     = 0;
  let rightMass    = 0;
  let qualitySum   = 0;
  let qualityCount = 0;

  extractions.forEach((ex, idx) => {
    if (!ex.outcomes?.length) return;

    const D = DESIGN_PRIOR[ex.design] || DESIGN_PRIOR.unknown;
    const B = biasWeight(ex.design, ex.fundingConcern);
    const U = independenceWeight[idx];

    ex.outcomes.forEach(outcome => {
      if (!outcome || !outcome.direction || outcome.direction === 'unclear') return;

      const S  = directionScore(outcome.direction);
      const M  = Math.max(0.05, Math.min(1.0, outcome.magnitude  || 0.30));
      const P  = precisionWeight(ex.sampleSize, outcome.precision || 0.50);
      // Relevance: weighted combination of population and intervention match
      const R  = Math.max(0.05, Math.min(1.0,
        (ex.populationMatch   || 0.5) * 0.40 +
        (ex.interventionMatch || 0.5) * 0.60
      ));

      const w = D * B * P * R * U;
      const c = S * M * w;

      weightedSum  += c;
      totalWeight  += Math.abs(w * M);
      qualitySum   += w;
      qualityCount += 1;

      if (S < -0.1) leftMass  += Math.abs(c);
      if (S >  0.1) rightMass += Math.abs(c);

      contributions.push({
        ref:         ex.ref,
        design:      ex.design,
        outcome:     outcome.name,
        direction:   outcome.direction,
        S, M, D, B, P, R, U,
        weight:      parseFloat(w.toFixed(4)),
        contribution: parseFloat(c.toFixed(4)),
        note:        outcome.note,
      });
    });
  });

  // Bounded consensus score [-100, +100]
  const score = totalWeight > 0 ? Math.round(100 * weightedSum / totalWeight) : 0;

  // Convert to rightPct: 0→0%, +100→100%, centre at 50%
  const rightPct = Math.min(99, Math.max(1, Math.round((score + 100) / 2)));
  const leftPct  = 100 - rightPct;

  // Contradiction index (Gini-style): 0 = one-sided, 1 = perfectly split
  const totalMass    = leftMass + rightMass || 1;
  const contradiction = parseFloat((2 * leftMass * rightMass / (totalMass * totalMass)).toFixed(3));

  // Certainty: function of quality × agreement × evidence volume
  const meanQuality = qualityCount > 0 ? qualitySum / qualityCount : 0;
  const agreement   = 1 - contradiction;
  const volume      = Math.min(1.0, qualityCount / 12);
  const rawCertainty = meanQuality * Math.pow(agreement, 0.5) * Math.pow(volume, 0.4);

  const certainty =
    rawCertainty > 0.58 && qualityCount >= 8  ? 'High'     :
    rawCertainty > 0.36 && qualityCount >= 4  ? 'Moderate' :
    rawCertainty > 0.18                        ? 'Low'      : 'Very low';

  // Directional confidence: how consistently does the evidence point one way?
  // High = strong signal, mostly one direction; Low = mixed or sparse
  const absScore = Math.abs(score);
  const directionalConf =
    absScore >= 70 && contradiction < 0.15 ? 'Strong'   :
    absScore >= 50 && contradiction < 0.30 ? 'Moderate' :
    absScore >= 30                          ? 'Mixed'    : 'Inconclusive';

  // Design mix: what proportion are meta-analyses or RCTs?
  const highDesignCount = contributions.filter(c =>
    ['umbrella','meta','rct'].includes(c.design)
  ).length;
  const designQuality = qualityCount > 0
    ? (highDesignCount / qualityCount >= 0.4 ? 'RCT/meta-dominant'
      : highDesignCount / qualityCount >= 0.2 ? 'mixed designs'
      : 'mostly observational')
    : 'unknown';

  // Top evidence drivers sorted by absolute contribution
  const topDrivers = [...contributions]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 6);

  return { score, rightPct, leftPct, certainty, directionalConf, designQuality, contradiction, evidenceCount: qualityCount, topDrivers, contributions };
}

// ─────────────────────────────────────────────────────────────────
//  STEP 6 — Plain-language synthesis
//  Claude receives SCORED OUTPUT and writes prose.
//  It cannot invent numbers — they all come from the scoring engine.
// ─────────────────────────────────────────────────────────────────
async function synthesize(frame, papers, scoring) {
  const drivers = scoring.topDrivers.map(d =>
    `• [${d.design.toUpperCase()}] ${d.outcome}: ${d.direction} — ${d.note}`
  ).join('\n');

  const paperList = papers.slice(0, 12).map((p, i) =>
    `[${i+1}] ${p.title} (${p.journal}, ${p.year}, design: ${p.design || 'unknown'})`
  ).join('\n');

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1800,
    system: 'Scientific synthesis writer. Write clean HTML prose. Never use bullet points. Be specific about what the evidence shows and does not show. Proportion uncertainty to the certainty level given.',
    messages: [{
      role: 'user',
      content: `Write a plain-language evidence synthesis for: "${frame.plain}"

Deterministic scoring results (computed facts — do not override these):
- Consensus direction: ${scoring.score > 5 ? 'leans toward ' + frame.rightClaim : scoring.score < -5 ? 'leans toward ' + frame.leftClaim : 'genuinely mixed or neutral'}
- Raw score: ${scoring.score} (scale: -100 = strongly left, 0 = neutral, +100 = strongly right)
- Directional confidence: ${scoring.directionalConf} (how consistently evidence points one way)
- Causal certainty: ${scoring.certainty} (quality of study designs — mostly reflects RCT vs observational)
- Design quality: ${scoring.designQuality} (what types of studies make up the evidence base)
- Contradiction index: ${scoring.contradiction.toFixed(2)} (0=one-sided evidence, 1=evenly split — real disagreement)
- Scored outcome results: ${scoring.evidenceCount}

Top evidence drivers (highest-weighted findings):
${drivers}

Papers analysed:
${paperList}

Write 2–3 paragraphs of HTML. Be calibrated — match the tone to the ACTUAL evidence pattern, not a generic uncertainty formula.

Certainty in this context means CAUSAL certainty (can we establish mechanism/causation), NOT whether the association is real.
Directional confidence means how consistently the studies point one way.

These are different things. A topic can have STRONG directional confidence + LOW causal certainty (e.g. coffee and mortality: very consistent association across millions of people, but mostly observational so causation unproven). Say THAT — do not say "we don't know."

- Paragraph 1: What the evidence consistently shows. If directional confidence is Strong or Moderate, say so plainly. Cite specific numbers from top drivers.
- Paragraph 2: What KIND of uncertainty exists. Is it "few studies"? "only observational"? "conflicting high-quality studies"? Name the specific limitation, not a generic hedge.
- Paragraph 3: What this evidence does NOT establish (causation vs association, optimal dose, specific populations etc.) and what study design would change the picture.

Rules:
- Use <strong> for key findings and specific numbers
- NEVER use bullet points
- NEVER invent numbers not in the drivers
- If directional confidence is Strong: open with confident language ("The evidence consistently shows...")
- If certainty is Very low due to design (observational only): say "association is consistent but causation unproven" — NOT "we don't know"
- If certainty is Very low due to sparse evidence: say "limited evidence available" — different framing
- Reserve "genuinely uncertain" for topics where contradiction > 0.3 (real disagreement in the literature)`
    }]
  });

  return msg.content[0].text.trim();
}

// ─────────────────────────────────────────────────────────────────
//  STEP 6b — Plain-language verdict (one sentence + one follow-up)
//  The "bottom line" above the synthesis text.
//  Written in first-person, practical, honest — not clinical.
// ─────────────────────────────────────────────────────────────────
async function generateVerdict(frame, scoring) {
  const dirConf   = scoring.directionalConf;
  const certainty = scoring.certainty;
  const design    = scoring.designQuality;
  const score     = scoring.score;
  const contradict = scoring.contradiction;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 200,
    system: 'You write one-line practical verdicts on scientific topics. You are honest, warm, and direct — like a trusted doctor friend who gives you the real answer, not the defensive one. Never use jargon. Never hedge unnecessarily. Never start with "I".',
    messages: [{
      role: 'user',
      content: `Write a bottom-line verdict for this question: "${frame.plain}"

Evidence summary:
- Score: ${score}/100 toward "${score > 0 ? frame.rightClaim : frame.leftClaim}"
- Directional confidence: ${dirConf} (how consistently evidence points one way)
- Causal certainty: ${certainty} (quality of study designs)
- Design quality: ${design}
- Contradiction: ${contradict.toFixed(2)} (0=one-sided, 1=perfectly split)

Write exactly TWO sentences. Nothing more.

Sentence 1: The practical bottom line. What should a reasonable person DO or BELIEVE based on this evidence? Be direct. If the signal is strong, say so. If it is weak or mixed, say that.
Sentence 2: The key honest caveat — what we know vs what we still don't, in plain English.

Examples of the right tone:
- "You can probably keep drinking coffee in good conscience — consistent evidence across millions of people links it to lower mortality risk. That said, almost all of it is observational, so we know the pattern without fully understanding the cause."
- "The evidence against high red meat intake is about as solid as nutritional epidemiology gets. It doesn't prove causation, but 'probably linked to higher cancer risk' is the honest read."
- "The evidence here is genuinely mixed — high-quality studies disagree, not just small ones. Hold this one loosely."

Now write the verdict for "${frame.plain}". Two sentences. Honest. Approachable.`
    }]
  });
  return msg.content[0].text.trim();
}

// ─────────────────────────────────────────────────────────────────
//  MEDIA: 5-year news search — same window as science
//
//  Three sources, all supporting date-range queries:
//    1. The Guardian API    — free "test" key, full archive, date range
//    2. NYT Article Search  — free key, full archive, date range
//    3. Google News RSS     — date operators in query string
//
//  Results ranked by: outlet credibility × relevance × recency
//  Best 15 selected for Claude framing analysis.
// ─────────────────────────────────────────────────────────────────

const OUTLET_WEIGHTS = {
  'theguardian.com': 4, 'nytimes.com': 4, 'bbc.co.uk': 4, 'bbc.com': 4,
  'reuters.com': 4, 'washingtonpost.com': 4, 'nature.com': 4,
  'science.org': 4, 'nejm.org': 4, 'thelancet.com': 4, 'bmj.com': 4,
  'statnews.com': 3, 'newscientist.com': 3, 'sciencedaily.com': 3,
  'healthline.com': 3, 'medicalnewstoday.com': 3, 'time.com': 3,
  'theatlantic.com': 3, 'vox.com': 3, 'webmd.com': 3,
  'dailymail.co.uk': 2, 'nypost.com': 2, 'foxnews.com': 2,
  'huffingtonpost.com': 2, 'huffpost.com': 2,
};

function domainWeight(url) {
  if (!url) return 2;
  try {
    const host = new URL(url).hostname.replace('www.', '');
    for (const [domain, w] of Object.entries(OUTLET_WEIGHTS)) {
      if (host.endsWith(domain)) return w;
    }
  } catch {}
  return 2;
}

// Score an article's relevance to required terms (0-1)
function relevanceScore(title, snippet, requiredTerms, synonyms) {
  const text = ((title || '') + ' ' + (snippet || '')).toLowerCase();
  const allTerms = [...(requiredTerms || []), ...(synonyms || [])].map(t => t.toLowerCase());
  if (allTerms.length === 0) return 0.5;
  const matches = allTerms.filter(t => text.includes(t)).length;
  return Math.min(1, matches / Math.max(1, allTerms.length) * 2);
}

// ── SOURCE 1: The Guardian Open Platform ─────────────────────────
// Free "test" API key — works for all basic searches, full archive
// Docs: https://open-platform.theguardian.com/
async function fetchGuardian(searchQuery, fromDate, toDate, frame) {
  const apiKey = process.env.GUARDIAN_API_KEY || 'test';
  const params = new URLSearchParams({
    q:          searchQuery,
    'from-date': fromDate,
    'to-date':   toDate,
    'order-by':  'relevance',
    'page-size': '30',
    'show-fields': 'headline,trailText,publicationDate',
    'api-key':   apiKey,
  });

  const res = await fetch(
    `https://content.guardianapis.com/search?${params}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Guardian ${res.status}`);
  const data = await res.json();

  return (data.response?.results || []).map(r => ({
    title:   stripHtml(r.webTitle || r.fields?.headline || ''),
    snippet: stripHtml(r.fields?.trailText || ''),
    outlet:  'The Guardian',
    url:     r.webUrl || '',
    year:    r.webPublicationDate ? parseInt(r.webPublicationDate.slice(0, 4)) : 2023,
    weight:  4,
  })).filter(a => a.title.length > 15);
}

// ── SOURCE 2: NYT Article Search ─────────────────────────────────
// Free key (500 req/day). Get one at: https://developer.nytimes.com/
// Without key: gracefully skipped
async function fetchNYT(searchQuery, fromDate, toDate, frame) {
  const apiKey = process.env.NYT_API_KEY;
  if (!apiKey) return [];

  // NYT uses YYYYMMDD format
  const begin = fromDate.replace(/-/g, '');
  const end   = toDate.replace(/-/g, '');
  const params = new URLSearchParams({
    q:          searchQuery,
    begin_date: begin,
    end_date:   end,
    sort:       'relevance',
    'api-key':  apiKey,
  });

  const res = await fetch(
    `https://api.nytimes.com/svc/search/v2/articlesearch.json?${params}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`NYT ${res.status}`);
  const data = await res.json();

  return (data.response?.docs || []).map(r => ({
    title:   stripHtml(r.headline?.main || r.abstract || ''),
    snippet: stripHtml(r.abstract || r.lead_paragraph || ''),
    outlet:  'New York Times',
    url:     r.web_url || '',
    year:    r.pub_date ? parseInt(r.pub_date.slice(0, 4)) : 2023,
    weight:  4,
  })).filter(a => a.title.length > 15);
}

// ── SOURCE 3: Google News RSS with date operators ─────────────────
// Google News supports after: and before: date operators
// Returns results from the specified date window
async function fetchGoogleNewsDateRange(searchQuery, fromYear) {
  // Google News date operator: after:YYYY-MM-DD
  const dateQuery = `${searchQuery} after:${fromYear}-01-01`;
  const q   = encodeURIComponent(dateQuery);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;

  const res = await fetch(url, {
    signal:  AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Verity/6.0; +https://verity.science)',
      'Accept':     'application/rss+xml, text/xml',
    }
  });
  if (!res.ok) throw new Error(`Google News ${res.status}`);
  const xml = await res.text();

  const items = [];
  for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
    const b     = m[1];
    const titleM = b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkM  = b.match(/<link[^>]*>(https?:[^\s<"]+)/);
    const dateM  = b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);
    const srcM   = b.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const raw    = titleM ? stripHtml(titleM[1]).trim() : '';
    if (raw.length < 15) continue;
    // Google News appends " - Outlet Name" to title
    const dashIdx = raw.lastIndexOf(' - ');
    const title  = dashIdx > 20 ? raw.slice(0, dashIdx).trim() : raw;
    const outlet = dashIdx > 20 ? raw.slice(dashIdx + 3).trim() : (srcM ? stripHtml(srcM[1]) : 'News');
    const url2   = linkM ? linkM[1].trim() : '';
    const year   = dateM ? (new Date(dateM[1]).getFullYear() || 2023) : 2023;
    items.push({
      title, outlet, url: url2, year,
      weight: domainWeight(url2),
      snippet: '',
    });
  }
  return items;
}

// ── SOURCE 4: Bing News RSS with date range ───────────────────────
async function fetchBingNewsDateRange(searchQuery, fromYear) {
  const q   = encodeURIComponent(`${searchQuery} after:${fromYear}`);
  const url = `https://www.bing.com/news/search?q=${q}&format=rss&count=30`;

  const res = await fetch(url, {
    signal:  AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Verity/6.0)' }
  });
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  const xml = await res.text();

  const items = [];
  for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
    const b     = m[1];
    const titleM = b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkM  = b.match(/<link[^>]*>(https?:[^\s<"]+)/);
    const descM  = b.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    const dateM  = b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);
    const title  = titleM ? stripHtml(titleM[1]).trim() : '';
    if (title.length < 15) continue;
    const url2   = linkM ? linkM[1].trim() : '';
    const year   = dateM ? (new Date(dateM[1]).getFullYear() || 2023) : 2023;
    items.push({
      title, outlet: 'News', url: url2, year,
      weight: domainWeight(url2),
      snippet: descM ? stripHtml(descM[1]).slice(0, 200) : '',
    });
  }
  return items;
}

// ── RANKING: score + select best articles ────────────────────────
function rankAndSelect(articles, frame, maxCount = 15) {
  const required = frame.requiredTerms || [];
  const synonyms = frame.synonyms      || [];
  const fromYear = new Date().getFullYear() - 5;

  return articles
    .filter(a => a.title && a.title.length > 15)
    .filter(a => a.year >= fromYear) // enforce 5-year window
    .map(a => {
      const rel     = relevanceScore(a.title, a.snippet, required, synonyms);
      const recency = Math.max(0, 1 - (new Date().getFullYear() - a.year) / 6);
      const score   = a.weight * rel * 0.65 + a.weight * 0.2 + recency * 0.15;
      return { ...a, _score: score, _rel: rel };
    })
    .filter(a => a._rel > 0) // must have keyword match
    .sort((a, b) => b._score - a._score)
    .slice(0, maxCount);
}

// ── MAIN: fetchMedia ──────────────────────────────────────────────
async function fetchMedia(frame) {
  const fromYear = new Date().getFullYear() - 5;
  const fromDate = `${fromYear}-01-01`;
  const toDate   = new Date().toISOString().slice(0, 10);

  // Build search query from required terms + synonyms
  const primary  = (frame.requiredTerms || []).slice(0, 2).join(' ');
  const altTerms = (frame.synonyms      || []).slice(0, 2).join(' OR ');
  const searchQ  = altTerms ? `(${primary}) OR (${altTerms})` : primary || frame.gdeltQuery || '';

  console.log(`  Media search: "${searchQ}" (${fromDate} → ${toDate})`);

  // Fetch all sources in parallel
  const [guardianRes, nytRes, googleRes, bingRes] = await Promise.allSettled([
    fetchGuardian(searchQ, fromDate, toDate, frame),
    fetchNYT(searchQ, fromDate, toDate, frame),
    fetchGoogleNewsDateRange(searchQ, fromYear),
    fetchBingNewsDateRange(searchQ, fromYear),
  ]);

  const log = (r, n) => r.status === 'fulfilled' ? `${n}:${r.value.length}` : `${n}:ERR(${r.reason?.message?.slice(0,20)})`;
  console.log(`  Media raw: ${log(guardianRes,'Guardian')} ${log(nytRes,'NYT')} ${log(googleRes,'Google')} ${log(bingRes,'Bing')}`);

  const all = [
    ...(guardianRes.status === 'fulfilled' ? guardianRes.value : []),
    ...(nytRes.status      === 'fulfilled' ? nytRes.value      : []),
    ...(googleRes.status   === 'fulfilled' ? googleRes.value   : []),
    ...(bingRes.status     === 'fulfilled' ? bingRes.value     : []),
  ];

  // Dedupe by normalised title
  const seen = new Set();
  const deduped = all.filter(a => {
    const k = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 70);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // Rank and select best
  const ranked = rankAndSelect(deduped, frame, 15);
  console.log(`  Media: ${deduped.length} deduped → ${ranked.length} ranked & selected`);

  if (ranked.length >= 3) return ranked;

  // Last resort: GDELT
  console.log('  Trying GDELT fallback...');
  try {
    const sd = fromDate.replace(/-/g, '') + '000000';
    const params = new URLSearchParams({ query: `${searchQ} sourcelang:english`, mode: 'artlist', maxrecords: '25', format: 'json', STARTDATETIME: sd, sort: 'relevance' });
    const res = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const gdelt = (data.articles || []).filter(a => a.title?.length > 20).slice(0, 15)
        .map(a => ({ title: stripHtml(a.title), outlet: a.domain || 'Unknown', url: a.url || '', year: a.seendate ? parseInt(a.seendate.slice(0,4)) : 2023, weight: 2, snippet: '' }));
      const combined = rankAndSelect([...ranked, ...gdelt], frame, 15);
      console.log(`  GDELT added ${gdelt.length}, final: ${combined.length}`);
      return combined;
    }
  } catch (e) { console.warn(`  GDELT: ${e.message}`); }

  return ranked;
}


async function analyzeMedia(plain, articles, frame) {
  if (!articles || articles.length === 0) return { stances: [], leftPct: 50, rightPct: 50 };
  const block = articles.map((a, i) => `[${i}] "${a.title}" — ${a.outlet}`).join('\n');
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1200,
    system: 'Media framing analyst. Respond ONLY with valid JSON.',
    messages: [{
      role: 'user',
      content: `Topic: "${plain}"\nConcern framing: "${frame.leftClaim}" | Benefit framing: "${frame.rightClaim}"\n\nAnalyze how each headline frames the science. Headlines from major news outlets:\n${block}\n\nReturn ONLY:\n{\n  "stances": [{"index":<n>,"stance":"<pro|con|neutral>","framing":"<one sentence: specific angle this headline takes>","weight":<1-4>}],\n  "leftPct":<0-100, weighted % leaning concern/skeptical>,\n  "rightPct":<0-100, sums to 100>\n}`
    }]
  });
  const p = parseJSON(msg.content[0].text);
  if (p.leftPct != null) p.rightPct = 100 - p.leftPct;
  return p;
}

// ─────────────────────────────────────────────────────────────────
//  MAIN ENDPOINT
// ─────────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query, forceRefresh } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'query is required' });

  const t0 = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[${new Date().toISOString()}] "${query}"`);

  // ── CACHE CHECK ──────────────────────────────────────────────
  if (!forceRefresh) {
    const cached = await getCached(query);
    if (cached) {
      cached.meta = { ...cached.meta, fromCache: true, durationMs: Date.now() - t0 };
      return res.json(cached);
    }
  }
  console.log('  Cache miss — running full pipeline...');

  try {
    // ── 1. Frame the query ────────────────────────────────────────
    const frame = await frameQuery(query);
    console.log(`  Plain:     "${frame.plain}"`);
    console.log(`  Required:  [${(frame.requiredTerms || []).join(', ')}]`);
    console.log(`  Synonyms:  [${(frame.synonyms || []).slice(0,4).join(', ')}]`);
    console.log(`  S2 query:  "${frame.searchTerms?.semantic}"`);
    console.log(`  PM query:  "${frame.searchTerms?.pubmed}"`);

    // ── 2. Fetch all sources + GDELT in parallel ──────────────────
    const [s2Res, pmRes, oaRes, gdeltRes] = await Promise.allSettled([
      fetchSemanticScholar(frame.searchTerms?.semantic || query, 25),
      fetchPubMed(frame.searchTerms?.pubmed || query, 20, 10),
      fetchOpenAlex(frame.searchTerms?.openAlex || query, 15),
      fetchMedia(frame),
    ]);

    const log = (r, name) => r.status === 'fulfilled'
      ? `${name}:${r.value.length}`
      : `${name}:ERR(${r.reason?.message?.slice(0,30)})`;
    console.log(`  Sources: ${log(s2Res,'S2')} ${log(pmRes,'PM')} ${log(oaRes,'OA')} ${log(gdeltRes,'GDELT')}`);

    const rawPapers = dedupe([
      ...(s2Res.status    === 'fulfilled' ? s2Res.value    : []),
      ...(pmRes.status    === 'fulfilled' ? pmRes.value    : []),
      ...(oaRes.status    === 'fulfilled' ? oaRes.value    : []),
    ]);
    const rawMedia = gdeltRes.status === 'fulfilled' ? gdeltRes.value : [];

    console.log(`  Unique raw: ${rawPapers.length} papers`);

    if (rawPapers.length === 0) {
      return res.status(404).json({
        error: `No papers returned from any database for "${query}". All three APIs failed or returned empty results. Check search terms.`
      });
    }

    // ── 3. HARD DETERMINISTIC FILTER ─────────────────────────────
    const filtered = hardFilter(rawPapers, frame);

    // If filter is too aggressive (< 4 papers), broaden:
    // fall back to requiring ANY of the required/synonym terms in title only
    let papers;
    if (filtered.length < 4) {
      console.warn(`  ⚠ Hard filter too strict (${filtered.length}), trying title-only fallback`);
      const allTerms = [...(frame.requiredTerms || []), ...(frame.synonyms || [])]
        .map(t => t.toLowerCase());
      const titleFiltered = rawPapers.filter(p =>
        allTerms.some(t => p.title.toLowerCase().includes(t))
      );
      console.log(`  Title-only fallback: ${titleFiltered.length} papers`);
      papers = titleFiltered.length >= 4 ? titleFiltered : filtered;
    } else {
      papers = filtered;
    }

    if (papers.length < 3) {
      return res.status(404).json({
        error: `Only ${papers.length} relevant paper(s) found after filtering across all three databases. "${query}" may be too niche, use non-standard terminology, or be a very new topic. Try: "${frame.intervention}" alone, or check the spelling.`
      });
    }

    // Cap at 30 best papers (prioritise metas/RCTs and most cited)
    papers = papers
      .sort((a, b) => {
        const designScore = d => ({ umbrella:5, meta:4, rct:3, cohort:2, unknown:1 }[d]||1);
        return (designScore(b.design) * 2 + (b.citations || 0) * 0.001) -
               (designScore(a.design) * 2 + (a.citations || 0) * 0.001);
      })
      .slice(0, 30);

    console.log(`  Final: ${papers.length} papers for analysis`);
    console.log(`  Design mix: ${papers.reduce((a,p) => { a[p.design]=(a[p.design]||0)+1; return a; }, {})}`);

    // ── 4. Extract outcomes + analyse media in parallel ───────────
    console.log('  Extracting outcomes...');
    const [extractions, mediaAnalysis] = await Promise.all([
      extractOutcomes(papers, frame),
      analyzeMedia(frame.plain, rawMedia, frame),
    ]);
    console.log(`  Extracted: ${extractions.length} outcome sets`);

    // Attach extraction data back to papers for the frontend
    papers.forEach(p => {
      const ex = extractions.find(e => {
        if (!e.ref) return false;
        if (p.doi  && e.ref.toLowerCase().includes(p.doi.toLowerCase()))  return true;
        if (p.pmid && e.ref.toLowerCase().includes(p.pmid.toLowerCase())) return true;
        return false;
      });
      if (ex) {
        p.design     = ex.design    || p.design;
        p.sampleSize = ex.sampleSize;
        p.extractedOutcomes = ex.outcomes;
      }
    });

    // ── 5. Deterministic scoring ──────────────────────────────────
    const scoring = computeConsensus(extractions);
    console.log(`  Score: ${scoring.score}/100 | Certainty: ${scoring.certainty} | Contradiction: ${scoring.contradiction} | n=${scoring.evidenceCount}`);

    // ── 6. Synthesis + verdict in parallel ───────────────────────
    console.log('  Synthesizing...');
    const [summary, verdict] = await Promise.all([
      synthesize(frame, papers, scoring),
      generateVerdict(frame, scoring),
    ]);
    console.log(`  Verdict: "${verdict.slice(0, 80)}..."`);

    // ── 7. Build stance list for frontend strip ───────────────────
    const stances = extractions.map(ex => {
      const topOutcome = (ex.outcomes || [])
        .sort((a,b) => (b.magnitude||0) - (a.magnitude||0))[0];
      return {
        ref:    ex.ref,
        stance: topOutcome?.direction === 'supports_right' ? 'for'     :
                topOutcome?.direction === 'supports_left'  ? 'against' : 'mixed',
        type:   ex.design === 'meta' ? 'meta' :
                ex.design === 'rct'  ? 'rct'  :
                ex.design === 'cohort' ? 'cohort' : 'obs',
        note:   topOutcome?.note || '',
      };
    });

    const mediaStances = rawMedia.map((m, i) => {
      const s = mediaAnalysis.stances?.find(st => st.index === i);
      return { ...m, stance: s?.stance || 'neutral', framing: s?.framing || '', weight: s?.weight || 3 };
    });

    const mediaDivergence = Math.abs((mediaAnalysis.rightPct ?? 50) - scoring.rightPct);
    const sourceCounts = papers.reduce((a,p) => { a[p.source||'?']=(a[p.source||'?']||0)+1; return a; }, {});

    console.log(`  ✓ Done in ${Date.now()-t0}ms | sources: ${JSON.stringify(sourceCounts)}`);
    console.log(`${'═'.repeat(60)}`);

    const result = {
      queryMeta: {
        plain:       frame.plain,
        leftSide:    frame.leftClaim,
        leftDesc:    frame.leftDesc,
        rightSide:   frame.rightClaim,
        rightDesc:   frame.rightDesc,
        isDebatable: frame.isDebatable,
        domain:      frame.domain,
      },
      papers,
      analysis: {
        verdict,
        summary,
        debate: {
          leftLabel:          frame.leftClaim,
          leftDesc:           frame.leftDesc,
          rightLabel:         frame.rightClaim,
          rightDesc:          frame.rightDesc,
          leftPct:            scoring.leftPct,
          rightPct:           scoring.rightPct,
          isDebated:          frame.isDebatable,
          certainty:          scoring.certainty,
          directionalConf:    scoring.directionalConf,
          designQuality:      scoring.designQuality,
          contradiction:      scoring.contradiction,
          score:              scoring.score,
        },
        stances,
      },
      media: mediaStances,
      mediaAnalysis: {
        leftPct:    mediaAnalysis.leftPct  ?? 50,
        rightPct:   mediaAnalysis.rightPct ?? 50,
        divergence: Math.round(mediaDivergence),
      },
      meta: {
        paperCount:    papers.length,
        sourceCounts,
        certainty:     scoring.certainty,
        contradiction: scoring.contradiction,
        score:         scoring.score,
        durationMs:    Date.now() - t0,
        algorithm:     'v7-cached-deterministic',
        requiredTerms: frame.requiredTerms,
        synonyms:      frame.synonyms,
        fromCache:     false,
      }
    };

    // Store in cache (async — don't block response)
    setCached(query, frame.plain, result, scoring).catch(() => {});

    res.json(result);

  } catch (err) {
    console.error('  ✗ FATAL:', err.message);
    console.error(err.stack?.split('\n').slice(0,4).join('\n'));
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  await initDB();
  console.log(`\n🔬 Verity v7.0 → http://localhost:${PORT}`);
  console.log('   Sources:  Semantic Scholar + PubMed + OpenAlex (parallel)');
  console.log('   Cache:    ' + (db ? `PostgreSQL (${CACHE_TTL_DAYS}-day TTL)` : 'disabled (no DATABASE_URL)'));
  console.log('   Filter:   HARD — requiredTerms/synonyms MUST appear in paper text');
  console.log('   Scoring:  w=D×B×P×R×U | c=S×M×w (fully deterministic)\n');
});
