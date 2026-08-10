# Verity — Engineering & Methodology Audit

**Date:** 2026-08-09 · **Commit audited:** `dab58b0` · **Branch:** `claude/website-audit-overhaul-muhhns`

Five specialist audits (backend architecture, evidence-synthesis methodology, frontend/design,
application security, claims-vs-code) run in parallel over `server.js` (2,794 lines),
`verity.html` (3,103 lines), `about.html`, `pitch.html`, `share.html`, `bugbot-widget.js`,
`database-migration.js`, `incremental-worker.js`.

Every load-bearing claim below was re-verified first-hand against the source before inclusion.
Findings the agents asserted but that did not survive verification were dropped.

---

## Verdict

The architecture is sound and the core idea is genuinely differentiated. The retrieve →
filter → extract → score → narrate pipeline is the right shape, the separation of
*directional confidence* from *causal certainty* is a real intellectual contribution, and the
science-vs-media divergence layer does not exist elsewhere.

The estimator sitting inside that architecture does not measure what the product says it
measures, and two of its five declared inputs are permanently `undefined`.

Three things are true at once, and they should be held separately:

1. **The scoring engine is not a consensus measure.** It is a weighted vote count over
   LLM-assigned direction labels, and effect magnitude algebraically cancels out of it.
2. **The product ships fabricated data.** Random numbers are written to the database as
   consensus scores and served from a public endpoint; study positions on the evidence strip
   are `Math.random()`.
3. **The public API has no authentication, no rate limiting, and wildcard CORS**, on endpoints
   that cost roughly $0.25 of Anthropic spend per uncached call.

---

## 1. The estimator

### 1.1 Effect magnitude cancels out

`server.js:1596` computes:

```
score = 100 · Σ(Sᵢ · Mᵢ · wᵢ) / Σ|Mᵢ · wᵢ|
```

When every study agrees, `S` is constant at ±1, so the `M·w` terms in numerator and
denominator are identical and the ratio is exactly 1 — **regardless of what `M` is**.

Reproduced against the real constants (`DESIGN_PRIOR` at `server.js:414`, `biasWeight` at
`server.js:1495`, aggregation at `server.js:1547-1600`):

| Evidence | Reported |
|---|---|
| 12 RCTs, unanimous, trivial effect (`magnitude = 0.05`) | **99% beneficial** |
| 12 RCTs, unanimous, huge effect (`magnitude = 1.00`) | **99% beneficial** |

A unanimous 0.3% improvement and a unanimous 40% improvement are the same number. The meter
measures *agreement about sign*, not effect. The UI presents it as a spectrum from Concern to
Benefit (`about.html:372`), which is a different quantity.

### 1.2 The score depends on the order papers arrive in

The independence weight (`server.js:1531-1537`) counts papers into families and assigns
`1.0 / 0.70 / 0.45` by arrival position. Because `ex.year` is never set (§2.2), the family key
collapses to design alone — so position in the array becomes a first-class scoring input.

Identical evidence — 6 supporting, 6 opposing — scored three ways:

| Ordering | Result |
|---|---|
| Supporting papers first | **57% beneficial** |
| Opposing papers first | **44% beneficial** |
| Interleaved | **53% beneficial** |

**A 13-point swing from array position alone**, and a perfect tie never reports 50%. Papers are
concatenated S2 → PubMed → OpenAlex (`server.js:2479-2483`), so the score partly reflects which
API answered first.

### 1.3 Three different states collapse to 50%

`score = 0 → rightPct = 50` (`server.js:1596-1600`). Verified outputs:

- 12 studies, all precise nulls → **50%**
- 12 studies, perfect conflict → **50%** (before the ordering artifact above)
- Fewer than 3 papers → 404

*Evidence of no effect*, *genuine controversy*, and *no evidence* are the three states an
evidence-synthesis tool exists to distinguish. They render identically.

### 1.4 "Mixed" is scored as 15% pro-benefit

