import { createClient } from '@supabase/supabase-js';

const supabaseRead = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseWrite = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ingest-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return handleGet(req, res);
  }

  if (req.method === 'POST') {
    return handlePost(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req, res) {
  const { article_id } = req.query;

  if (!article_id) {
    return res.status(400).json({ error: 'Missing article_id parameter' });
  }

  try {
    const { data, error } = await supabaseRead
      .from('claims')
      .select('*')
      .eq('article_id', article_id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    return res.status(200).json({ claims: data || [] });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handlePost(req, res) {
  // Require ingest key for writes
  const ingestKey = req.headers['x-ingest-key'];
  const expectedKey = process.env.INGEST_SECRET_KEY;

  if (expectedKey && ingestKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { article_url, claims } = req.body;

  if (!article_url) {
    return res.status(400).json({ error: 'Missing article_url' });
  }

  if (!claims || !Array.isArray(claims) || claims.length === 0) {
    return res.status(400).json({ error: 'Missing or empty claims array' });
  }

  try {
    // Look up article by URL
    const { data: articles, error: lookupError } = await supabaseWrite
      .from('articles')
      .select('id')
      .eq('url', article_url)
      .limit(1);

    if (lookupError) {
      console.error('Article lookup error:', lookupError);
      return res.status(500).json({ error: 'Database error looking up article' });
    }

    if (!articles || articles.length === 0) {
      return res.status(404).json({ error: 'Article not found. Make sure the URL matches exactly.' });
    }

    const articleId = articles[0].id;

    // Delete any existing claims for this article (replace mode)
    await supabaseWrite
      .from('claims')
      .delete()
      .eq('article_id', articleId);

    // Insert new claims
    const claimRows = claims.map(c => ({
      article_id: articleId,
      claim_text: c.text,
      score: Math.min(10, Math.max(1, Math.round(c.score))),
      reasoning: c.reasoning || null
    }));

    const { error: insertError } = await supabaseWrite
      .from('claims')
      .insert(claimRows);

    if (insertError) {
      console.error('Claims insert error:', insertError);
      return res.status(500).json({ error: 'Failed to insert claims' });
    }

    // Calculate and update average score on the article
    const avgScore = claimRows.reduce((sum, c) => sum + c.score, 0) / claimRows.length;

    const { error: updateError } = await supabaseWrite
      .from('articles')
      .update({
        avg_score: Math.round(avgScore * 10) / 10,
        analyzed: true,
        analyzed_at: new Date().toISOString()
      })
      .eq('id', articleId);

    if (updateError) {
      console.error('Article update error:', updateError);
      // Claims were inserted, just warn about the score update
    }

    return res.status(200).json({
      message: 'Claims submitted successfully',
      article_id: articleId,
      claims_count: claimRows.length,
      avg_score: Math.round(avgScore * 10) / 10
    });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
