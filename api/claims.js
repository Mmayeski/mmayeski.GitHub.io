import { kv } from '@vercel/kv';

// GET /api/claims?url=... - Fetch claims for an article
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    // Look up claims by article URL
    const claims = await kv.get(`claims:${url}`);

    if (!claims) {
      return res.status(404).json({ error: 'No analysis found for this article' });
    }

    return res.status(200).json(claims);
  } catch (err) {
    console.error('KV error:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}
