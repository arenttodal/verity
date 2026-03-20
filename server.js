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
//  UTILS
// ─────────────────────────────────────────────
function reconstructAbstract(idx) {
  if (!idx || typeof idx !== 'object') return '';
  const pos = [];
  for (const [word, locs] of Object.entries(idx)) {
    for (const l of locs) pos[l] = word;
  }
  return pos.filter(Boolean).join(' ').trim();
}

function stripHtml(str) {
  return String(str || '').replace(/<[^>]*>/g, '').trim();
}

// ─────────────────────────────────────────────
//  STEP 1 — Claude understands & optimizes query
// ─────────────────────────────────────────────
async function optimizeQuery(rawQuery) {
  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 600,
    system:     'You are a biomedical librarian and scientific search expert with deep knowledge of PubMed MeSH terms and academic search syntax. Respond ONLY with valid JSON, no markdown.',
    messages:   [{
      role: 'user',
      content: `A user typed this into a science search engine: "${rawQuery}"

Your job is to translate this into a precise academic search string that will return HIGHLY RELEVANT peer-reviewed papers — not tangentially related ones.

Rules for searchString:
- Use specific medical/scientific terminology (MeSH-style preferred)
- Include the EXACT phenomenon being studied (e.g. "nausea vomiting pregnancy" not just "pregnancy nausea")
- Add key synonyms joined with OR where helpful (e.g. "morning sickness OR nausea gravidarum")
- AVOID overly broad terms that will pull irrelevant results
- AVOID terms that are only tangentially related
- Max 15 words
- Think: what would a medical researcher type into PubMed to find papers on exactly this topic?

Return ONLY this JSON:
{
  "searchString": "<precise academic search string>",
  "isDebatable": <true if science has genuine two sides, false if near-unanimous consensus>,
  "leftSide":  "<3-5 words: the skeptical/concern/risk side of this topic>",
  "rightSide": "<3-5 words: the beneficial/positive/supportive side>",
  "plain":     "<the user's intent rewritten as a clean specific question, e.g. 'What is the typical onset and duration of nausea during pregnancy?'>",
  "concepts":  ["<key concept 1>", "<key concept 2>", "<key concept 3>"]
}

Examples of good vs bad searchStrings:
- BAD: "pregnancy nausea" (too broad, pulls cannabis papers)
- GOOD: "nausea vomiting pregnancy NVP morning sickness trimester onset prevalence"
- BAD: "night shifts health" (too vague)
- GOOD: "shift work disorder circadian rhythm disruption health outcomes workers"
- BAD: "red meat cancer" (ambiguous)
- GOOD: "red meat processed meat colorectal cancer risk epidemiology cohort"

For isDebatable:
- true: veganism health, red meat cancer, coffee mortality, statins side effects
- false: smoking cancer, vaccines autism, exercise health benefits, morning sickness prevalence`
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
    'per-page': '20',
    select:     'id,title,abstract_inverted_index,publication_year,primary_location,cited_by_count,doi',
    mailto:     'hello@verity.science'
  });

  const res  = await fetch(`https://api.openalex.org/works?${params}`);
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = await res.json();

  return (data.results || []).map(w => ({
    title:     stripHtml(w.title || 'Untitled'),
    abstract:  reconstructAbstract(w.abstract_inverted_index),
    year:      w.publication_year || '—',
    journal:   stripHtml(w.primary_location?.source?.display_name || 'Unknown Journal'),
    citations: w.cited_by_count || 0,
    doi:       w.doi ? w.doi.replace('https://doi.org/', '') : null
  })).filter(p => p.abstract.length > 80);
}

