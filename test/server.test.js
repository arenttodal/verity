// HTTP-layer security checks against the real Express app.
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.SEARCHES_PER_HOUR = '3'; // the CORS test uses one, validation tests two
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const { app, cacheKey } = require('../server');

let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('source code, pitch deck and audit docs are not served', async () => {
  for (const p of ['/server.js', '/pitch.html', '/package.json', '/.env', '/lib/llm.js', '/AUDIT.md']) {
    const r = await fetch(base + p);
    assert.notEqual(r.status, 200, p);
  }
  const ok = await fetch(base + '/about.html');
  assert.equal(ok.status, 200);
});

test('security headers are set', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('served pages contain no bug-report secret', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.ok(!/BUGBOT_SECRET\s*=/.test(html));
  assert.ok(!html.includes('2977355fe1f00d72c6b1f61115b0d531'));
});

test('admin endpoints require the token', async () => {
  assert.equal((await fetch(base + '/api/cache/stats')).status, 401);
  assert.equal((await fetch(base + '/api/cache', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"all":true}' })).status, 401);
  assert.equal((await fetch(base + '/api/incremental/topics')).status, 401);
  const ok = await fetch(base + '/api/cache/stats', { headers: { 'x-admin-token': 'test-admin-token' } });
  assert.equal(ok.status, 200);
});

test('cross-origin requests from unknown sites are refused', async () => {
  const r = await fetch(base + '/api/search', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"query":""}',
  });
  assert.equal(r.status, 403);
  // Same host via https (as seen behind a TLS proxy) is allowed through to validation
  const host = new URL(base).host;
  const same = await fetch(base + '/api/search', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `https://${host}` }, body: '{"query":""}',
  });
  assert.notEqual(same.status, 403);
});

test('search input validation and per-IP rate limit', async () => {
  const post = body => fetch(base + '/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ query: '' })).status, 400);
  assert.equal((await post({ query: 'x'.repeat(301) })).status, 400);
  // limit is 3/hour and 3 are used; deep mode costs 3 → rejected
  const deep = await post({ query: 'x'.repeat(301), deepMode: true });
  assert.equal(deep.status, 429);
});

test('cache key respects word order and mode', () => {
  assert.notEqual(cacheKey('does smoking cause depression'), cacheKey('does depression cause smoking'));
  assert.notEqual(cacheKey('coffee', false), cacheKey('coffee', true));
  assert.equal(cacheKey('Coffee?', false), cacheKey('coffee', false));
});