`server.js:1522`: `{ supports_right: 1.0, supports_left: -1.0, neutral: 0.0, mixed: 0.15 }`

`frameQuery` hard-codes right = safe/beneficial (`server.js:473-489`), so every ambiguous study
nudges the answer toward reassurance. A literature of entirely mixed findings scores **58%
beneficial**. No rationale for the asymmetry appears anywhere in the code.

### 1.5 Study design is counted twice

`D = DESIGN_PRIOR[design]` (`server.js:1550`) and `B = biasWeight(design, …)`
(`server.js:1551`) are both pure functions of the same variable, so design enters the weight
squared.

`about.html:425` claims a meta-analysis is weighted "orders of magnitude" above an
observational study. Actual ratio: **1.76×**. Four cross-sectional surveys outvote one
meta-analysis.

### 1.6 The contradiction index cannot reach its documented range

`server.js:1604`: `2·L·R/(L+R)²` maxes at **0.5** at perfect split, not 1. Consequences:

- `agreement = 1 - contradiction` (`:1608`) is floored at 0.5 — it can never signal real disagreement.
- Certainty thresholds at `:1613-1622` are calibrated against a scale that does not exist.
- Claude is told "1 = evenly split" in both `synthesize` (`:1669`) and `generateVerdict` (`:1727`) — the narrative model is systematically told disagreement is half its actual size.

### 1.7 Certainty counts outcomes, not studies

`qualityCount` increments per outcome (`server.js:1577`), and extraction requests multiple
outcomes per paper. `volume = min(1, qualityCount/12)` (`:1609`) therefore saturates at about
**four papers**, and "High" certainty requires `qualityCount >= 8` — roughly three papers.

Compounding this: because replication drives `U` to 0.45, `meanQuality` *falls* as evidence
accumulates. Eight unanimous meta-analyses compute to ≈0.41 against a 0.58 threshold — they
cannot reach "High".

### 1.8 Absent entirely

Verified by grep across `server.js`:

| Check | Occurrences |
|---|---|
| Retraction status | **0** — despite PubMed publication types already being parsed at `:637` |
| Confidence intervals / heterogeneity / prediction intervals | **0** |
| Duplicate-evidence detection (meta-analysis vs its own component trials) | **0** |
| Design categories for animal / in-vitro / case-report | **0** — forced into `obs` or `unknown`, each carrying a full directional vote |

---

## 2. Dead inputs and silent failures

### 2.1 The entire funding subsystem has zero effect on the score

`biasWeight` applies a ×0.68 industry penalty only when `ex.fundingConcern` is truthy
(`server.js:1507`). The extraction schema Claude is asked to fill (`server.js:1386-1413`)
contains a `funding` object with `industrySponsored` and `biasRisk` — but **no `fundingConcern`
field**, and nothing anywhere assigns it. All four occurrences repo-wide are reads.

Roughly 700 lines — three API integrations, an LLM extraction block, a merge function, an
aggregation pass, and a UI panel — do not move the number they are displayed beside.
`about.html:274` states industry funding is "weighted accordingly." It is not.

### 2.2 `ex.year` is never set

Read at `server.js:1533`, absent from the extraction schema. `(ex.year || 2020)` is constant, so
the independence family key degenerates to design — producing the ordering artifact in §1.2.

### 2.3 Random numbers persisted as consensus data

`incremental-worker.js:200-207` and `:220-227`:

```js
consensus_score: Math.floor(Math.random() * 200) - 100,
consensus_pct:   Math.floor(Math.random() * 100),
certainty: ['Very Low','Low','Moderate','High'][Math.floor(Math.random()*4)],
paper_count: Math.floor(Math.random() * 50) + 5,
```

These are written to `topics.current_consensus_*` (`:130-144`) and served by
`GET /api/incremental/topics` (`server.js:352-374`). The worker auto-starts whenever
`DATABASE_URL` is set (`server.js:76-80`). **This is the highest-severity item in the audit** —
for a product whose proposition is calibrated consensus, randomly generated consensus figures
reaching a public API is an integrity failure independent of everything else.