// ─────────────────────────────────────────────
//  STEP 3 — Quick relevance filter
//  Drop papers that are clearly off-topic before
//  spending tokens on full analysis
// ─────────────────────────────────────────────
async function filterRelevantPapers(plain, concepts, papers) {
  if (papers.length === 0) return papers;

  const titlesBlock = papers.map((p, i) =>
    `[${i}] ${p.title}`
  ).join('\n');

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 300,
    system:     'You are a relevance filter. Respond ONLY with valid JSON, no markdown.',
    messages:   [{
      role: 'user',
      content: `Topic: "${plain}"
Key concepts: ${concepts.join(', ')}

These papers were returned by a search engine. Some may be off-topic.
Return ONLY the indices of papers that are DIRECTLY relevant to the topic (not tangentially related).
Be generous — keep papers if they study a related mechanism or population. Remove only clearly wrong ones.

Papers:
${titlesBlock}

Return ONLY: { "keep": [0, 1, 3, ...] }  (array of indices to keep)`
    }]
  });

  const raw     = msg.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const { keep } = JSON.parse(cleaned);

  return keep.map(i => papers[i]).filter(Boolean);
}

// ─────────────────────────────────────────────
//  STEP 4 — Claude analyses the papers
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
- Is this genuinely debated in science? ${queryMeta.isDebatable}

PAPERS:
${papersBlock}

Return ONLY this JSON:
{
  "summary": "<2-3 paragraph HTML. Use <strong> for key terms. Be specific: cite effect sizes, sample sizes, study types. Honest about uncertainty and evidence quality. No bullet points.>",
  "debate": {
    "leftLabel":  "${queryMeta.leftSide}",
    "leftDesc":   "<8 word description of concern side>",
    "rightLabel": "${queryMeta.rightSide}",
    "rightDesc":  "<8 word description of supportive side>",
    "leftPct":    <integer 0-100>,
    "rightPct":   <integer 0-100>,
    "isDebated":  ${queryMeta.isDebatable}
  },
  "stances": [
    { "doi": "<doi or paper-N>", "stance": "<for|against|mixed>" }
  ]
}
leftPct + rightPct MUST equal 100. Calibrate based on actual paper content, not assumptions.`
    }]
  });

  const raw     = msg.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed  = JSON.parse(cleaned);
  if (parsed.debate) parsed.debate.rightPct = 100 - parsed.debate.leftPct;
  return parsed;
}

// ─────────────────────────────────────────────
//  ANALYZE ENDPOINT (used by frontend)
// ─────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { query, papers } = req.body;
  if (!query)  return res.status(400).json({ error: 'query is required' });
  if (!papers || !papers.length) return res.status(400).json({ error: 'papers are required' });

  try {
    const queryMeta = await optimizeQuery(query);
    console.log(`Analyze: "${query}" → "${queryMeta.searchString}"`);

    const filtered = await filterRelevantPapers(queryMeta.plain, queryMeta.concepts || [], papers);
    if (filtered.length < 3) {
      return res.status(404).json({ error: `Only ${filtered.length} relevant paper(s) found. Try a broader search term.` });
    }

    const analysis = await analyzePapers(queryMeta.plain, filtered, queryMeta);
    res.json(analysis);
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  SEARCH ENDPOINT (all-in-one)
// ─────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  try {
    // 1. Understand query
    const queryMeta = await optimizeQuery(query);
    console.log(`Query: "${query}" → "${queryMeta.searchString}"`);

    // 2. Fetch papers
    const rawPapers = await fetchPapers(queryMeta.searchString);
    if (rawPapers.length === 0) {
      return res.status(404).json({ error: 'No papers found. Try a different search term.' });
    }

    // 3. Filter for relevance
    const papers = await filterRelevantPapers(queryMeta.plain, queryMeta.concepts || [], rawPapers);
    if (papers.length < 3) {
      return res.status(404).json({ error: `Only ${papers.length} relevant paper(s) found on this topic. Try a broader search term.` });
    }

    // 4. Analyse
    const analysis = await analyzePapers(queryMeta.plain, papers, queryMeta);

    res.json({ queryMeta, papers, analysis });

  } catch (err) {
    console.error('Pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Verity running on port ${PORT}`));
