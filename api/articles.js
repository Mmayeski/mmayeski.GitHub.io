import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

  try {
    const { category } = req.query;

    let query = supabase
      .from('articles')
      .select(`
        id,
        url,
        title,
        source,
        categories,
        published_at,
        thumbnail_url,
        grid_x,
        grid_y,
        analyzed,
        avg_score
      `)
      .order('published_at', { ascending: false })
      .limit(100);

    // Filter by category if specified (and not 'general')
    if (category && category !== 'general') {
      query = query.contains('categories', [category]);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    return res.status(200).json({
      status: 'ok',
      articles: data || []
    });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