### 2.4 Extraction batches truncate and vanish

`extractOutcomes` batches 12 papers with `max_tokens: 2800` (`server.js:1351`, `:1371`). Each
paper's required JSON carries design, sample size, two match scores, a six-field funding object,
and an outcomes array with free-text notes quoting effect sizes and confidence intervals —
realistically 200–400 output tokens per paper, so 2,400–6,000 per batch. Truncation is the
expected case.

On truncation: `JSON.parse` throws → `Promise.allSettled` marks the batch rejected → one
`console.warn` (`:1478-1484`) → consensus is computed from the surviving batches, while
`meta.paperCount` still reports the full count (`:2727`). The user sees a confident percentage
derived from a fraction of the evidence, with nothing in the response disclosing the loss.

This is the most plausible cause of the "visual evidence doesn't match percentages" bug that
commit `55aa53c` attempted to fix.

### 2.5 Relevance filters fail open

`validateRelevanceWithClaude` includes a paper when parsing fails (`:1172-1175`) and includes the
entire batch when the API call fails (`:1190-1192`).

### 2.6 The hard filter has a vacuous-match hole

The filter's stated premise is that a required entity term must appear. For hyphenated or
multi-word terms, subterms shorter than 3 characters are waved through (`server.js:1049`).
Executed against the real logic:

| Required term | Paper | Passes? |
|---|---|---|
| `"n-3 fatty"` (an example from the prompt itself, `:522`) | unrelated fatty-liver paper | **yes** |
| `"B-12"` | *quantum physics* paper | **yes** — every subterm is <3 chars, so `.every()` returns true vacuously |

For any term with no subterm ≥3 characters, the gate is fully open. This is the same class of
bug the v6 rewrite was built to eliminate.

### 2.7 Model IDs are retired

Every reasoning call uses `claude-sonnet-4-20250514` (`:436, 1370, 1657, 1716, 2009, 2139, 2254,
2367`); relevance validation uses `claude-3-haiku-20240307` (`:1139`). Both are past their
published retirement dates. The Haiku failure is swallowed by design (`:1189-1193`), so the
semantic relevance gate has been a silent no-op. Move reasoning calls to `claude-opus-5` and
classifiers to `claude-haiku-4-5`.

### 2.8 Topic tracking has never worked

`server.js:2748` calls `fetch('/api/incremental/track', …)` with a **relative URL** from Node,
which throws `TypeError: Failed to parse URL`. Caught silently at `:2755`. The "Track this
topic" checkbox is checked by default (`verity.html:1093`) and does nothing.

### 2.9 Cache key erases word order

`normaliseQuery` (`server.js:90-100`) lowercases, strips stopwords, and **sorts the remaining
tokens alphabetically**. `"does smoking cause depression"` and `"does depression cause
smoking"` produce an identical SHA-256 — the second question returns the first question's
answer for 30 days. Deep mode is also absent from the cache key, so a normal search and a deep
search collide.

---

## 3. Security and cost

No SQL injection was found — every `pg` query is properly parameterized. No command injection.
No live API key committed to any branch.

| Finding | Severity |
|---|---|
| `/api/search` — no auth, no rate limit, client-controlled `forceRefresh` and `deepMode` | **Critical** |
| `DELETE /api/cache {all:true}` — unauthenticated, wipes 30 days of paid cache | **Critical** |
| Stored XSS: prompt injection in an abstract → Claude-authored HTML → `innerHTML` (`verity.html:2707`) → cached 30 days | **Critical** |
| Reflected XSS in `share.html:323` and `:353` via URL params | **High** |
| `BUGBOT_SECRET` hardcoded at `verity.html:3073`, in git history since `0ba2ca8` | **High** |
| History dropdown: `.replace(/'/g,"\'")` at `verity.html:2871` is a **no-op** — `"\'"` is just `'`. `?q=` payload persists to `localStorage` and fires on every future visit | **High** |
| `express.static(__dirname)` serves `server.js` and `pitch.html` — a document stamped "CONFIDENTIAL · DO NOT DISTRIBUTE" containing equity offers and named acquirers | **High** |
| `/api/cache/stats` and `/api/incremental/topics` publish users' raw health queries | **Medium** |
| `rejectUnauthorized: false` on Postgres TLS (`server.js:51`) | **Medium** |
| No helmet, no CSP, no security headers | **Medium** |

