// ─────────────────────────────────────────────────────────────────
//  HTTP hardening without extra dependencies:
//  security headers, CORS allowlist, admin token, per-IP rate limits.
// ─────────────────────────────────────────────────────────────────
const crypto = require('crypto');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // The pages use inline <script>/<style> blocks today.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "media-src 'self'",
    `connect-src 'self' ${process.env.BUGBOT_ORIGIN || 'https://bugbot-production-f901.up.railway.app'}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
}

// Same-origin requests carry no Origin header for GET, and browsers
// send Origin = our own host for same-origin POST. Anything else must
// be on ALLOWED_ORIGINS.
function corsAllowlist() {
  const allowed = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    // Compare hosts, not full origins: behind a TLS-terminating proxy
    // req.protocol can read "http" while the browser sends https://.
    let originHost = '';
    try { originHost = new URL(origin).host; } catch {}
    const ok = originHost === req.get('host') || allowed.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!ok) return res.status(403).json({ error: 'Origin not allowed' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  const given = req.get('x-admin-token') || '';
  if (!token || !given) return false;
  const a = Buffer.from(token), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_TOKEN) return res.status(503).json({ error: 'Admin endpoints disabled (ADMIN_TOKEN not set)' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin token required' });
  next();
}

// Fixed-window limiter keyed by client IP. `cost` lets deep searches
// count for more. In-memory: fine for a single instance; use a shared
// store if you scale horizontally.
function rateLimiter({ windowMs, max, cost = () => 1, name = 'rate' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60000)).unref();
  return (req, res, next) => {
    if (isAdmin(req)) return next();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
    const c = cost(req);
    if (e.n + c > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: `Too many searches — please wait ${Math.ceil((e.reset - now) / 60000)} minute(s) and try again.`, limit: name });
    }
    e.n += c;
    next();
  };
}

// Global daily ceiling on uncached pipeline runs — a backstop against
// cost abuse that per-IP limits cannot stop (many IPs).
function dailyBudget(maxRuns) {
  let day = new Date().toISOString().slice(0, 10), used = 0;
  return {
    take(cost = 1) {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== day) { day = today; used = 0; }
      if (used + cost > maxRuns) return false;
      used += cost; return true;
    },
    status() { return { day, used, max: maxRuns }; },
  };
}

module.exports = { securityHeaders, corsAllowlist, requireAdmin, isAdmin, rateLimiter, dailyBudget };
