import { kv } from '@vercel/kv';

// POST /api/claims/submit - Store claims for an article
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = req.body;

    // Validate required fields
    if (!data.article_url) {
      return res.status(400).json({ error: 'Missing article_url' });
    }

    if (!data.claims || !Array.isArray(data.claims)) {
      return res.status(400).json({ error: 'Missing or invalid claims array' });
    }

    // Calculate average score if not provided
    if (data.avg_score === undefined) {
      const scores = data.claims
        .map(c => c.score)
        .filter(s => typeof s === 'number');
      data.avg_score = scores.length > 0
        ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1))
        : null;
    }

    // Add timestamp
    data.analyzed_at = data.analyzed_at || new Date().toISOString();

    // Store in KV with article URL as key
    await kv.set(`claims:${data.article_url}`, data);

    // Also maintain an index of all analyzed articles
    await kv.sadd('analyzed_articles', data.article_url);

    return res.status(200).json({
      success: true,
      article_url: data.article_url,
      claims_count: data.claims.length,
      avg_score: data.avg_score
    });
  } catch (err) {
    console.error('KV error:', err);
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
}