**Cost of abuse.** One uncached search fires ~10 Sonnet calls plus 2 Haiku calls. At current
pricing that is **$0.15–0.30 per standard search**, $0.35–0.60 deep — not the `~$0.003/query`
claimed in `README.md:13`. With wildcard CORS and a client-settable `forceRefresh`, a sustained
loop is roughly **$6,000–10,000/hour**, and any third-party site can distribute the attack
across visitors' browsers.

**Immediate actions:** rotate `BUGBOT_SECRET`; add `express-rate-limit` to `/api/search`; ignore
client-supplied `forceRefresh`/`deepMode`; put cache and incremental endpoints behind an
`ADMIN_TOKEN`; replace `cors()` with an origin allowlist; move static serving to `public/`.

---

## 4. Claims versus code

| Claim | Where | Verdict |
|---|---|---|
| "Search the entire body of published science" | `verity.html:1060` | **False** — ≤60 raw records, capped to 30 (`server.js:2534`) |
| "Papers from the last five years" | `about.html:426` | **False** — window is 10 years (15 deep) |
| "Deterministic algorithm, not an AI opinion" | `pitch.html:479` | **False** — the arithmetic is deterministic; `S`, `M`, `P`, `R` and `design` are all LLM outputs, with no `temperature` set on any call |
| "Weighted by design, bias, precision, relevance and independence" | `about.html:384` | **False** — bias and independence are dead (§2.1, §2.2) |
| "Orders of magnitude higher" | `about.html:425` | **False** — 1.76× |
| "Height reflects quality weight" | `about.html:375` | **False** — height is a citation-count bucket (`verity.html:2740`) |
| "Every number traces to a real paper… see the abstract" | `about.html:427` | **False** — `getAbstract()` (`verity.html:2111-2145`) is a hardcoded map of 15 demo vegan-study titles; real results return **"Abstract not available in this preview."** The real abstract is loaded at `:2757` and never read |
| "The UI includes a clear 'not medical advice' disclaimer" | `README.md:100` | **False** — no such text exists in `verity.html`, which has no footer at all |
| "~$0.003/query" | `README.md:13` | **False** — off by 50–100× |
| "OpenAlex data is CC0" / abstracts only | `README.md:98-101` | **True** |
| Direction and certainty shown separately | `pitch.html:527` | **True** |

`generateVerdict` (`server.js:1717`) instructs the model to write "like a trusted doctor friend"
and to "never hedge unnecessarily" — consumer health guidance, in a clinical voice, with no
disclaimer anywhere in the app.

---

## 5. Frontend and design language

### 5.1 Four features are broken in production

| Feature | Cause |
|---|---|
| Search history items | `runHistorySearch` calls `doSearch(q)` at `verity.html:2929` — **`doSearch` is defined nowhere**. Every click throws `ReferenceError` |
| "All Studies" tab | Handler queries `.sb-entry[data-idx]` (`:2033`); entries emit `data-title` (`:2063`). Matches zero elements |
| Study abstracts | Hardcoded demo map (§4) |
| Media framing analysis | `mediaFraming[m.title]` (`:2079`) — same hardcoded map; real value stored at `:2774`, never read |

### 5.2 Study positions are randomised at render

`verity.html:2368-2375`:

```js
const jitter = (Math.random() * 0.08) - 0.04;
if (stance === 'for')     return Math.min(0.95, 0.58 + w * 0.28 + jitter);
return 0.36 + Math.random() * 0.28;   // "mixed"
```

