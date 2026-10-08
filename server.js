// ═════════════════════════════════════════════════════════════════
//  Verity — Evidence Synthesis Engine  v9
//
//  HTTP layer only. The analysis pipeline lives in lib/pipeline.js,
//  the scoring engine in lib/scoring.js. See REVIEW-2026-10.md for the
//  rationale behind the v9 changes.
// ═════════════════════════════════════════════════════════════════
require('dotenv').config();
const express   = require('express');
const path      = require('path');
const crypto    = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool }  = require('pg');

const { runAnalysis, PipelineError } = require('./lib/pipeline');
const { ALGORITHM_VERSION } = require('./lib/scoring');
const llm = require('./lib/llm');
const { securityHeaders, corsAllowlist, requireAdmin, isAdmin, rateLimiter, dailyBudget } = require('./lib/security');
const VerityDatabaseMigration = require('./database-migration.js');
const IncrementalWorker = require('./incremental-worker.js');

// Express 4 does not forward rejected promises to the error handler.
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1)); // Railway / Render sit behind one proxy
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(corsAllowlist());
app.use(express.json({ limit: '64kb' }));
// Only the public/ directory is served — server code, pitch.html and
// audit documents are not web-accessible.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function assertModelsAvailable() {
  let verified = 0;
  for (const id of [llm.MODEL_REASONING, llm.MODEL_CLASSIFIER]) {
    try { await anthropic.models.retrieve(id); verified++; }
    catch (e) {
      if (e?.status === 404) {
        console.error(`\n✗ FATAL: model "${id}" does not exist (404) — it has likely been retired.`);
        console.error('  Set MODEL_REASONING / MODEL_CLASSIFIER to current model IDs.\n');
        process.exit(1);
      }
      console.warn(`⚠ Could not verify model "${id}": ${e.message} — starting anyway`);
    }
  }
  if (verified === 2) console.log(`✓ Models OK: ${llm.MODEL_REASONING} + ${llm.MODEL_CLASSIFIER}`);
}

// ─────────────────────────────────────────────────────────────────
//  DATABASE (optional) — result cache + per-paper extraction cache
// ─────────────────────────────────────────────────────────────────
let db = null;
if (process.env.DATABASE_URL) {
  const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Verify TLS by default. Set DATABASE_SSL_NO_VERIFY=true only for
    // providers with self-signed certs you cannot pin.
    ssl: local ? false : { rejectUnauthorized: process.env.DATABASE_SSL_NO_VERIFY !== 'true' },
    max: 5,
  });
  db.on('error', err => console.error('DB pool error:', err.message));
}

let incrementalWorker = null;
async function initDB() {
  if (!db) return;
  try {
    const migration = new VerityDatabaseMigration(db);
    await migration.runMigrations();
    db.migration = migration;
    console.log('✓ Database migrations completed');
    // The worker re-runs the real pipeline for tracked topics. It is
    // opt-in because every run costs API spend.
    if (process.env.INCREMENTAL_WORKER === 'on') {
      incrementalWorker = new IncrementalWorker(db, query => analyze(query, { deepMode: false }));
      await incrementalWorker.start();
    }
  } catch (e) {
    console.warn('DB migration failed:', e.message);
    db = null;
  }
}

