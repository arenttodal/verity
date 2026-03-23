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

// Import the new migration system
const VerityDatabaseMigration = require('./database-migration.js');
const IncrementalWorker = require('./incremental-worker.js');

// Initialize the worker
let incrementalWorker = null;

async function initDB() {
  if (!db) return;
  
  try {
    const migration = new VerityDatabaseMigration(db);
    await migration.runMigrations();
    console.log('✓ Database migrations completed');
    
    // Store migration instance for health checks
    db.migration = migration;
    
    // Start incremental worker if database is available
    if (db && anthropic) {
      incrementalWorker = new IncrementalWorker(db, anthropic);
      await incrementalWorker.start();
      console.log('✓ Incremental evidence worker started');
    }
    
  } catch (e) {
    console.warn('DB migration failed:', e.message);
    db = null; // disable database if migration fails
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
  
  // Enhanced health check with migration status
  let migrationStatus = { status: 'disabled', message: 'Database not configured' };
  if (db && db.migration) {
    migrationStatus = await db.migration.checkHealth();
  }
  
  res.json({ 
    ok: true, 
    version: '7.0', 
    cache: dbOk ? 'connected' : (db ? 'error' : 'disabled'),
    migrations: migrationStatus
  });
});

// ─────────────────────────────────────────────────────────────────
//  INCREMENTAL EVIDENCE SYSTEM API ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// System status endpoint
app.get('/api/incremental/status', async (req, res) => {
  if (!db) {
    return res.json({ 
      status: 'disabled', 
      message: 'Database not configured' 
    });
  }

  try {
    // Check if incremental tables exist
    const tableCheck = await db.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('topics', 'papers', 'topic_papers', 'update_queue', 'system_config')
    `);
    
    const requiredTables = ['topics', 'papers', 'topic_papers', 'update_queue', 'system_config'];
    const existingTables = tableCheck.rows.map(r => r.table_name);
    const missingTables = requiredTables.filter(t => !existingTables.includes(t));
    
    if (missingTables.length > 0) {
      return res.json({
        status: 'incomplete',
        message: `Missing tables: ${missingTables.join(', ')}`,
        existing_tables: existingTables
      });
    }

    // Get system stats
    const stats = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM topics'),
      db.query('SELECT COUNT(*) as count FROM papers'),
      db.query('SELECT COUNT(*) as count FROM update_queue WHERE status = $1', ['pending']),
      db.query('SELECT config_value FROM system_config WHERE config_key = $1', ['incremental_enabled'])
    ]);

    res.json({
      status: 'active',
      message: 'Incremental system is operational',
      stats: {
        topics: parseInt(stats[0].rows[0].count),
        papers: parseInt(stats[1].rows[0].count),
        pending_updates: parseInt(stats[2].rows[0].count),
        enabled: stats[3].rows[0]?.config_value === 'true'
      },
      tables: existingTables
    });

  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Topic tracking endpoint (called when user enables "Track this topic")
app.post('/api/incremental/track', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }

  try {
    const { query, deep_mode } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Generate query hash
    const queryHash = crypto.createHash('sha256')
      .update(query.toLowerCase().trim())
      .digest('hex');

    // Check if topic already exists
    const existing = await db.query(
      'SELECT id, canonical_query FROM topics WHERE query_hash = $1',
      [queryHash]
    );

    if (existing.rows.length > 0) {
      return res.json({
        success: true,
        message: 'Topic already being tracked',
        topic_id: existing.rows[0].id,
        canonical_query: existing.rows[0].canonical_query
      });
    }

    // Create new topic
    const result = await db.query(`
      INSERT INTO topics (
        query_hash, 
        canonical_query, 
        plain_query,
        priority_level,
        update_frequency_hours
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, canonical_query
    `, [
      queryHash,
      query, // TODO: We could frame this with Claude for better canonical form
      query,
      deep_mode ? 1 : 2, // Higher priority for deep mode queries
      deep_mode ? 24 : 168 // More frequent updates for deep mode
    ]);

    // Schedule initial update
    await db.query(`
      INSERT INTO update_queue (
        topic_id,
        scheduled_for,
        priority,
        update_type
      ) VALUES ($1, NOW() + INTERVAL '5 minutes', $2, 'initial_analysis')
    `, [
      result.rows[0].id,
      deep_mode ? 1 : 2
    ]);

    res.json({
      success: true,
      message: 'Topic added for tracking',
      topic_id: result.rows[0].id,
      canonical_query: result.rows[0].canonical_query
    });

  } catch (error) {
    console.error('Error tracking topic:', error);
    res.status(500).json({ error: error.message });
  }
});

// List tracked topics
app.get('/api/incremental/topics', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }

  try {
    const result = await db.query(`
      SELECT 
        id,
        canonical_query,
        plain_query,
        domain,
        current_consensus_score,
        current_consensus_pct,
        current_certainty,
        current_paper_count,
        last_incremental_update,
        priority_level,
        is_active,
        created_at
      FROM topics 
      ORDER BY priority_level ASC, created_at DESC
      LIMIT 50
    `);

    res.json({
      success: true,
      topics: result.rows
    });

  } catch (error) {
    console.error('Error fetching topics:', error);
    res.status(500).json({ error: error.message });
  }
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
  "mediaSubjectTerms": ["<the specific subject word that MUST appear in any relevant article title — same logic as requiredTerms>"],
  "mediaOutcomeTerms": ["<outcome word 1 that should appear>", "<outcome word 2>", "<outcome word 3>"],
  "isDebatable":   <true if real scientific debate, false if near-consensus>,
  "leftClaim":     "<3-6 words: ALWAYS the concern/harm/risk/negative position>",
  "leftDesc":      "<8-12 words describing it>",
  "rightClaim":    "<3-6 words: ALWAYS the safe/beneficial/positive/no-harm position>",
  "rightDesc":     "<8-12 words describing it>",
  "axisLeftLabel": "<1-2 words for the LEFT (concern/harm) end — e.g. 'Harmful', 'Risky', 'Concern', 'Causes harm'>",
  "axisRightLabel":"<1-2 words for the RIGHT (safe/beneficial) end — e.g. 'Safe', 'Beneficial', 'Effective', 'No harm'>",
  "domain":        "<nutrition|pharmacology|exercise_science|mental_health|environmental|clinical|other>"
}

ABSOLUTE RULE FOR LEFT/RIGHT ORIENTATION — THIS IS THE MOST IMPORTANT RULE:
The LEFT side is ALWAYS the concern/harm/risk/negative position (displayed in RED).
The RIGHT side is ALWAYS the safe/beneficial/positive/no-harm position (displayed in BLUE).
This never changes regardless of how the question is worded.

EXAMPLES — study these carefully:
- "does aspartame cause harm?" → leftClaim: "causes harm", rightClaim: "is safe", axisLeftLabel: "Harmful", axisRightLabel: "Safe"
- "is aspartame safe?" → leftClaim: "unsafe, causes harm", rightClaim: "safe, no harm", axisLeftLabel: "Harmful", axisRightLabel: "Safe"
- "does smoking cause cancer?" → leftClaim: "causes cancer", rightClaim: "no cancer link", axisLeftLabel: "Causes cancer", axisRightLabel: "No link"
- "does creatine improve muscle?" → leftClaim: "no effect on muscle", rightClaim: "improves muscle", axisLeftLabel: "No effect", axisRightLabel: "Effective"
- "does exercise reduce heart disease?" → leftClaim: "no cardiovascular benefit", rightClaim: "reduces heart disease", axisLeftLabel: "No benefit", axisRightLabel: "Beneficial"
- "does ultraprocessed food cause disease?" → leftClaim: "increases disease risk", rightClaim: "no significant harm", axisLeftLabel: "Increases risk", axisRightLabel: "No harm"
- "does coffee reduce mortality?" → leftClaim: "no mortality benefit", rightClaim: "reduces mortality", axisLeftLabel: "No benefit", axisRightLabel: "Beneficial"
- "do psychedelics help depression?" → leftClaim: "ineffective for depression", rightClaim: "improves depression", axisLeftLabel: "No benefit", axisRightLabel: "Effective"
- "is a vegan diet healthy?" → leftClaim: "nutritionally risky", rightClaim: "metabolically beneficial", axisLeftLabel: "Risky", axisRightLabel: "Beneficial"

NOTE on harm questions: when the topic is about whether X causes harm, "harm confirmed" goes LEFT (red = concern) and "safe/no harm" goes RIGHT (blue = reassuring). A study showing X is dangerous should plot toward LEFT. A study showing X is safe plots toward RIGHT.


CRITICAL RULES FOR mediaSubjectTerms and mediaOutcomeTerms:
mediaSubjectTerms: the specific subject word(s) that MUST appear in any relevant article title.
This is a HARD GATE — articles without these words are rejected regardless of how credible the outlet is.
Examples:
- "pet ownership mental health" → mediaSubjectTerms: ["pet", "pets", "animal", "dog", "cat"]
- "creatine muscle" → mediaSubjectTerms: ["creatine"]
- "vegan diet" → mediaSubjectTerms: ["vegan", "plant-based", "plant based"]
- "intermittent fasting" → mediaSubjectTerms: ["fasting", "intermittent"]

mediaOutcomeTerms: words related to the OUTCOME being studied (not the subject).
At least one MUST also appear in the article title or snippet.
This prevents articles about the subject that have nothing to do with the research question.
Examples:
- "pet ownership mental health" → mediaOutcomeTerms: ["mental health", "depression", "anxiety", "wellbeing", "well-being", "loneliness", "therapy", "stress", "mood", "psychological"]
- "creatine muscle" → mediaOutcomeTerms: ["muscle", "strength", "performance", "exercise", "hypertrophy", "athletic"]
- "red meat cancer" → mediaOutcomeTerms: ["cancer", "tumor", "colorectal", "carcinoma", "mortality", "risk"]
- "coffee mortality" → mediaOutcomeTerms: ["mortality", "death", "lifespan", "longevity", "cardiovascular", "heart"]

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

    // Extract funding information from PubMed grants
    const fundingData = extractPubMedFunding(a);

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
      fundingData: fundingData
    });
  }
  return papers;
}

// Extract funding information from PubMed XML grants
function extractPubMedFunding(xmlContent) {
  const funding = {
    sources: [],
    categories: [],
    details: null,
    biasRisk: 'unknown',
    industrySponsored: false
  };

  // Extract from GrantList
  const grantMatches = [...xmlContent.matchAll(/<Grant>([\s\S]*?)<\/Grant>/g)];
  console.log(`    PubMed grants found: ${grantMatches.length}`);
  
  grantMatches.forEach((grantMatch, i) => {
    const grant = grantMatch[1];
    console.log(`      Grant ${i+1}: ${grant.slice(0, 100)}...`);
    
    // Extract agency
    const agencyMatch = grant.match(/<Agency>([\s\S]*?)<\/Agency>/);
    if (agencyMatch) {
      const agency = stripHtml(agencyMatch[1]).trim();
      console.log(`        Found agency: ${agency}`);
      if (agency && !funding.sources.includes(agency)) {
        funding.sources.push(agency);
        
        const agencyLower = agency.toLowerCase();
        if (agencyLower.includes('nih') || agencyLower.includes('national institute') ||
            agencyLower.includes('nsf') || agencyLower.includes('cdc') ||
            agencyLower.includes('government') || agencyLower.includes('ministry') ||
            agencyLower.includes('council') || agencyLower.includes('nhmrc') ||
            agencyLower.includes('cihr') || agencyLower.includes('va ')) {
          funding.categories.push('government');
        } else if (agencyLower.includes('foundation') || agencyLower.includes('trust') ||
                  agencyLower.includes('charity')) {
          funding.categories.push('foundation');
        } else if (agencyLower.includes('university') || agencyLower.includes('college') ||
                  agencyLower.includes('medical center')) {
          funding.categories.push('academic');
        } else if (agencyLower.includes('pharmaceut') || agencyLower.includes('biotech') ||
                  agencyLower.includes('inc') || agencyLower.includes('corp') ||
                  agencyLower.includes('ltd') || agencyLower.includes('pfizer') ||
                  agencyLower.includes('merck') || agencyLower.includes('novartis')) {
          funding.categories.push('industry');
          funding.industrySponsored = true;
        } else {
          funding.categories.push('unknown');
        }
      }
    } else {
      console.log(`        No agency found in grant`);
    }
    
    // Extract country for additional context
    const countryMatch = grant.match(/<Country>([\s\S]*?)<\/Country>/);
    if (countryMatch) {
      const country = stripHtml(countryMatch[1]).trim();
      if (country && funding.sources.length > 0) {
        funding.details = `${funding.sources[funding.sources.length - 1]} (${country})`;
      }
    }
  });

  console.log(`    Final funding extracted: sources=${funding.sources.length}, categories=${funding.categories.length}`);

  // Determine bias risk
  const industryCount = funding.categories.filter(c => c === 'industry').length;
  const governmentCount = funding.categories.filter(c => c === 'government').length;
  const totalFunding = funding.categories.length;

  if (totalFunding === 0) {
    funding.biasRisk = 'unknown';
  } else if (industryCount / totalFunding > 0.6) {
    funding.biasRisk = 'high';
  } else if (industryCount > 0 || governmentCount === 0) {
    funding.biasRisk = 'moderate';
  } else {
    funding.biasRisk = 'low';
  }

  return funding;
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
      openalexId: w.id  // Store OpenAlex ID for funding lookup
    };
  }).filter(Boolean);
}

// Enhanced OpenAlex funding lookup (separate API call)
async function fetchOpenAlexFundingData(openalexId) {
  try {
    const res = await fetch(`${openalexId}?select=id,grants,authorships`, {
      signal: AbortSignal.timeout(8000)
    });
    
    if (!res.ok) return null;
    const work = await res.json();
    
    return extractOpenAlexFunding(work);
  } catch (error) {
    console.warn(`OpenAlex funding lookup failed for ${openalexId}:`, error.message);
    return null;
  }
}

// Extract funding information from OpenAlex API response
function extractOpenAlexFunding(work) {
  const funding = {
    sources: [],
    categories: [],
    details: null,
    biasRisk: 'unknown',
    industrySponsored: false
  };

  // Extract from grants field
  if (work.grants && work.grants.length > 0) {
    work.grants.forEach(grant => {
      if (grant.funder_display_name) {
        funding.sources.push(grant.funder_display_name);
        
        // Categorize funding source
        const funderName = grant.funder_display_name.toLowerCase();
        if (funderName.includes('nih') || funderName.includes('national institute') || 
            funderName.includes('nsf') || funderName.includes('government') ||
            funderName.includes('ministry') || funderName.includes('council') ||
            funderName.includes('nhmrc') || funderName.includes('cihr')) {
          funding.categories.push('government');
        } else if (funderName.includes('foundation') || funderName.includes('trust') ||
                  funderName.includes('charity') || funderName.includes('gates') ||
                  funderName.includes('wellcome')) {
          funding.categories.push('foundation');
        } else if (funderName.includes('university') || funderName.includes('college') ||
                  (funderName.includes('institute') && !funderName.includes('national'))) {
          funding.categories.push('academic');
        } else if (funderName.includes('pharmaceut') || funderName.includes('biotech') ||
                  funderName.includes(' inc') || funderName.includes('corp') ||
                  funderName.includes(' ltd') || funderName.includes('company') ||
                  funderName.includes('pfizer') || funderName.includes('novartis') ||
                  funderName.includes('merck') || funderName.includes('roche')) {
          funding.categories.push('industry');
          funding.industrySponsored = true;
        } else {
          funding.categories.push('unknown');
        }
      }
    });
  }

  // Extract from author institutions
  if (work.authorships && work.authorships.length > 0) {
    work.authorships.forEach(authorship => {
      if (authorship.institutions) {
        authorship.institutions.forEach(institution => {
          const instName = institution.display_name?.toLowerCase() || '';
          if (instName.includes('pfizer') || instName.includes('novartis') ||
              instName.includes('merck') || instName.includes('roche') ||
              instName.includes('bristol myers') || instName.includes('abbvie') ||
              instName.includes('gsk') || instName.includes('sanofi')) {
            if (!funding.sources.includes(institution.display_name)) {
              funding.sources.push(institution.display_name);
              funding.categories.push('industry');
              funding.industrySponsored = true;
            }
          }
        });
      }
    });
  }

  // Determine bias risk
  const industryCount = funding.categories.filter(c => c === 'industry').length;
  const governmentCount = funding.categories.filter(c => c === 'government').length;
  const totalFunding = funding.categories.length;

  if (totalFunding === 0) {
    funding.biasRisk = 'unknown';
  } else if (industryCount / totalFunding > 0.6) {
    funding.biasRisk = 'high';
  } else if (industryCount > 0 || governmentCount === 0) {
    funding.biasRisk = 'moderate';  
  } else {
    funding.biasRisk = 'low';
  }

  return funding;
}

// Crossref funding lookup for additional funding data
async function fetchCrossrefFunding(doi) {
  if (!doi) return null;
  
  try {
    const res = await fetch(`https://api.crossref.org/works/${doi}`, {
      headers: { 'User-Agent': 'Verity/1.0 (mailto:hello@verity.science)' },
      signal: AbortSignal.timeout(8000)
    });
    
    if (!res.ok) return null;
    const data = await res.json();
    
    const funding = {
      sources: [],
      categories: [],
      details: null,
      biasRisk: 'unknown',
      industrySponsored: false
    };
    
    if (data.message.funder && data.message.funder.length > 0) {
      data.message.funder.forEach(funder => {
        if (funder.name) {
          funding.sources.push(funder.name);
          
          const funderName = funder.name.toLowerCase();
          if (funderName.includes('nih') || funderName.includes('national institute') ||
              funderName.includes('nsf') || funderName.includes('government') ||
              funderName.includes('ministry') || funderName.includes('council')) {
            funding.categories.push('government');
          } else if (funderName.includes('foundation') || funderName.includes('trust')) {
            funding.categories.push('foundation');
          } else if (funderName.includes('university') || funderName.includes('college')) {
            funding.categories.push('academic');
          } else if (funderName.includes('pharmaceut') || funderName.includes('biotech') ||
                    funderName.includes(' inc') || funderName.includes('corp')) {
            funding.categories.push('industry');
            funding.industrySponsored = true;
          } else {
            funding.categories.push('unknown');
          }
        }
      });
    }
    
    return funding;
  } catch (error) {
    return null;
  }
}