`w` is a **citation-count bucket**, not the engine's computed weight. So horizontal position on
a "Harmful ↔ Beneficial" axis encodes citation count plus noise. The server computes a real
per-paper contribution and exposes it in `scoring.contributions` (`server.js:1582-1591`); the
client ignores it.

The code acknowledges the resulting mismatch with a tooltip at `verity.html:1796-1799` — "both
are correct, they measure different things." They are not both correct.

### 5.3 Accessibility

Measured on `verity.html`:

| Metric | Count |
|---|---|
| `aria-*` attributes | **0** |
| `role=` attributes | **0** |
| `:focus-visible` rules | **0** |
| Headings (`h1`–`h6`) | **1** — hidden by `.hero.compact` on the results view |
| Non-`<button>` elements carrying `onclick` | 19 of 24 |

At least 13 distinct WCAG 1.4.3 contrast failures. `--text-muted` — which styles the entire
label layer — is `rgba(255,255,255,0.22)` = **1.89:1**. The axis labels of the primary data
visualisation are **1.41:1**. The consensus percentage itself renders at **2.11:1**.

`share.html:5` sets `maximum-scale=1.0`, blocking pinch-zoom on a page whose smallest type is
6.5px.

### 5.4 The design system is 5% built

| Metric | Count |
|---|---|
| CSS custom properties defined | 10 |
| Unique `rgba()` literals | **180** |
| Distinct `font-size` values | 19 (6.5px → 22px) |
| Distinct `border-radius` values | 13 |
| `!important` | 15 |
| `prefers-color-scheme` / `prefers-reduced-motion` | **0 / 0** |

`verity.html:26` sets `html { zoom: 1.1 }` — a global fudge factor that desynchronises media
queries from layout, so both `max-width: 600px` breakpoints fire at an effective ~545px.

### 5.5 The loading experience is fiction

`verity.html:2309-2312` advances the six-step progress checklist on hardcoded timers
`[800, 3500, 7000, 12000, 18000]`. Nothing reflects actual pipeline state. In deep mode — quoted
at "2-3 min" — the timeline exhausts at 35s and then sits on one step for up to 145 seconds.
There is no `AbortController` and no timeout: a hung backend is an infinite loading state.

`#lstep-1-count` (`:1123`) is rendered and styled for a real paper count, and never populated.

### 5.6 Distribution

No `meta description`, `og:*`, `twitter:card`, favicon, canonical, or JSON-LD on any of the four
pages. `share.html` — the viral loop — is client-rendered, so every social preview is a bare
grey box with the same static title for every result. Results live behind a POST and are never
indexable, which forfeits the entire long-tail organic channel for a search product.

`about.html:210` hotlinks a **1.83 MB** `.webm` from `raw.githubusercontent.com` with
`preload="auto"`, hidden on mobile via `display:none` — which does not prevent the download.
`verityvideo.webm` (1.79 MB) is referenced by nothing.

---

## 6. The overhaul

### P0 — integrity and safety

1. Disable the incremental worker (`server.js:76-80`) until `performTopicAnalysis` is real, or have it throw instead of returning `Math.random()`.
2. Rotate `BUGBOT_SECRET`; delete it from client HTML.
3. Rate-limit `/api/search`; stop trusting client `forceRefresh`/`deepMode`; admin-gate cache and incremental endpoints; origin-allowlist CORS.
4. Fix XSS: return structured paragraphs instead of LLM-authored HTML; `textContent` in `share.html` and the history dropdown; escape API strings at every `innerHTML` interpolation.
5. Move static serving to `public/`; take `pitch.html` off the public host.
6. Add the medical disclaimer and source attribution footer that `README.md` already claims exists.
7. Update model IDs to `claude-opus-5` / `claude-haiku-4-5`, with a boot-time assertion so a retirement fails loudly.

### P1 — make the estimator measure what it claims

