# Verity — Science Consensus Engine

Search the entire body of published peer-reviewed science. Get a calibrated AI synthesis and a visual consensus meter showing where the evidence currently stands.

---

## Stack

| Layer    | Tech                          | Cost    |
|----------|-------------------------------|---------|
| Frontend | Vanilla HTML/CSS/JS           | Free    |
| Papers   | OpenAlex API                  | Free    |
| AI       | Claude (claude-sonnet-4)      | ~$0.003/query |
| Backend  | Node.js + Express             | Free (self-hosted) |

---

## Setup (5 minutes)

### 1. Clone & install

```bash
git clone <your-repo>
cd verity
npm install
```

### 2. Add your API key

```bash
cp .env.example .env
```

Open `.env` and add your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Get a key at: https://console.anthropic.com

### 3. Start the backend

```bash
npm run dev        # development (auto-restarts)
# or
npm start          # production
```

Server starts at `http://localhost:3001`

### 4. Open the frontend

Just open `verity.html` directly in your browser. No build step needed.

> **Note:** If you deploy the frontend to a different origin, update `BACKEND_URL` at the top of the `<script>` block in `verity.html`.

---

## How it works

```
User types query
      ↓
Frontend calls OpenAlex API (direct, no key needed)
  → Returns top 15 papers by citation count (last 5 years)
  → Reconstructs abstracts from OpenAlex inverted index format
      ↓
Frontend POSTs papers to /api/analyze (your backend)
  → Backend sends abstracts + query to Claude
  → Claude classifies each paper's stance (for/against/mixed)
  → Claude returns: summary, consensus percentages, labels
      ↓
Frontend renders results + animates consensus meter
```

---

## Deploying to production

### Backend → Railway or Render

```bash
# Railway
railway init
railway up

# Render: connect your GitHub repo, set ANTHROPIC_API_KEY in env vars
```

### Frontend → Vercel or Netlify

Update `BACKEND_URL` in `verity.html` to point to your deployed backend URL, then drag-and-drop the file to Vercel or Netlify.

---

## Legal & Safety notes

- Verity only uses **abstracts** from OpenAlex — never full-text copyrighted content
- All papers link back to their original DOI sources
- The UI includes a clear "not medical advice" disclaimer
- OpenAlex data is CC0 licensed — safe for commercial use
- Claude summaries are framed as interpretations, not facts

---

## Roadmap

- [ ] Multi-database support (Semantic Scholar, PubMed via NCBI)  
- [ ] Filter by study type (RCT, meta-analysis, cohort, etc.)  
- [ ] Evidence quality scoring (impact factor, pre-registration)
- [ ] Save / share search results  
- [ ] Topic disambiguation (e.g. "cholesterol" → dietary vs LDL vs medication)
- [ ] Rate limiting & caching for production

---

## License

MIT
