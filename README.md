# Verity: Science Consensus Engine

Ask a health or science question in plain language. Verity retrieves the published literature and extracts each study's finding with a verbatim quote. It then scores the evidence **outcome by outcome** on a *harmful ← no effect → beneficial* scale and shows where news coverage sits on the same scale.

> Verity summarises research with automated retrieval and AI-assisted extraction. It is **not medical advice**.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS in `public/` (served by the backend) |
| Papers | PubMed (NCBI E-utilities), Europe PMC, Semantic Scholar, OpenAlex |
| News | Guardian Open Platform, Google News RSS, Bing News RSS, NYT (optional) |
| AI | Claude, used for framing, screening, extraction and narration. The score itself is computed by deterministic code. |
| Backend | Node.js 20+ and Express, with optional PostgreSQL for caching |

**Cost:** an uncached standard search makes about 10–14 Claude calls and costs roughly $0.10–0.30. Deep mode costs about 2–3× that. Cached answers are free. Rate limits and a daily run budget protect against abuse (see the env vars below).

---

## Setup

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY (and ADMIN_TOKEN)
npm run dev               # http://localhost:3001
npm test                  # offline test suite (no API key or network needed)
npm run preview           # offline UI demo with fixture data → http://localhost:3002/?q=creatine
```

### Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required |
| `ADMIN_TOKEN` | Enables the admin endpoints (`/api/cache`, `/api/cache/stats`, `/api/incremental/*`) and cache bypass. Send it in the `X-Admin-Token` header. |
| `DATABASE_URL` | Optional Postgres for the result cache and per-paper extraction cache |
| `DATABASE_SSL_NO_VERIFY` | Set `true` only if your Postgres uses a self-signed certificate |
| `ALLOWED_ORIGINS` | Comma-separated extra origins allowed to call the API (same-origin always works) |
| `SEARCHES_PER_HOUR` | Per-IP limit (default 20; deep mode counts as 3) |
| `MAX_PIPELINE_RUNS_PER_DAY` | Global ceiling on uncached runs (default 500) |
| `MODEL_REASONING` / `MODEL_CLASSIFIER` | Override model IDs (defaults `claude-sonnet-5` / `claude-haiku-4-5`) |
| `INCREMENTAL_WORKER=on` | Re-analyse tracked topics in the background. Every run costs API spend. |
| `NCBI_API_KEY`, `S2_API_KEY`, `GUARDIAN_API_KEY`, `NYT_API_KEY` | Optional. Each one gives higher rate limits or more sources. |
| `BUGBOT_WEBHOOK`, `BUGBOT_SECRET` | Bug-report widget. The secret stays on the server; the browser posts to `/api/bug-report`. |

---

## How it works (v9)

```
question
 → frame        PICO + 1–3 prespecified outcomes (benefit/harm, which direction is better)
 → retrieve     PubMed (systematic reviews / RCTs / general) + Europe PMC + S2 + OpenAlex
 → merge        field-level dedupe (PubMed design & grants win), retractions excluded
 → gate         entity terms must appear (phrase- and plural-aware)
 → screen       LLM relevance screen
 → extract      per paper: design, n, and per-outcome direction + effect size + verbatim quote
 → verify       quote and numbers must be found in the abstract, or the finding is down-weighted
 → score        lib/scoring.js: one row per study per outcome; weights = design × precision(n) × relevance × risk-of-bias × overlap
                evidence state: insufficient / consistent benefit / consistent harm / no clear effect / conflicting / inconclusive
                pooled random-effects (Hartung–Knapp) where ≥3 comparable effect sizes exist
                GRADE-style certainty
 → narrate      synthesis with citations; sentences with unverifiable numbers are removed
 → media        headline framing on the same axis; divergence explained with factual signals only
```

All of the methodology rationale is in `REVIEW-2026-10.md`, and the earlier engineering audit is in `AUDIT.md`.

### Layout

```
server.js            HTTP layer: security, cache, admin, routes
lib/pipeline.js      orchestration (all I/O injected → testable offline)
lib/scoring.js       deterministic per-outcome scoring
lib/stats.js         Jeffreys interval, t / beta quantiles, random-effects meta-analysis
lib/sources.js       literature APIs
lib/media.js         news APIs, outlet weights, media score
lib/llm.js           every prompt + hardened JSON call helper
lib/papers.js        PubMed parsing, design labels, merge-dedupe, funding
lib/text.js          entity matching, grounding checks
lib/security.js      headers, CORS allowlist, admin token, rate limits
public/              the only directory served to browsers
test/                node:test suite + offline fake world + preview server
```

---

## Deploying

Deploy the repo as a single Node service (for example Railway or Render) and set the env vars above. The backend serves the frontend from `public/`, so you don't need a separate frontend host.

---

## Legal & safety notes

- Only abstracts and metadata are used, never copyrighted full text. Every paper links to its DOI or PubMed record.
- OpenAlex data is CC0. PubMed and Europe PMC metadata is used under their API terms.
- The UI shows a not-medical-advice notice. Verdicts describe the evidence and do not prescribe actions.

---

## License

MIT