8. **One row per study**, not per outcome (`server.js:1554`) — removes the multiplicity inflation of both score and certainty.
9. **Extract effects as numbers**, not ordinals: point estimate, CI bounds, n, plus a verbatim `quoted` string required to be a substring of the abstract — a cheap hallucination guard the pipeline currently lacks.
10. **Pool properly** where effects are quantifiable: random-effects with Hartung–Knapp (k is small), reporting τ², I², CI *and* a prediction interval.
11. **Where only direction exists**, replace the vote count with a Jeffreys-prior Beta interval so small samples visibly widen: `p̂ = (0.5 + succ)/(1 + n_dir)` with a 95% credible interval, displayed.
12. Collapse `D` and `B` into a single design prior; wire `fundingConcern` from `funding.biasRisk`; set `ex.year`; replace the arrival-order independence counter with structural deduplication via OpenAlex `referenced_works`.
13. Fix the contradiction index to `4·L·R/(L+R)²` and re-tune the thresholds that depend on it.
14. Add an `evidenceState` gate — `INSUFFICIENT` must suppress the meter, verdict and share card rather than rendering them at 50%.
15. Exclude retractions (PubMed publication types are already parsed at `:637`); add animal/in-vitro/case-report design categories and keep non-human evidence out of human-question consensus.
16. Raise `max_tokens` on extraction, use structured outputs, and surface `extractionFailures` in `meta` so silent data loss becomes visible.

### P2 — the interface

17. Plot the strip from `scoring.contributions`; retire `stanceToX`; delete the "both are correct" note.
18. Fix the four broken features (§5.1) — three are one-line changes against data already loaded.
19. Stream real progress over SSE; add an `AbortController` timeout; split empty / error / offline states, which currently all render as "No results found."
20. Promote the verdict to the largest body text on the page; stop collapsing the synthesis to 110px; make the paper list a first-class section rather than a sidebar tab.
21. Rebuild the token layer — semantic color scale, 7-step type scale, 8-step space scale; delete `zoom: 1.1`; ship light mode; add `prefers-reduced-motion`.
22. Headings, landmarks, real `<button>`s, `:focus-visible`, live regions, and a text alternative for the consensus meter. Raise every text pair to ≥4.5:1 and every meaningful graphic to ≥3:1.

### P3 — distribution and honesty

23. Server-render `/share` with a real OG image endpoint — the single highest-leverage growth fix in the repo.
24. Persist results and serve indexable `/q/<slug>` pages with `ClaimReview` JSON-LD.
25. Apply the copy corrections in §4. The honest framing — *structured LLM extraction plus a transparent, auditable aggregation formula* — is still a real differentiator, and it survives diligence.
26. Build the validation set: ~150 questions with adjudicated answers from Cochrane/USPSTF/WHO; measure direction accuracy, calibration, run-to-run stability, and interval coverage. Publish it. A product whose pitch is "everyone else is a little wrong" needs its own error bars.

---

## Appendix — what was checked and found clean

- **SQL injection:** none. Every query parameterized. The only interpolation is an integer constant.
- **Command injection:** none. No `child_process`, `eval`, or `new Function`.
- **Committed secrets:** none across any branch except `BUGBOT_SECRET`. `.env` was never tracked.
- **ReDoS:** low risk. Dynamic regexes escape metacharacters before interpolation.
- **npm audit:** 0 vulnerabilities across 136 dependencies.
- **Syntax:** all four JS files pass `node --check`; no duplicate top-level function definitions survive the hotfix history.
- **Outbound calls:** all carry `AbortSignal.timeout`; source fetching is properly parallel with `Promise.allSettled`.
- **Migrations:** transactional with rollback.

### Genuinely good, and worth protecting

The separation of directional confidence from causal certainty (`server.js:1666-1683`); the
deterministic-score-then-narrate architecture (`:1646`); the relevance/indirectness term
(`:1562-1564`), which maps cleanly onto GRADE; the hard lexical gate that fixed the JAK/STAT
bug; the media-divergence layer (`:2312-2429`); and the two-pin shared-axis spectrum, which is a
more honest consensus metaphor than any percentage donut.
