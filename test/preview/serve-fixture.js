// Offline preview: serves the real frontend, but answers /api/search by
// running the real pipeline against the fake literature/news APIs and
// fake Claude in test/fixtures. No API key or network needed.
//
//   npm run preview   → http://localhost:3002/?q=creatine
const express = require('express');
const { app } = require('../../server');
const { runAnalysis } = require('../../lib/pipeline');
const { makeClient, makeHttp } = require('../fixtures/fake-world');

const preview = express();
preview.use(express.json());
preview.post('/api/search', async (req, res) => {
  const scenario = String(req.body?.query || '');
  try {
    const result = await runAnalysis(scenario, { deepMode: !!req.body?.deepMode }, {
      client: makeClient({ inject: /inject/i.test(scenario) }),
      http: makeHttp({ failS2: /fail/i.test(scenario) }),
    });
    delete result._scoring;
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
preview.use(app);

const port = Number(process.env.PORT || 3002);
preview.listen(port, () => console.log(`Verity offline preview → http://localhost:${port}/?q=creatine`));
