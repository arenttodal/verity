const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/',       (_, res) => res.sendFile(path.join(__dirname, 'verity.html')));
app.get('/health', (_, res) => res.json({ ok: true }));

// ─────────────────────────────────────────────
//  STEP 1 — Claude understands the query
// ─────────────────────────────────────────────
async function optimizeQuery(rawQuery) {
  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 500,
    system:     'You are a scientific search expert. Respond ONLY with valid JSON, no markdown.',
    messages:   [{
      role: 'user',
      content: `A user typed this into a science search engine: "${rawQuery}"

Return ONLY this JSON:
{
  "searchString": "<optimized PubMed/OpenAlex search string using medical/scientific terminology, boolean operators if helpful, max 12 words>",
  "isDebatable": <true if science genuinely has two sides on this, false if near-unanimous>,
  "leftSide":  "<3-4 words: the skeptical/concern/negative position>",
  "rightSide": "<3-4 words: the supportive/positive/beneficial position>",
  "plain":     "<the user's query rewritten as a clean question, e.g. 'Does night shift work harm long-term health?'>"
}

Rules:
- searchString should use scientific synonyms (e.g. "night shift" → "shift work circadian rhythm")
- If not debatable (e.g. "does smoking cause cancer"), set isDebatable: false and leftSide: "Overwhelming Evidence", rightSide: "Scientific Consensus"
- plain should be a clean readable question for display`
    }]
  });

  const raw     = msg.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────
//  STEP 2 — Fetch papers from OpenAlex
// ─────────────────────────────────────────────
async function fetchPapers(searchString) {
  const yearFrom = new Date().getFullYear() - 5;
  const params   = new URLSearchParams({
    search:     searchString,
    filter:     `publication_year:${yearFrom}-${new Date().getFullYear()},has_abstract:true`,
    sort:       'relevance_score:desc',
    'per-page': '15',
    select:     'id,title,abstract_inverted_index,publication_year,primary_location,cited_by_count,doi',
    mailto:     'hello@verity.science'
  });

  const res  = await fetch(`https://api.openalex.org/works?${params}`);
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = await res.json();

  return (data.results || []).map(w => ({
    title:     w.title || 'Untitled',
    abstract:  reconstructAbstract(w.abstract_inverted_index),
    year:      w.publication_year || '—',
    journal:   w.primary_location?.source?.display_name || 'Unknown Journal',
    citations: w.cited_by_count || 0,
    doi:       w.doi ? w.doi.replace('https://doi.org/', '') : null
  })).filter(p => p.abstract.length > 80);
}

function reconstructAbstract(idx) {
  if (!idx || typeof idx !== 'object') return '';
  const pos = [];
  for (const [word, locs] of Object.entries(idx)) {
    for (const l of locs) pos[l] = word;
  }
  return pos.filter(Boolean).join(' ').trim();
}

// ─────────────────────────────────────────────
//  STEP 3 — Claude analyses the papers
// ─────────────────────────────────────────────
async function analyzePapers(plain, papers, queryMeta) {
  const papersBlock = papers.map((p, i) => [
    `[${i + 1}]`,
    `DOI: ${p.doi || 'N/A'}`,
    `Title: ${p.title}`,
    `Journal: ${p.journal} (${p.year}) · ${p.citations} citations`,
    `Abstract: ${p.abstract}`
  ].join('\n')).join('\n\n─────\n\n');

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system:     'You are a rigorous scientific literature analyst. Respond ONLY with valid JSON, no markdown.',
    messages:   [{
      role: 'user',
      content: `Analyze these ${papers.length} peer-reviewed papers on: "${plain}"

The two sides of this debate are:
- Concern/skeptical side: "${queryMeta.leftSide}"
- Supportive/positive side: "${queryMeta.rightSide}"

PAPERS:
${papersBlock}

Return ONLY this JSON:
{
  "summary": "<2-3 paragraph HTML. Use <strong> for key terms. Cite effect sizes and sample sizes. Honest about uncertainty. No bullet points.>",
  "debate": {
    "leftLabel":  "${queryMeta.leftSide}",
    "leftDesc":   "<8 word description of the concern side>",
    "rightLabel": "${queryMeta.rightSide}",
    "rightDesc":  "<8 word description of the benefit side>",
    "leftPct":    <integer 0-100>,
    "rightPct":   <integer 0-100>,
    "isDebated":  ${queryMeta.isDebatable}
  },
  "stances": [
    { "doi": "<doi or paper-N>", "stance": "<for|against|mixed>" }
  ]
}
leftPct + rightPct MUST equal 100. Calibrate carefully based on what the papers actually show.`
    }]
  });

  const raw     = msg.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed  = JSON.parse(cleaned);
  if (parsed.debate) parsed.debate.rightPct = 100 - parsed.debate.leftPct;
  return parsed;
}

// ─────────────────────────────────────────────
//  MAIN ENDPOINT — full pipeline
// ─────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  try {
    // Step 1: understand the query
    const queryMeta = await optimizeQuery(query);

    // Step 2: fetch papers using smart search string
    const papers = await fetchPapers(queryMeta.searchString);
    if (papers.length === 0) {
      return res.status(404).json({ error: 'No papers found. Try a different search term.' });
    }

    // Step 3: analyse
    const analysis = await analyzePapers(queryMeta.plain, papers, queryMeta);

    res.json({ queryMeta, papers, analysis });

  } catch (err) {
    console.error('Pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Verity running on port ${PORT}`));
