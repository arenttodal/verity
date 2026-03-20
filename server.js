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

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'verity.html')));
app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/api/analyze', async (req, res) => {
  const { query, papers } = req.body;
  if (!query || !Array.isArray(papers) || papers.length === 0) {
    return res.status(400).json({ error: 'query and papers[] are required' });
  }

  const papersBlock = papers.map((p, i) => [
    `[${i + 1}]`,
    `DOI: ${p.doi || 'N/A'}`,
    `Title: ${p.title}`,
    `Journal: ${p.journal} (${p.year}) · ${p.citations} citations`,
    `Abstract: ${p.abstract}`
  ].join('\n')).join('\n\n─────\n\n');

  try {
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:     'You are a rigorous scientific literature analyst. Respond ONLY with valid JSON — no markdown fences, no preamble.',
      messages:   [{ role: 'user', content: `Analyze these ${papers.length} peer-reviewed papers on: "${query}"\n\nPAPERS:\n${papersBlock}\n\nReturn ONLY this JSON:\n{\n  "summary": "<2-3 paragraph HTML string using <strong> for key terms>",\n  "debate": {\n    "leftLabel": "<3-4 word skeptical/concern side label>",\n    "leftDesc":  "<7-9 word description>",\n    "rightLabel": "<3-4 word supportive side label>",\n    "rightDesc":  "<7-9 word description>",\n    "leftPct":  <integer 0-100>,\n    "rightPct": <integer 0-100>,\n    "isDebated": <true|false>\n  },\n  "stances": [\n    { "doi": "<doi or paper-N>", "stance": "<for|against|mixed>" }\n  ]\n}\nleftPct + rightPct MUST equal 100.` }]
    });

    const raw     = message.content[0].text.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (parsed.debate) {
      parsed.debate.rightPct = 100 - parsed.debate.leftPct;
    }
    res.json(parsed);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Verity running on port ${PORT}`));