// Merge funding data from multiple sources (API data + AI extraction + Crossref)
function mergeFundingData(extraction, apiFundingData) {
  const merged = {
    sources: [],
    categories: [],
    details: null,
    biasRisk: 'unknown',
    industrySponsored: false,
    grantNumbers: []
  };

  console.log(`    Merging: extraction=${JSON.stringify(extraction?.funding)}, api=${JSON.stringify(apiFundingData)}`);

  // Start with API funding data (OpenAlex/PubMed)
  if (apiFundingData && apiFundingData.sources && apiFundingData.sources.length > 0) {
    merged.sources.push(...apiFundingData.sources);
    if (apiFundingData.categories) merged.categories.push(...apiFundingData.categories);
    if (apiFundingData.industrySponsored) merged.industrySponsored = true;
    if (apiFundingData.biasRisk && apiFundingData.biasRisk !== 'unknown') merged.biasRisk = apiFundingData.biasRisk;
  }

  // Merge with AI extraction
  if (extraction && extraction.funding) {
    if (extraction.funding.sources && extraction.funding.sources.length > 0) {
      extraction.funding.sources.forEach(source => {
        if (source && source !== 'unknown' && !merged.sources.includes(source)) {
          merged.sources.push(source);
        }
      });
    }
    if (extraction.funding.categories && extraction.funding.categories.length > 0) {
      merged.categories.push(...extraction.funding.categories.filter(c => c !== 'unknown'));
    }
    if (extraction.funding.grantNumbers) merged.grantNumbers.push(...extraction.funding.grantNumbers);
    if (extraction.funding.industrySponsored) merged.industrySponsored = true;
    if (extraction.funding.details) merged.details = extraction.funding.details;
    
    // Use AI bias assessment if API didn't provide one
    if (merged.biasRisk === 'unknown' && extraction.funding.biasRisk && extraction.funding.biasRisk !== 'unknown') {
      merged.biasRisk = extraction.funding.biasRisk;
    }
  }

  // Deduplicate and finalize
  merged.sources = [...new Set(merged.sources)];
  merged.categories = [...new Set(merged.categories.filter(c => c !== 'unknown'))];
  merged.grantNumbers = [...new Set(merged.grantNumbers)];

  // If we have no real funding data, return null instead of empty object
  if (merged.sources.length === 0 && merged.categories.length === 0) {
    console.log(`    Merge result: null (no funding found)`);
    return null;
  }

  // Final bias risk assessment based on all data
  if (merged.biasRisk === 'unknown' && merged.categories.length > 0) {
    const industryCount = merged.categories.filter(c => c === 'industry').length;
    const governmentCount = merged.categories.filter(c => c === 'government').length;
    const totalFunding = merged.categories.length;

    if (industryCount / totalFunding > 0.6) {
      merged.biasRisk = 'high';
    } else if (industryCount > 0 || governmentCount === 0) {
      merged.biasRisk = 'moderate';
    } else {
      merged.biasRisk = 'low';
    }
  }

  console.log(`    Merge result: ${JSON.stringify(merged)}`);
  return merged;
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
  const required = (frame.requiredTerms || []).map(t => t.toLowerCase().trim()).filter(t => t.length >= 3);
  const synonyms = (frame.synonyms      || []).map(t => t.toLowerCase().trim()).filter(t => t.length >= 3);
  const allTerms = [...new Set([...required, ...synonyms])].filter(t => t.length > 1);

  if (allTerms.length === 0) {
    // Safety: if Claude failed to generate terms, use intervention word
    const fallback = (frame.intervention || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    allTerms.push(...fallback);
  }

  const filtered = papers.filter(p => {
    const text = (p.title + ' ' + p.abstract).toLowerCase();
    // HARD RULE: at least one required/synonym term must appear as a complete word
    return allTerms.some(term => {
      // Handle hyphenated terms and special characters
      if (term.includes('-') || term.includes(' ')) {
        // For multi-word or hyphenated terms, try both exact phrase and word boundary
        const exactMatch = text.includes(term.toLowerCase());
        const wordMatch = term.split(/[-\s]+/).every(subterm => {
          if (subterm.length < 3) return true; // Skip very short subterms
          const wordRegex = new RegExp(`\\b${subterm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return wordRegex.test(text);
        });
        return exactMatch || wordMatch;
      } else {
        // Single word: use strict word boundaries
        const wordRegex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return wordRegex.test(text);
      }
    });
  });

  console.log(`  Filter: ${papers.length} → ${filtered.length} papers`);
  console.log(`  Required terms: [${allTerms.slice(0,5).join(', ')}]`);
  
  // Debug: Log a few accepted papers to verify word boundary matching
  if (filtered.length > 0) {
    console.log('  Accepted (sample):');
    filtered.slice(0, 2).forEach(p => {
      const matchedTerms = allTerms.filter(term => {
        const text = (p.title + ' ' + p.abstract).toLowerCase();
        if (term.includes('-') || term.includes(' ')) {
          const exactMatch = text.includes(term.toLowerCase());
          const wordMatch = term.split(/[-\s]+/).every(subterm => {
            if (subterm.length < 3) return true;
            const wordRegex = new RegExp(`\\b${subterm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            return wordRegex.test(text);
          });
          return exactMatch || wordMatch;
        } else {
          const wordRegex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return wordRegex.test(text);
        }
      });
      console.log(`    ✓ "${p.title.slice(0, 70)}" [matches: ${matchedTerms.join(', ')}]`);
    });
  }

  // Log rejections for the first few to verify correctness
  const rejected = papers.filter(p => {
    const text = (p.title + ' ' + p.abstract).toLowerCase();
    return !allTerms.some(term => {
      if (term.includes('-') || term.includes(' ')) {
        const exactMatch = text.includes(term.toLowerCase());
        const wordMatch = term.split(/[-\s]+/).every(subterm => {
          if (subterm.length < 3) return true;
          const wordRegex = new RegExp(`\\b${subterm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return wordRegex.test(text);
        });
        return exactMatch || wordMatch;
      } else {
        const wordRegex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return wordRegex.test(text);
      }
    });
  }).slice(0, 3);
  if (rejected.length) {
    console.log('  Rejected (sample):');
    rejected.forEach(p => console.log(`    ✗ "${p.title.slice(0, 70)}"`));
  }

  return filtered;
}

// ─────────────────────────────────────────────────────────────────
//  STEP 3.5 — CLAUDE HAIKU: semantic relevance validation
//  Final safety net to catch any papers that passed regex filters
//  but are semantically irrelevant (e.g., "PurR protein" ≠ "cat purr")
// ─────────────────────────────────────────────────────────────────
async function validateRelevanceWithClaude(papers, frame) {
  if (papers.length === 0) return [];
  
  // For efficiency, batch process and use shorter abstracts
  const BATCH_SIZE = 20; // Haiku can handle more papers per call
  const batches = [];
  
  for (let i = 0; i < papers.length; i += BATCH_SIZE) {
    batches.push(papers.slice(i, i + BATCH_SIZE));
  }
  
  const allValidated = [];
  
  for (const [batchIdx, batch] of batches.entries()) {
    try {
      const paperBlock = batch.map((p, i) => 
        `[${i+1}] "${p.title}"\nAbstract: ${(p.abstract || '').slice(0, 250)}...`
      ).join('\n\n');
      
      const msg = await anthropic.messages.create({
        model: 'claude-3-haiku-20240307', // Fast + cheap for relevance checking
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Research question: "${frame.plain}"

Review these ${batch.length} papers and determine if each is RELEVANT to the research question above.

${paperBlock}

For each paper, respond with just the number and R (relevant) or I (irrelevant):
- R = paper is about the research topic and could provide evidence
- I = paper is clearly about something else (wrong topic, different meaning, etc.)

Examples for "cat purring effects":
- "Effects of purr-frequency vibrations on healing" → R
- "PurR protein in bacterial metabolism" → I  
- "Feline vocalization therapy benefits" → R
- "Purine biosynthesis pathways" → I

Format: [1] R, [2] I, [3] R, etc.`
        }]
      });
      
      const response = msg.content[0].text;
      const relevanceDecisions = [];
      
      // Parse Claude's relevance decisions
      for (let i = 1; i <= batch.length; i++) {
        const match = response.match(new RegExp(`\\[${i}\\]\\s*([RI])`, 'i'));
        if (match) {
          relevanceDecisions.push(match[1].toUpperCase() === 'R');
        } else {
          // If parsing fails, err on the side of inclusion
          relevanceDecisions.push(true);
          console.warn(`  ⚠ Failed to parse relevance for paper ${i} in batch ${batchIdx + 1}`);
        }
      }
      
      // Keep only papers marked as relevant
      const validatedBatch = batch.filter((_, i) => relevanceDecisions[i]);
      allValidated.push(...validatedBatch);
      
      // Log rejections for debugging
      const rejected = batch.filter((_, i) => !relevanceDecisions[i]);
      if (rejected.length > 0) {
        console.log(`  Batch ${batchIdx + 1} rejected (${rejected.length}/${batch.length}):`);
        rejected.forEach(p => console.log(`    ✗ "${p.title.slice(0, 60)}..."`));
      }
      
    } catch (err) {
      console.warn(`  ⚠ Relevance validation failed for batch ${batchIdx + 1}, including all papers:`, err.message);
      // If validation fails, include the whole batch rather than lose papers
      allValidated.push(...batch);
    }
  }
  
  return allValidated;
}

// ─────────────────────────────────────────────────────────────────
//  FUNDING TRANSPARENCY ANALYSIS WITH ENHANCED DATA SOURCES
//  Aggregates funding sources from multiple APIs and AI analysis
// ─────────────────────────────────────────────────────────────────
function analyzeFundingTransparency(extractions) {
  const fundingSources = [];
  const fundingCategories = { government: 0, industry: 0, foundation: 0, academic: 0, mixed: 0, unknown: 0 };
  const biasRisks = { low: 0, moderate: 0, high: 0 };
  const industryStudies = [];
  const governmentStudies = [];
  const allGrantNumbers = [];
  
  console.log(`    Analyzing funding for ${extractions.length} studies...`);
  
  extractions.forEach((ex, i) => {
    console.log(`    Study ${i+1} (${ex.ref}): funding=${JSON.stringify(ex.funding)}, mergedFunding=${JSON.stringify(ex.mergedFunding)}`);
    
    let fundingToUse = null;
    
    // Use merged funding data if available, otherwise fall back to individual sources
    if (ex.mergedFunding) {
      fundingToUse = ex.mergedFunding;
    } else if (ex.funding) {
      fundingToUse = ex.funding;
    } else {
      // Mark as unknown funding
      console.log(`    Study ${i+1}: No funding data - marking as unknown`);
      fundingCategories.unknown++;
      return;
    }
    
    // Collect sources
    if (fundingToUse.sources) {
      fundingToUse.sources.forEach(source => {
        if (source && source !== 'unknown') {
          fundingSources.push(source);
        }
      });
    }
    
    // Collect grant numbers
    if (fundingToUse.grantNumbers) {
      allGrantNumbers.push(...fundingToUse.grantNumbers);
    }
    
    // Count categories
    if (fundingToUse.categories && fundingToUse.categories.length > 0) {
      fundingToUse.categories.forEach(category => {
        if (fundingCategories.hasOwnProperty(category)) {
          fundingCategories[category]++;
        }
      });
    } else {
      fundingCategories.unknown++;
    }
    
    // Count bias risk
    if (fundingToUse.biasRisk && biasRisks.hasOwnProperty(fundingToUse.biasRisk)) {
      biasRisks[fundingToUse.biasRisk]++;
    }
    
    // Track industry vs government studies
    if (fundingToUse.industrySponsored) {
      industryStudies.push(ex.ref);
    }
    if (fundingToUse.categories && fundingToUse.categories.includes('government')) {
      governmentStudies.push(ex.ref);
    }
  });

  // Calculate unique funding sources and grant numbers
  const uniqueSources = [...new Set(fundingSources)];
  const uniqueGrants = [...new Set(allGrantNumbers)];
  
  // Assess overall bias risk
  const totalStudies = extractions.length;
  const industryPct = (fundingCategories.industry / totalStudies) * 100;
  const governmentPct = (fundingCategories.government / totalStudies) * 100;
  const unknownPct = (fundingCategories.unknown / totalStudies) * 100;
  
  let overallBiasRisk = 'low';
  if (industryPct > 50) {
    overallBiasRisk = 'high';
  } else if (industryPct > 25 || unknownPct > 40) {
    overallBiasRisk = 'moderate';
  }
  
  // Enhanced bias alerts with more sophisticated detection
  const biasAlerts = [];
  if (industryPct > 60) {
    biasAlerts.push(`High industry funding: ${Math.round(industryPct)}% of studies`);
  }
  if (unknownPct > 80) {
    biasAlerts.push(`Limited transparency: ${Math.round(unknownPct)}% funding unknown`);
  }
  if (fundingCategories.industry > 0 && fundingCategories.government === 0 && fundingCategories.foundation === 0) {
    biasAlerts.push('No independent non-industry studies found');
  }
  if (uniqueSources.length > 0 && uniqueSources.filter(s => s.toLowerCase().includes('pharma')).length > 2) {
    biasAlerts.push('Multiple pharmaceutical company funders detected');
  }

  return {
    totalStudies,
    fundingSources: uniqueSources,
    grantNumbers: uniqueGrants,
    categories: fundingCategories,
    biasRisks,
    biasRisk: overallBiasRisk,
    biasAlerts,
    industryPct: Math.round(industryPct),
    governmentPct: Math.round(governmentPct),
    independentPct: Math.round(governmentPct + (fundingCategories.foundation / totalStudies) * 100),
    unknownPct: Math.round(unknownPct),
    dataQuality: {
      hasApiData: uniqueSources.length > (totalStudies * 0.1), // >10% have API funding data
      hasGrantNumbers: uniqueGrants.length > 0,
      transparencyScore: Math.round(((totalStudies - fundingCategories.unknown) / totalStudies) * 100)
    }
  };
}

// ─────────────────────────────────────────────────────────────────
//  STEP 4 — Claude: structured outcome extraction
//  Claude's ONLY role: extract what each paper actually found.
//  No scoring. No percentages. Pure extraction.
// ─────────────────────────────────────────────────────────────────
async function extractOutcomes(papers, frame, deepMode = false) {
  // Larger batches for deep mode to handle 60 papers efficiently
  const BATCH_SIZE = deepMode ? 15 : 12;
  const batches = [];

  for (let i = 0; i < papers.length; i += BATCH_SIZE) {
    batches.push(papers.slice(i, i + BATCH_SIZE).map((p, j) => {
      const ref = p.doi  ? `doi:${p.doi}`  :
                  p.pmid ? `pmid:${p.pmid}` :
                  `paper-${i + j + 1}`;
      return { p, ref, idx: i + j + 1 };
    }));
  }

  // Run all batches in parallel instead of serially
  const batchResults = await Promise.allSettled(batches.map(async (batch, bi) => {
    const block = batch.map(({ p, ref, idx }) =>
      `[${idx}] REF:${ref}\nTitle: ${p.title}\nJournal: ${p.journal} (${p.year})\nAbstract: ${p.abstract.slice(0, 800)}`
    ).join('\n\n───\n\n');

    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2800,
      system:     'Systematic review data extractor. Extract exactly what is stated in each abstract. Do not add interpretation beyond what is written. Respond ONLY with valid JSON.',
      messages: [{
        role: 'user',
        content: `Extract structured outcome data from these papers. Pay special attention to funding and conflicts of interest.

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
      "funding": {
        "sources": ["<funding source 1>", "<funding source 2>"],
        "categories": ["<government|industry|foundation|academic|mixed|unknown>"],
        "biasRisk": "<low|moderate|high>",
        "details": "<brief funding note if mentioned in abstract>",
        "industrySponsored": <true/false>,
        "grantNumbers": ["<grant numbers if mentioned>"]
      },
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
- cohort: "cohort", "longitudinal", "prospective", "followed"
- umbrella: "umbrella review", "review of reviews", "meta-review"

FUNDING EXTRACTION RULES:
- sources: Extract specific funding organizations mentioned (e.g., ["NIH", "Pfizer Inc", "Wellcome Trust"])
- categories: Classify each source as government, industry, foundation, academic, mixed, or unknown
- biasRisk: low=government/foundation only, moderate=mixed funding, high=industry-only or clear conflicts
- details: Quote exact funding statement if brief (max 15 words)
- industrySponsored: true only if pharmaceutical, biotech, or device company funding mentioned
- grantNumbers: Extract any grant numbers (e.g., "R01-DK123456", "K23-HL098765")

CRITICAL: Look for these industry funding clues:
- Company names in author affiliations (e.g., "Pfizer Research", "Novartis Pharmaceuticals")
- Conflict of interest statements mentioning employment or consulting
- Phrases like "funded by", "sponsored by", "supported by" followed by company names
- Study registration numbers from company trials
- Institutional affiliations with pharmaceutical companies

FUNDING SOURCE EXAMPLES:
- government: NIH, NSF, EU Horizon, CIHR, NHMRC, national health agencies, FDA, CDC
- industry: Pfizer, Moderna, Novartis, Merck, GSK, pharmaceutical companies, biotech, device manufacturers
- foundation: Gates Foundation, Wellcome Trust, Robert Wood Johnson, private foundations
- academic: university grants, institutional funding, academic societies
- mixed: combination of above categories
- unknown: no funding mentioned or "funding information not available"

BIAS ASSESSMENT:
- Look for conflicts of interest statements
- Industry funding of studies testing their own products = high bias risk
- Government/foundation funding = low bias risk
- Mixed funding or unclear sources = moderate bias risk
- Pay special attention to vaccine, drug, and medical device studies
- cohort: "prospective cohort", "longitudinal", "follow-up study"
- cross_sectional: "cross-sectional", "survey"
- obs: "observational" without specifying type
- narrative_review: "review" without systematic/meta

DIRECTION RULES — must align with axis orientation:
- supports_left: paper supports the CONCERN/HARM/RISK/NEGATIVE position (left = red side)
- supports_right: paper supports the SAFE/BENEFICIAL/POSITIVE/NO-HARM position (right = blue side)
- neutral: no difference found, p>0.05 on primary outcome
- mixed: paper reports both positive and negative effects on same outcome

For harm questions (e.g. "does X cause disease"):
- A paper finding X IS harmful → supports_left
- A paper finding X is safe / no harm found → supports_right

For benefit questions (e.g. "does X improve health"):
- A paper finding X has NO benefit → supports_left
- A paper finding X IS beneficial → supports_right

MAGNITUDE: use stated effect sizes. If none stated, use language: "significantly improved/reduced" → 0.6, "modest improvement" → 0.35, "no significant difference" → 0.05, "trend toward" → 0.15`
      }]
    });

    const parsed = parseJSON(msg.content[0].text);
    return parsed.extractions || [];
  }));

  const allExtractions = [];
  batchResults.forEach((r, bi) => {
    if (r.status === 'fulfilled') {
      allExtractions.push(...r.value);
    } else {
      console.warn(`  Extraction batch ${bi} failed:`, r.reason?.message);
    }
  });

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
      // CRITICAL: papers with missing match scores are irrelevant, not moderate
      const popMatch    = ex.populationMatch   ?? 0.05; // Default to irrelevant, not 0.5
      const intMatch    = ex.interventionMatch ?? 0.05; // Default to irrelevant, not 0.5
      const R = Math.max(0.05, Math.min(1.0, popMatch * 0.40 + intMatch * 0.60));

      // Safety: skip papers that are clearly irrelevant to prevent contamination
      if (R < 0.15 && (popMatch < 0.2 || intMatch < 0.2)) {
        // Paper is likely irrelevant (both population and intervention mismatch)
        return; // Skip this outcome entirely
      }

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

// Hard dual-gate relevance check for media articles.
// An article MUST pass BOTH gates to be included:
//   Gate 1: At least one mediaSubjectTerm appears in title (e.g. "pet", "pets", "dog")
//   Gate 2: At least one mediaOutcomeTerms appears in title or snippet (e.g. "mental health", "depression")
//
// This prevents "UK veterinary reforms" from appearing in a pet-mental-health search
// because it contains "pet" but has nothing to do with mental health outcomes.
function articlePassesDualGate(title, snippet, frame) {
  const text    = ((title || '') + ' ' + (snippet || '')).toLowerCase();
  const titleLo = (title || '').toLowerCase();

  // Gate 1: subject terms — must appear in TITLE specifically (not just snippet)
  const subjectTerms = [
    ...(frame.mediaSubjectTerms || []),
    ...(frame.requiredTerms    || []),
    ...(frame.synonyms         || []).slice(0, 4),
  ].map(t => t.toLowerCase()).filter(t => t.length > 2);

  const subjectPasses = subjectTerms.length === 0 ||
    subjectTerms.some(t => titleLo.includes(t));

  if (!subjectPasses) return { passes: false, reason: 'no subject term in title' };

  // Gate 2: outcome terms — must appear in title or snippet
  const outcomeTerms = (frame.mediaOutcomeTerms || []).map(t => t.toLowerCase());

  // If no outcome terms were generated, fall back to outcomes array
  const fallbackOutcomes = (frame.outcomes || [])
    .flatMap(o => o.toLowerCase().split(/\s+/))
    .filter(w => w.length > 4);

  const allOutcome = [...new Set([...outcomeTerms, ...fallbackOutcomes])];

  const outcomePasses = allOutcome.length === 0 ||
    allOutcome.some(t => text.includes(t));

  if (!outcomePasses) return { passes: false, reason: 'no outcome term' };

  return { passes: true, reason: 'ok' };
}

// Relevance score for ranking (used AFTER both gates pass)
function relevanceScore(title, snippet, frame) {
  const text = ((title || '') + ' ' + (snippet || '')).toLowerCase();

  const subjectTerms  = [...(frame.mediaSubjectTerms || []), ...(frame.requiredTerms || []), ...(frame.synonyms || []).slice(0, 3)].map(t => t.toLowerCase());
  const outcomeTerms  = (frame.mediaOutcomeTerms || frame.outcomes || []).map(t => t.toLowerCase ? t.toLowerCase() : t);

  let score = 0;
  // Subject match in title = high value
  subjectTerms.forEach(t => { if ((title || '').toLowerCase().includes(t)) score += 0.4; });
  // Outcome match in title = high value
  outcomeTerms.forEach(t => { if ((title || '').toLowerCase().includes(t)) score += 0.35; });
  // Either in snippet = lower value
  subjectTerms.forEach(t => { if ((snippet || '').toLowerCase().includes(t)) score += 0.1; });
  outcomeTerms.forEach(t => { if ((snippet || '').toLowerCase().includes(t)) score += 0.1; });

  return Math.min(1, score);
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

// ── STEP 1: Generate multiple search query variants via Claude ────
// Instead of one rigid query, Claude generates 4-6 natural search
// queries that a journalist or editor would use to find articles
// on this specific topic. Cast wide, filter smart.
async function generateMediaSearchQueries(frame, deepMode = false) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: 'You generate news search queries. Respond ONLY with valid JSON.',
    messages: [{
      role: 'user',
      content: `Generate search queries to find news articles about: "${frame.plain}"

The research question involves:
- Subject: ${frame.intervention} (in ${frame.population})
- Outcomes: ${(frame.outcomes || []).join(', ')}

Generate ${deepMode ? '8-10' : '5'} natural search queries a journalist would search to find articles specifically about the RESEARCH QUESTION above — not just the subject in any context.

Rules:
- Each query must be specific enough that results would be about the topic AND the relevant outcomes
- Include the subject AND at least one outcome concept in each query
- Vary the phrasing to cast a wide net
- Keep each query to 3-6 words, natural language

Return ONLY:
{
  "queries": [
    "pets mental health benefits",
    "pet ownership depression anxiety",
    "animals wellbeing research",
    "pet therapy psychological effects",
    "companion animals mental wellness"
  ]
}`
    }]
  });
  try {
    const parsed = parseJSON(msg.content[0].text);
    return parsed.queries || [frame.gdeltQuery || frame.intervention];
  } catch {
    return [frame.gdeltQuery || frame.intervention];
  }
}

// ── STEP 2: Fetch articles for all query variants in parallel ─────
// Also runs targeted site: queries on specialist outlets that rarely
// surface in general Google News results.
async function fetchAllMediaVariants(queries, frame) {
  const fromYear = new Date().getFullYear() - 5;
  const fromDate = `${fromYear}-01-01`;
  const toDate   = new Date().toISOString().slice(0, 10);

  // Primary query (first / most specific) for targeted site searches
  const primaryQ = queries[0] || frame.gdeltQuery || frame.intervention;

  // Specialist science/health outlets — targeted site: queries via Google News
  // These are the outlets most likely to cover research topics accurately
  // but are underrepresented in general news searches.
  const SPECIALIST_SITES = [
    'statnews.com',
    'medscape.com',
    'medpagetoday.com',
    'sciencenews.org',
    'scientificamerican.com',
    'theconversation.com',
    'examine.com',
    'eurekaalert.org',
    'mayoclinic.org',
    'verywellhealth.com',
  ];

  // One targeted Google News query per specialist site using the primary query
  const siteQueries = SPECIALIST_SITES.map(site =>
    fetchGoogleNewsDateRange(`${primaryQ} site:${site}`, fromYear).catch(() => [])
  );

  // General queries across all sources
  const generalFetches = queries.flatMap(q => [
    fetchGuardian(q, fromDate, toDate, frame).catch(() => []),
    fetchGoogleNewsDateRange(q, fromYear).catch(() => []),
    fetchBingNewsDateRange(q, fromYear).catch(() => []),
  ]);

  const results = await Promise.allSettled([...generalFetches, ...siteQueries]);
  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // Dedupe by normalised title
  const seen = new Set();
  return all.filter(a => {
    if (!a.title || a.title.length < 15) return false;
    const k = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 70);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ── STEP 3: Claude judges relevance — the smart filter ────────────
// Rather than keyword matching, Claude reads each title and decides
// if it is genuinely about the research question.
async function claudeFilterMedia(articles, frame) {
  if (articles.length === 0) return [];

  // Only send title + snippet to Claude (no URLs needed for filtering)
  const candidates = articles
    .filter(a => a.year >= new Date().getFullYear() - 5)
    .slice(0, 60); // cap to avoid token overflow

  if (candidates.length === 0) return [];

  const block = candidates.map((a, i) =>
    `[${i}] "${a.title}"${a.snippet ? ' — ' + a.snippet.slice(0, 80) : ''}`
  ).join('\n');

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    system: 'You are a media relevance filter. Respond ONLY with valid JSON.',
    messages: [{
      role: 'user',
      content: `Research question: "${frame.plain}"
Left claim: "${frame.leftClaim}" | Right claim: "${frame.rightClaim}"
Outcomes studied: ${(frame.outcomes || []).join(', ')}

Below are news article titles. For each one, decide: is this article ACTUALLY about the research question above?

RELEVANT = the article discusses the subject AND the specific outcomes/effects being researched.
IRRELEVANT = the article is about the subject in a completely different context (e.g. "pet insurance costs" when the question is about pet ownership and mental health).

${block}

Return ONLY:
{
  "relevant": [0, 3, 5, 7],
  "irrelevant": [1, 2, 4, 6]
}

Be generous — if an article MIGHT be about the topic, include it. Only exclude clear mismatches.`
    }]
  });

  try {
    const parsed = parseJSON(msg.content[0].text);
    const relevantIndices = new Set(parsed.relevant || []);
    const kept = candidates.filter((_, i) => relevantIndices.has(i));
    console.log(`  Claude filter: ${candidates.length} candidates → ${kept.length} relevant`);
    return kept;
  } catch (e) {
    console.warn('  Claude media filter failed:', e.message);
    // Fall back to returning all candidates if Claude fails
    return candidates;
  }
}

// ── STEP 4: Score and rank surviving articles ─────────────────────
function rankMedia(articles, frame, maxCount = 15) {
  return articles
    .map(a => {
      const recency = Math.max(0, 1 - (new Date().getFullYear() - a.year) / 6);
      // Prefer higher-credibility outlets and more recent articles
      const score = a.weight * 0.65 + recency * 0.35;
      return { ...a, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, maxCount);
}

// ── MAIN: fetchMedia ──────────────────────────────────────────────
async function fetchMedia(frame, deepMode = false) {
  console.log('  Generating media search queries...');
  const queries = await generateMediaSearchQueries(frame, deepMode);
  console.log(`  Media queries: ${queries.map(q => '"' + q + '"').join(', ')}`);

  console.log('  Fetching media across all query variants...');
  const rawArticles = await fetchAllMediaVariants(queries, frame);
  console.log(`  Media raw: ${rawArticles.length} unique articles`);

  if (rawArticles.length === 0) {
    console.warn('  No media articles found from any source');
    return [];
  }

  // Claude decides what is actually relevant
  const relevant = await claudeFilterMedia(rawArticles, frame);

  // Rank remaining by quality + recency - more for deep mode
  const maxArticles = deepMode ? 25 : 15;
  const final = rankMedia(relevant, frame, maxArticles);
  console.log(`  Media final: ${final.length} articles`);

  return final;
}


async function analyzeMedia(plain, articles, frame) {
  if (!articles || articles.length === 0) return { stances: [], leftPct: 50, rightPct: 50 };
  const block = articles.map((a, i) => `[${i}] "${a.title}" — ${a.outlet}`).join('\n');
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1200,
    system: 'Media framing analyst. Respond ONLY with valid JSON.',
    messages: [{
      role: 'user',
      content: `Topic: "${plain}"

The spectrum has two sides:
LEFT (red, concern) side = "${frame.leftClaim}" — axis label: "${frame.axisLeftLabel || 'Concern'}"
RIGHT (blue, safe/beneficial) side = "${frame.rightClaim}" — axis label: "${frame.axisRightLabel || 'Beneficial'}"

For each headline, decide which SIDE OF THE SPECTRUM it supports:
- "concern" = article frames the topic negatively, as risky or harmful — maps to LEFT (red)
- "benefit" = article frames the topic positively, as safe or beneficial — maps to RIGHT (blue)
- "neutral" = balanced or neither

IMPORTANT: "concern" always maps to the LEFT (red) side, "benefit" to the RIGHT (blue).
For harm/safety topics: an article saying X IS harmful = "concern" (LEFT). An article saying X is safe = "benefit" (RIGHT).
For benefit topics: an article saying X has no effect = "concern" (LEFT). An article saying X works = "benefit" (RIGHT).

Headlines:
${block}

Return ONLY:
{
  "stances": [{"index":<n>,"stance":"<concern|benefit|neutral>","framing":"<one sentence>","weight":<1-4>}],
  "leftPct":<0-100, weighted % of articles on concern/left side>,
  "rightPct":<0-100, must sum to 100>
}`
    }]
  });
  const p = parseJSON(msg.content[0].text);
  if (p.leftPct != null) p.rightPct = 100 - p.leftPct;
  return p;
}

// ─────────────────────────────────────────────────────────────────
//  STEP 8 — Divergence attribution
//
//  When media and science point in meaningfully different directions,
//  we identify the most plausible reason using a combination of:
//    a) Deterministic signal checks (funding, design, outlet quality)
//    b) Claude's reading of media title language patterns
//
//  We never claim to have PROVEN the cause. Every output is framed
//  as "consistent with" or "suggests" — not "caused by".
//
//  Categories (from peer-reviewed science communication taxonomy):
//    novelty_bias          — media prefers new/surprising findings over confirmatory ones
//    design_mismatch       — science is observational but media uses causal language
//    industry_signal       — funding concerns present; direction aligns with funder interest
//    outlet_quality        — low-credibility outlets dominate media set
//    alarm_amplification   — media far more alarming than science supports
//    wellness_hype         — media far more optimistic than science supports
//    publication_bias_echo — both lean same direction; positive-result skew worth naming
//    genuine_uncertainty   — contradiction is high; media divergence may reflect real debate
//    insufficient_data     — too little media to draw conclusions
// ─────────────────────────────────────────────────────────────────

async function analyzeDivergence(frame, papers, scoring, mediaArticles, mediaAnalysis) {
  const sciPct  = scoring.rightPct;
  const medPct  = mediaAnalysis.rightPct ?? 50;
  const divAmt  = Math.abs(sciPct - medPct);
  const divDir  = medPct > sciPct ? 'right' : 'left'; // which way media leans vs science

  // Not worth analysing if divergence is small or media is sparse
  if (divAmt < 10 || !mediaArticles || mediaArticles.length < 3) {
    return null;
  }

  // ── Deterministic signals ────────────────────────────────────────

  // 1. Funding concern: any industry-funded papers?
  const fundingFlags = papers.filter(p => p.extractedOutcomes ? false :
    (p.abstract || '').toLowerCase().match(/funded by|supported by|grant from|sponsored by/)
  ).length;
  const hasFundingConcern = fundingFlags > 0 ||
    papers.some(p => p.fundingConcern);

  // 2. Design quality: what fraction are observational only?
  const total  = papers.length || 1;
  const highQ  = papers.filter(p => ['umbrella','meta','rct'].includes(p.design)).length;
  const obsOnly = highQ / total < 0.15; // fewer than 15% are high-quality designs

  // 3. Outlet quality: average domain weight of media articles
  const avgOutletWeight = mediaArticles.length > 0
    ? mediaArticles.reduce((s, a) => s + (a.weight || 2), 0) / mediaArticles.length
    : 2;
  const lowQualityOutlets = avgOutletWeight < 2.4;

  // 4. Contradiction: is the science itself genuinely divided?
  const genuinelyDivided = scoring.contradiction > 0.30;

  // 5. Direction of divergence relative to topic type
  const mediaMoreOptimistic = medPct > sciPct;
  const mediaMoreAlarming   = medPct < sciPct;

  // Build signal list for Claude
  const signals = [
    hasFundingConcern ? `Industry funding detected in ${fundingFlags || 'some'} papers` : null,
    obsOnly ? `Science is predominantly observational (${Math.round((1-highQ/total)*100)}% non-RCT/meta)` : null,
    lowQualityOutlets ? `Media set has lower average outlet credibility (avg weight ${avgOutletWeight.toFixed(1)}/4)` : null,
    genuinelyDivided ? `Science itself is genuinely divided (contradiction index ${scoring.contradiction.toFixed(2)})` : null,
    `Divergence direction: media leans ${divDir === 'right' ? 'more beneficial/positive' : 'more alarming/negative'} than science by ${divAmt} points`,
    `Science: ${highQ} high-quality studies (meta/RCT) out of ${total} total`,
    `Topic domain: ${frame.domain}`,
  ].filter(Boolean);

  // Get media titles for language analysis
  const titleBlock = mediaArticles.slice(0, 12)
    .map((a, i) => `[${i}] "${a.title}"`)
    .join('\n');

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: 'You are a science communication researcher analysing why media coverage diverges from scientific evidence. Respond ONLY with valid JSON. Be intellectually honest — name patterns, not conclusions. Use hedged language.',
    messages: [{
      role: 'user',
      content: `Topic: "${frame.plain}"
Science consensus: ${sciPct}% toward "${frame.rightClaim}"
Media framing: ${medPct}% toward "${frame.rightClaim}"
Divergence: ${divAmt} points (media is ${divDir === 'right' ? 'more optimistic' : 'more alarming'})

Detected signals:
${signals.join('\n')}

Media article titles:
${titleBlock}

Explain WHY the media framing diverges from the science. Be a sharp analyst, not a textbook.

REQUIRED: Name 1-2 specific article titles from above that best illustrate the divergence pattern.
REQUIRED: Mention the actual science consensus percentage to anchor what the evidence shows.
FORBIDDEN: Do not open with "This is consistent with", "The divergence suggests", or any generic framing language.
FORBIDDEN: Do not just name the bias category — explain what is actually happening with THIS specific topic.

Choose the PRIMARY category:
- novelty_bias: media favours novel/surprising single studies over accumulated confirmatory evidence
- design_mismatch: observational science but media titles imply causation
- industry_signal: funding concerns; media amplifying commercially-favourable findings
- outlet_quality: lower-credibility outlets driving the divergence
- alarm_amplification: media significantly more alarming than evidence supports
- wellness_hype: media significantly more optimistic/beneficial than evidence supports
- publication_bias_echo: science AND media both lean same direction; positive-result skew worth naming
- genuine_uncertainty: science is divided; media divergence may reflect real ongoing debate
- press_release_amplification: PR spin language ("breakthrough", "first ever", "could revolutionize")

Return ONLY:
{
  "category": "<category>",
  "confidence": "<low|moderate|high>",
  "headline": "<10-14 words: a sharp specific label that names what's actually happening, e.g. 'Media amplifying contrarian HIIT narratives despite 99% scientific consensus'>",
  "explanation": "<2-3 sentences. Lead with what the specific titles reveal. Quote or paraphrase 1-2 actual titles. Connect directly to the ${divAmt}-point gap. Be sharp and specific — a reader should learn something they couldn't infer themselves.>",
  "caveat": "<1 honest sentence about limits of this inference>",
  "signals": ["<specific observable signal from the data>", "<another specific signal>"]
}`
    }]
  });

  try {
    const parsed = JSON.parse(msg.content[0].text.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim());
    return {
      category:    parsed.category    || 'unknown',
      confidence:  parsed.confidence  || 'low',
      headline:    parsed.headline    || 'Divergence detected',
      explanation: parsed.explanation || '',
      caveat:      parsed.caveat      || '',
      signals:     parsed.signals     || signals,
      divAmt,
      divDir,
    };
  } catch (e) {
    console.warn('  Divergence analysis parse failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
//  MAIN ENDPOINT
// ─────────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query, forceRefresh, deepMode, trackTopic } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'query is required' });

  const t0 = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[${new Date().toISOString()}] "${query}"${deepMode ? ' (DEEP MODE)' : ''}${trackTopic ? ' (TRACK TOPIC)' : ''}${forceRefresh ? ' (CACHE BYPASS)' : ''}`);
  
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
    const s2Limit  = deepMode ? 50 : 25;
    const pmLimit  = deepMode ? 40 : 20;
    const pmYears  = deepMode ? 15 : 10;
    const oaLimit  = deepMode ? 30 : 15;
    
    const [s2Res, pmRes, oaRes, gdeltRes] = await Promise.allSettled([
      fetchSemanticScholar(frame.searchTerms?.semantic || query, s2Limit),
      fetchPubMed(frame.searchTerms?.pubmed || query, pmLimit, pmYears),
      fetchOpenAlex(frame.searchTerms?.openAlex || query, oaLimit),
      fetchMedia(frame, deepMode),
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
    // fall back to requiring the CORE intervention terms in title only (not all synonyms)
    let papers;
    if (filtered.length < 4) {
      console.warn(`  ⚠ Hard filter too strict (${filtered.length}), trying title-only fallback`);
      // Use only requiredTerms (the core entity words), not all synonyms
      const coreTerms = (frame.requiredTerms || []).map(t => t.toLowerCase()).filter(t => t.length >= 3);
      const titleFiltered = rawPapers.filter(p => {
        const titleText = p.title.toLowerCase();
        return coreTerms.some(term => {
          if (term.includes('-') || term.includes(' ')) {
            const exactMatch = titleText.includes(term.toLowerCase());
            const wordMatch = term.split(/[-\s]+/).every(subterm => {
              if (subterm.length < 3) return true;
              const wordRegex = new RegExp(`\\b${subterm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
              return wordRegex.test(titleText);
            });
            return exactMatch || wordMatch;
          } else {
            const wordRegex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            return wordRegex.test(titleText);
          }
        });
      });
      console.log(`  Title-only fallback: ${titleFiltered.length} papers`);
      papers = titleFiltered.length >= 3 ? titleFiltered : filtered; // Lower threshold
    } else {
      papers = filtered;
    }

    if (papers.length < 3) {
      return res.status(404).json({
        error: `Only ${papers.length} relevant paper(s) found after filtering across all three databases. "${query}" may be too niche, use non-standard terminology, or be a very new topic. Try: "${frame.intervention}" alone, or check the spelling.`
      });
    }

    // Cap papers based on mode (prioritise metas/RCTs and most cited)
    const maxPapers = deepMode ? 60 : 30;
    papers = papers
      .sort((a, b) => {
        const designScore = d => ({ umbrella:5, meta:4, rct:3, cohort:2, unknown:1 }[d]||1);
        return (designScore(b.design) * 2 + (b.citations || 0) * 0.001) -
               (designScore(a.design) * 2 + (a.citations || 0) * 0.001);
      })
      .slice(0, maxPapers);

    console.log(`  Final: ${papers.length} papers for analysis`);
    console.log(`  Design mix: ${papers.reduce((a,p) => { a[p.design]=(a[p.design]||0)+1; return a; }, {})}`);

    // ── 3.5. CLAUDE HAIKU RELEVANCE VALIDATION ───────────────────────
    // Final semantic filter to catch any irrelevant papers that slipped through
    console.log('  Running semantic relevance check...');
    const validatedPapers = await validateRelevanceWithClaude(papers, frame);
    console.log(`  Semantic filter: ${papers.length} → ${validatedPapers.length} papers`);

    // ── 4. Extract outcomes + analyse media in parallel ───────────
    console.log('  Extracting outcomes...');
    const [extractions, mediaAnalysis] = await Promise.all([
      extractOutcomes(validatedPapers, frame, deepMode),
      analyzeMedia(frame.plain, rawMedia, frame),
    ]);
    console.log(`  Extracted: ${extractions.length} outcome sets`);

    console.log(`\n🟢🟢🟢 CRITICAL PAPER FUNDING DEBUG 🟢🟢🟢`);
    validatedPapers.forEach((p, i) => {
      console.log(`📋 Paper ${i+1}: ${p.title?.slice(0, 30)}...`);
      console.log(`   Source: ${p.source}`);
      console.log(`   DOI: ${p.doi || 'none'}`);
      console.log(`   PMID: ${p.pmid || 'none'}`);
      console.log(`   fundingData: ${JSON.stringify(p.fundingData)}`);
      console.log(`   ────────────────────────────────`);
    });
    console.log(`🟢🟢🟢 END CRITICAL PAPER DEBUG 🟢🟢🟢\n`);

    // ── FUNDING TRANSPARENCY ANALYSIS ─────────────────────────────────
    console.log(`\n🔍 FUNDING DEBUG START ═══════════════════════`);
    extractions.forEach((ex, i) => {
      console.log(`📋 Study ${i+1}: ${ex.ref || 'no-ref'}`);
      console.log(`   AI Funding: ${JSON.stringify(ex.funding || 'NONE')}`);
      console.log(`   DB Funding: ${JSON.stringify(ex.fundingData || 'NONE')}`);
      console.log(`   Merged: ${JSON.stringify(ex.mergedFunding || 'NONE')}`);
    });
    console.log(`🔍 FUNDING DEBUG END ═══════════════════════\n`);
    
    const fundingAnalysis = analyzeFundingTransparency(extractions);
    console.log(`  Funding analysis: ${fundingAnalysis.totalStudies} studies, ${fundingAnalysis.biasRisk} bias risk`);

    // Attach extraction data back to papers for the frontend
    console.log(`\n📄 PAPER FUNDING DEBUG ═══════════════════════`);
    validatedPapers.forEach((p, i) => {
      console.log(`Paper ${i+1}: ${p.title?.slice(0, 40)}... (${p.source})`);
      console.log(`   fundingData: ${JSON.stringify(p.fundingData || 'NONE')}`);
      console.log(`   openalexId: ${p.openalexId || 'NONE'}`);
    });
    console.log(`📄 PAPER FUNDING DEBUG END ═══════════════════════\n`);
    
    validatedPapers.forEach(p => {
      console.log(`\n🔗 MATCHING PAPER: ${p.title?.slice(0, 40)}...`);
      console.log(`   Paper DOI: ${p.doi}, PMID: ${p.pmid}`);
      console.log(`   Paper fundingData: ${JSON.stringify(p.fundingData)}`);
      
      const ex = extractions.find(e => {
        if (!e.ref) return false;
        if (p.doi  && e.ref.toLowerCase().includes(p.doi.toLowerCase()))  return true;
        if (p.pmid && e.ref.toLowerCase().includes(p.pmid.toLowerCase())) return true;
        return false;
      });
      
      if (ex) {
        console.log(`   ✅ Found extraction: ${ex.ref}`);
        console.log(`   Extraction AI funding: ${JSON.stringify(ex.funding)}`);
        
        p.design     = ex.design    || p.design;
        p.sampleSize = ex.sampleSize;
        p.extractedOutcomes = ex.outcomes;
        
        // Merge funding data from all sources (API + AI extraction)
        const mergedFunding = mergeFundingData(ex, p.fundingData);
        console.log(`   🔄 Merge result: ${JSON.stringify(mergedFunding)}`);
        
        p.fundingAnalysis = mergedFunding;
        ex.mergedFunding = mergedFunding; // Store for aggregation analysis
      } else {
        console.log(`   ❌ No matching extraction found`);
      }
    });

    // Background enhancement: Fetch OpenAlex funding data for OpenAlex papers
    const openAlexPapers = validatedPapers.filter(p => p.openalexId);
    if (openAlexPapers.length > 0) {
      console.log(`  Background: Fetching funding for ${openAlexPapers.length} OpenAlex papers...`);
      // Don't wait for this - do it in background
      Promise.allSettled(openAlexPapers.slice(0, 5).map(async (paper) => {
        const fundingData = await fetchOpenAlexFundingData(paper.openalexId);
        if (fundingData && fundingData.sources?.length > 0) {
          paper.fundingAnalysis = mergeFundingData({ funding: fundingData }, paper.fundingAnalysis);
          console.log(`    Enhanced: ${paper.title.slice(0, 40)}... - ${fundingData.sources.join(', ')}`);
        }
      })).catch(() => {});
    }

    // ── 5. Deterministic scoring ──────────────────────────────────
    const scoring = computeConsensus(extractions);
    console.log(`  Score: ${scoring.score}/100 | Certainty: ${scoring.certainty} | Contradiction: ${scoring.contradiction} | n=${scoring.evidenceCount}`);

    // ── 6. Synthesis + verdict + divergence analysis in parallel ──
    console.log('  Synthesizing...');
    const [summary, verdict, divergenceAnalysis] = await Promise.all([
      synthesize(frame, validatedPapers, scoring),
      generateVerdict(frame, scoring),
      analyzeDivergence(frame, validatedPapers, scoring, rawMedia, mediaAnalysis),
    ]);
    console.log(`  Verdict: "${verdict.slice(0, 80)}..."`);
    if (divergenceAnalysis) console.log(`  Divergence: ${divergenceAnalysis.category} (${divergenceAnalysis.confidence})`);

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
    const sourceCounts = validatedPapers.reduce((a,p) => { a[p.source||'?']=(a[p.source||'?']||0)+1; return a; }, {});

    console.log(`  ✓ Done in ${Date.now()-t0}ms | sources: ${JSON.stringify(sourceCounts)}`);
    console.log(`${'═'.repeat(60)}`);

    const result = {
      queryMeta: {
        plain:       frame.plain,
        leftSide:      frame.leftClaim,
        leftDesc:      frame.leftDesc,
        rightSide:     frame.rightClaim,
        rightDesc:     frame.rightDesc,
        axisLeftLabel: frame.axisLeftLabel  || 'No effect',
        axisRightLabel:frame.axisRightLabel || 'Beneficial',
        isDebatable: frame.isDebatable,
        domain:      frame.domain,
      },
      papers: validatedPapers,
      fundingAnalysis: fundingAnalysis,
      analysis: {
        verdict,
        summary,
        debate: {
          leftLabel:          frame.leftClaim,
          leftDesc:           frame.leftDesc,
          rightLabel:         frame.rightClaim,
          rightDesc:          frame.rightDesc,
          axisLeftLabel:      frame.axisLeftLabel  || 'No effect',
          axisRightLabel:     frame.axisRightLabel || 'Beneficial',
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
      divergenceAnalysis,
      meta: {
        paperCount:        validatedPapers.length,
        paperCountRaw:     rawPapers.length,
        paperCountFiltered: papers.length,
        sourceCounts,
        certainty:     scoring.certainty,
        contradiction: scoring.contradiction,
        score:         scoring.score,
        durationMs:    Date.now() - t0,
        deepMode:      deepMode || false,
        trackTopic:    trackTopic || false,
        algorithm:     'v8-word-boundary-fix',
        requiredTerms: frame.requiredTerms,
        synonyms:      frame.synonyms,
        fromCache:     false,
      }
    };

    // ── TRACK TOPIC INTEGRATION ──────────────────────────────────
    if (trackTopic && db) {
      try {
        // Trigger topic tracking for this query
        const trackingResult = await fetch('/api/incremental/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            query: frame.plain, 
            deep_mode: deepMode || false 
          })
        }).then(res => res.json()).catch(err => ({ error: err.message }));
        
        if (trackingResult.success) {
          result.meta.trackingEnabled = true;
          result.meta.topicId = trackingResult.topic_id;
          console.log(`  ✓ Topic tracked: ID ${trackingResult.topic_id}`);
        } else {
          console.warn(`  ⚠ Topic tracking failed: ${trackingResult.error || trackingResult.message}`);
          result.meta.trackingEnabled = false;
          result.meta.trackingError = trackingResult.error || trackingResult.message;
        }
      } catch (error) {
        console.warn(`  ⚠ Topic tracking error: ${error.message}`);
        result.meta.trackingEnabled = false;
        result.meta.trackingError = error.message;
      }
    }

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
