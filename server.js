// ─────────────────────────────────────────────
//  Verity — Backend Server
//  Thin proxy to keep Claude API key off client
// ─────────────────────────────────────────────

const express  = require('express');
const cors     = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Health check ──────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── Main analysis endpoint ────────────────────
// POST /api/analyze
// Body: { query: string, papers: Paper[] }
// Returns: AnalysisResult
app.post('/api/analyze', async (req, res) => {
  const { query, papers } = req.body;

  if (!query || !Array.isArray(papers) || papers.length === 0) {
    return res.status(400).json({ error: 'query and papers[] are required' });
  }

  // Build the papers block for the prompt
  const papersBlock = papers.map((p, i) => [
    `[${i + 1}]`,
    `DOI: ${p.doi || 'N/A'}`,
    `Title: ${p.title}`,
    `Journal: ${p.journal} (${p.year}) · ${p.citations} citations`,
    `Abstract: ${p.abstract}`
  ].join('\n')).join('\n\n─────\n\n');

  const systemPrompt = `You are a rigorous scientific literature analyst. You read peer-reviewed abstracts and produce calibrated, honest summaries. You never overclaim. You acknowledge uncertainty. You do not have a political or dietary agenda. You respond ONLY with valid JSON — no markdown fences, no preamble, nothing else.`;

  const userPrompt = `Analyze these ${papers.length} peer-reviewed papers on the topic: "${query}"

PAPERS:
${papersBlock}

Return ONLY this JSON structure (no backticks, no markdown):
{
  "summary": "<2–3 paragraph HTML string. Use <strong> for key terms. Be specific: cite effect sizes, sample sizes, study types where available. Acknowledge conflicting findings honestly. Do NOT use bullet points.>",
  "debate": {
    "leftLabel": "<3–4 word label for the skeptical/negative/concern side>",
    "leftDesc":  "<7–9 word description of the concern>",
    "rightLabel": "<3–4 word label for the supportive/positive side>",
    "rightDesc":  "<7–9 word description of the benefit>",
    "leftPct":  <integer 0–100>,
    "rightPct": <integer 0–100>,
    "isDebated": <true if genuine scientific debate exists, false if near-unanimous>
  },
  "stances": [
    { "doi": "<doi string or 'paper-N' if no doi>", "stance": "<for|against|mixed>" }
  ]
}

Rules:
- leftPct + rightPct MUST equal exactly 100
- "for"     = paper supports the positive framing of the query
- "against" = paper raises concerns, shows risks, or contradicts
- "mixed"   = paper shows genuinely mixed or conditional findings
- Calibrate carefully: if 6 of 10 papers lean supportive, leftPct ≈ 40, rightPct ≈ 60
- If topic has near-unanimous consensus (≥90%), set isDebated: false and reflect that in the percentages
- The summary must be honest about the quality of evidence, not just the direction`;

  try {
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }]
    });

    const raw = message.content[0].text.trim();

    // Strip any accidental markdown fences just in case
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);

    // Validate leftPct + rightPct = 100
    if (parsed.debate) {
      const total = (parsed.debate.leftPct || 0) + (parsed.debate.rightPct || 0);
      if (total !== 100) {
        // Auto-correct rounding errors
        parsed.debate.rightPct = 100 - parsed.debate.leftPct;
      }
    }

    res.json(parsed);

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🔬 Verity backend running → http://localhost:${PORT}\n`);
});