// Cache key: word order matters ("does smoking cause depression" ≠
// "does depression cause smoking"), and so do mode and algorithm
// version — a scoring fix must not keep serving old answers.
function normaliseQuery(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function cacheKey(raw, deepMode) {
  return crypto.createHash('sha256')
    .update(`${ALGORITHM_VERSION}|${llm.PROMPT_VERSION}|${deepMode ? 'deep' : 'std'}|${normaliseQuery(raw)}`)
    .digest('hex');
}
const CACHE_TTL_DAYS = 30;

async function getCached(raw, deepMode) {
  if (!db) return null;
  try {
    const hash = cacheKey(raw, deepMode);
    const r = await db.query(
      `SELECT result_json FROM query_cache WHERE query_hash = $1 AND updated_at > NOW() - make_interval(days => $2)`,
      [hash, CACHE_TTL_DAYS]
    );
    if (!r.rows.length) return null;
    db.query('UPDATE query_cache SET hit_count = hit_count + 1 WHERE query_hash = $1', [hash]).catch(() => {});
    return r.rows[0].result_json;
  } catch (e) { console.warn('Cache read error:', e.message); return null; }
}

async function setCached(raw, deepMode, result) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO query_cache (query_hash, query_raw, query_plain, result_json, paper_count, certainty, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (query_hash) DO UPDATE SET result_json = EXCLUDED.result_json, paper_count = EXCLUDED.paper_count,
         certainty = EXCLUDED.certainty, score = EXCLUDED.score, updated_at = NOW()`,
      [cacheKey(raw, deepMode), raw, result.queryMeta.plain, JSON.stringify(result), result.meta.paperCount, result.meta.certainty, result.meta.score]
    );
  } catch (e) { console.warn('Cache write error:', e.message); }
}

const extractionStore = {
  async getExtractions(keys) {
    if (!db || !keys.length) return new Map();
    const r = await db.query('SELECT cache_key, extraction FROM paper_extractions WHERE cache_key = ANY($1)', [keys]);
    return new Map(r.rows.map(x => [x.cache_key, x.extraction]));
  },
  async putExtractions(pairs) {
    if (!db || !pairs.length) return;
    for (const [k, v] of pairs) {
      await db.query(
        `INSERT INTO paper_extractions (cache_key, extraction) VALUES ($1,$2)
         ON CONFLICT (cache_key) DO UPDATE SET extraction = EXCLUDED.extraction, created_at = NOW()`,
        [k, JSON.stringify(v)]);
    }
  },
};

function analyze(query, opts) {
  return runAnalysis(query, opts, {
    client: anthropic,
    store: db ? extractionStore : null,
    log: m => console.log(`  ${m}`),
  });
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'verity.html')));

app.get('/health', async (_, res) => {
  const dbOk = db ? await db.query('SELECT 1').then(() => true).catch(() => false) : false;
  res.json({ ok: true, version: '9.0', algorithm: ALGORITHM_VERSION, cache: dbOk ? 'connected' : db ? 'error' : 'disabled' });
});

const searchLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.SEARCHES_PER_HOUR || 20),
  cost: req => (req.body?.deepMode ? 3 : 1),
  name: 'search',
});
const budget = dailyBudget(Number(process.env.MAX_PIPELINE_RUNS_PER_DAY || 500));
const inflight = new Map(); // coalesce identical concurrent searches

app.post('/api/search', searchLimiter, async (req, res) => {
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });
  if (query.length > 300) return res.status(400).json({ error: 'Please keep questions under 300 characters.' });
  const deepMode = !!req.body?.deepMode;
  // Cache bypass is an admin-only operation: it costs a full pipeline run.
  const forceRefresh = !!req.body?.forceRefresh && isAdmin(req);
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] "${query}"${deepMode ? ' (deep)' : ''}${forceRefresh ? ' (refresh)' : ''}`);

  if (!forceRefresh) {
    const cached = await getCached(query, deepMode);
    if (cached) {
      cached.meta = { ...cached.meta, fromCache: true, durationMs: Date.now() - t0 };
      return res.json(cached);
    }
  }

  const key = cacheKey(query, deepMode);
  if (!inflight.has(key)) {
    if (!budget.take(deepMode ? 3 : 1)) {
      return res.status(503).json({ error: 'Verity has reached its daily analysis limit. Cached answers are still available — please try again tomorrow.' });
    }
    const p = analyze(query, { deepMode })
      .then(async result => {
        delete result._scoring;
        await setCached(query, deepMode, result);
        if (req.body?.trackTopic && db) {
          result.meta.trackingEnabled = await trackTopic(query, result, deepMode).then(() => true).catch(e => { console.warn('track failed:', e.message); return false; });
        }
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }

  try {
    const result = await inflight.get(key);
    console.log(`  ✓ ${result.meta.flow.scored} studies scored in ${Date.now() - t0}ms`);
    res.json(result);
  } catch (err) {
    const status = err instanceof PipelineError ? err.status : 500;
    console.error('  ✗', err.message);
    res.status(status).json({
      error: status === 500 ? 'The analysis failed unexpectedly. Please try again in a minute.' : err.message,
    });
  }
});

// Bug reports are proxied so the shared secret stays on the server.
const bugLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 10, name: 'bug' });
app.post('/api/bug-report', bugLimiter, async (req, res) => {
  const url = process.env.BUGBOT_WEBHOOK;
  if (!url) return res.status(503).json({ error: 'Bug reporting not configured' });
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.BUGBOT_SECRET) headers['x-bugbot-secret'] = process.env.BUGBOT_SECRET;
    if (req.get('x-turnstile-token')) headers['x-turnstile-token'] = req.get('x-turnstile-token');
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(req.body || {}), signal: AbortSignal.timeout(10000) });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch (e) {
    res.status(502).json({ error: 'Bug report service unavailable' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  TOPIC TRACKING
// ─────────────────────────────────────────────────────────────────
async function trackTopic(query, result, deepMode) {
  const hash = crypto.createHash('sha256').update(normaliseQuery(query)).digest('hex');
  const d = result.analysis.debate;
  const usable = d.evidenceState !== 'insufficient';
  const r = await db.query(
    `INSERT INTO topics (query_hash, canonical_query, plain_query, priority_level, update_frequency_hours,
       current_consensus_score, current_consensus_pct, current_certainty, current_paper_count, last_full_analysis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (query_hash) DO UPDATE SET current_consensus_score = EXCLUDED.current_consensus_score,
       current_consensus_pct = EXCLUDED.current_consensus_pct, current_certainty = EXCLUDED.current_certainty,
       current_paper_count = EXCLUDED.current_paper_count, last_full_analysis = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [hash, query, result.queryMeta.plain, deepMode ? 1 : 2, deepMode ? 24 : 168,
     usable ? d.score : null, usable ? d.rightPct : null, d.certainty, result.meta.paperCount]);
  if (r.rows[0].inserted) {
    // We just analysed it — the first re-check is one update period out.
    await db.query(
      `INSERT INTO update_queue (topic_id, scheduled_for, priority, update_type)
       VALUES ($1, NOW() + make_interval(hours => $2), $3, 'scheduled')`,
      [r.rows[0].id, deepMode ? 24 : 168, deepMode ? 1 : 2]).catch(() => {});
  }
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────
//  ADMIN ROUTES (require X-Admin-Token)
// ─────────────────────────────────────────────────────────────────
app.delete('/api/cache', requireAdmin, ah(async (req, res) => {
  if (!db) return res.json({ ok: false, reason: 'no database' });
  const { query, all, deepMode } = req.body || {};
  if (all) { await db.query('DELETE FROM query_cache'); return res.json({ ok: true, action: 'cleared all' }); }
  if (query) { await db.query('DELETE FROM query_cache WHERE query_hash = $1', [cacheKey(query, !!deepMode)]); return res.json({ ok: true }); }
  res.status(400).json({ error: 'provide query or all:true' });
}));

app.get('/api/cache/stats', requireAdmin, ah(async (_, res) => {
  if (!db) return res.json({ enabled: false });
  const r = await db.query('SELECT COUNT(*)::INT AS total, AVG(hit_count)::INT AS avg_hits, MIN(created_at) AS oldest, MAX(updated_at) AS newest FROM query_cache');
  const top = await db.query('SELECT query_raw, certainty, score, hit_count, updated_at FROM query_cache ORDER BY hit_count DESC LIMIT 10');
  res.json({ enabled: true, stats: r.rows[0], top_queries: top.rows, budget: budget.status() });
}));

app.get('/api/incremental/status', requireAdmin, ah(async (_, res) => {
  if (!db) return res.json({ status: 'disabled' });
  const [t, q] = await Promise.all([
    db.query('SELECT COUNT(*)::INT AS n FROM topics'),
    db.query("SELECT COUNT(*)::INT AS n FROM update_queue WHERE status = 'pending'"),
  ]);
  res.json({ status: incrementalWorker ? 'running' : 'off', topics: t.rows[0].n, pending: q.rows[0].n, worker: incrementalWorker?.getStatus() || null });
}));

app.get('/api/incremental/topics', requireAdmin, ah(async (_, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const r = await db.query(`SELECT id, canonical_query, plain_query, current_consensus_score, current_consensus_pct,
    current_certainty, current_paper_count, last_incremental_update, priority_level, is_active, created_at
    FROM topics ORDER BY priority_level ASC, created_at DESC LIMIT 50`);
  res.json({ success: true, topics: r.rows });
}));

app.use((err, req, res, _next) => {
  console.error('Unhandled:', err.message);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal error' });
});

// ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, async () => {
    if (!process.env.ADMIN_TOKEN) console.warn('⚠ ADMIN_TOKEN not set — admin endpoints are disabled.');
    await assertModelsAvailable();
    await initDB();
    console.log(`\n🔬 Verity v9 → http://localhost:${PORT}`);
    console.log(`   Algorithm: ${ALGORITHM_VERSION} · prompts ${llm.PROMPT_VERSION}`);
    console.log('   Sources:   PubMed + Europe PMC + Semantic Scholar + OpenAlex');
    console.log('   Cache:     ' + (db ? `PostgreSQL (${CACHE_TTL_DAYS}-day TTL)` : 'disabled (no DATABASE_URL)') + '\n');
  });
}

module.exports = { app, cacheKey, normaliseQuery };
