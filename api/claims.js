// API endpoint to fetch claims for an article
// Later: Connect to Vercel KV to retrieve stored claims

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // TODO: Replace with Vercel KV lookup
  // const claims = await kv.get(`claims:${url}`);

  // For now, return placeholder data
  const mockClaims = {
    article_url: url,
    analyzed_at: new Date().toISOString(),
    claims: [
      {
        text: "This is a placeholder claim. Connect Vercel KV to see real data.",
        score: 7,
        reasoning: "Placeholder reasoning"
      }
    ],
    avg_score: 7
  };

  return res.status(200).json(mockClaims);
}
