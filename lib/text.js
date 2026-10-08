// ─────────────────────────────────────────────────────────────────
//  Text utilities: entity decoding, term matching, grounding checks.
// ─────────────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ge: '≥', le: '≤', plusmn: '±', times: '×', minus: '−', ndash: '–', mdash: '—',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', mu: 'μ', kappa: 'κ', chi: 'χ',
  deg: '°', middot: '·', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}
function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

// Strip tags, decode entities, collapse whitespace.
function cleanText(str) {
  return decodeEntities(String(str || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Normalised form used for fuzzy-but-strict comparisons.
function norm(str) {
  return cleanText(str)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[“”«»„]/g, '"').replace(/[‘’‚]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────
//  Term matching for the hard relevance gate.
//
//  Fixes two bugs in the v6–v8 filter:
//   • Plurals: "statin" did not match "statins". We now accept an
//     optional plural suffix on the final word of a term.
//   • Vacuous match: in multi-word terms, subterms shorter than three
//     characters were skipped, so "vitamin d" matched "vitamin c".
//     Multi-word / hyphenated terms must now match as a phrase, with
//     space and hyphen treated as interchangeable.
// ─────────────────────────────────────────────────────────────────
function termRegex(term) {
  const t = norm(term);
  if (!t) return null;
  const parts = t.split(/[\s-]+/).filter(Boolean).map(escRe);
  if (!parts.length) return null;
  const last = parts.length - 1;
  // Plural/inflection only on alphabetic final words ≥ 3 chars
  if (/^[a-z]{3,}$/.test(parts[last])) parts[last] += '(?:s|es)?';
  const body = parts.join('[\\s-]+');
  return new RegExp(`(?:^|[^a-z0-9])${body}(?![a-z0-9])`, 'i');
}

function buildMatcher(terms) {
  const regexes = [...new Set((terms || []).map(t => String(t || '').trim()).filter(t => t.length >= 2))]
    .map(t => ({ term: t, re: termRegex(t) }))
    .filter(x => x.re);
  return {
    terms: regexes.map(r => r.term),
    matches(text) {
      const n = norm(text);
      return regexes.filter(r => r.re.test(n)).map(r => r.term);
    },
    test(text) {
      const n = norm(text);
      return regexes.some(r => r.re.test(n));
    },
  };
}

// ─────────────────────────────────────────────────────────────────
//  Grounding checks — cheap deterministic hallucination guards.
// ─────────────────────────────────────────────────────────────────

// Quote must appear verbatim (modulo whitespace / dashes / case) in source.
function quoteIsGrounded(quote, source) {
  const q = norm(quote).replace(/[.;,]+$/, '');
  if (q.length < 12) return false;
  return norm(source).includes(q);
}

// Numbers that carry meaning: decimals, percentages, ratios, CIs.
// Integers below 10 and four-digit years are ignored.
function significantNumbers(text) {
  const out = [];
  for (const m of norm(text).matchAll(/-?\d+(?:\.\d+)?/g)) {
    const s = m[0].replace(/^-/, '');
    const n = parseFloat(s);
    if (!s.includes('.') && n < 10) continue;
    if (!s.includes('.') && n >= 1900 && n <= 2100) continue;
    out.push(s);
  }
  return out;
}

// True if every significant number in `text` appears in `sources`.
function numbersGrounded(text, sources) {
  const pool = new Set(significantNumbers(sources.join(' ')));
  return significantNumbers(text).every(n => pool.has(n) || pool.has(n.replace(/\.0+$/, '')));
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = {
  decodeEntities, cleanText, norm, termRegex, buildMatcher,
  quoteIsGrounded, significantNumbers, numbersGrounded, escapeHtml,
};
