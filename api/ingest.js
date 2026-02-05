import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role for writes
);

// RSS feeds with their categories
const RSS_FEEDS = [
  // Technology
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', categories: ['technology'], source: 'Ars Technica' },
  { url: 'https://www.theverge.com/rss/index.xml', categories: ['technology'], source: 'The Verge' },

  // Science
  { url: 'https://www.sciencedaily.com/rss/all.xml', categories: ['science'], source: 'Science Daily' },
  { url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', categories: ['science'], source: 'NASA' },

  // Business
  { url: 'https://feeds.bloomberg.com/markets/news.rss', categories: ['business'], source: 'Bloomberg' },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147', categories: ['business'], source: 'CNBC' },

  // Politics / World
  { url: 'https://feeds.npr.org/1001/rss.xml', categories: ['politics', 'world'], source: 'NPR' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', categories: ['world'], source: 'BBC World' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', categories: ['politics'], source: 'NY Times' },

  // Health
  { url: 'https://www.statnews.com/feed/', categories: ['health'], source: 'STAT News' },

  // Sports
  { url: 'https://www.espn.com/espn/rss/news', categories: ['sports'], source: 'ESPN' },

  // Entertainment
  { url: 'https://variety.com/feed/', categories: ['entertainment'], source: 'Variety' },
];

// Category positions for clustering (center points)
const CATEGORY_CENTERS = {
  technology: { x: -600, y: -400 },
  science: { x: 0, y: -500 },
  business: { x: 600, y: -400 },
  politics: { x: -500, y: 200 },
  world: { x: 0, y: 0 },
  health: { x: 500, y: 200 },
  sports: { x: -400, y: 500 },
  entertainment: { x: 400, y: 500 },
};

export default async function handler(req, res) {
  // Only allow POST with a secret key for security
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const expectedKey = process.env.INGEST_SECRET_KEY;

  if (expectedKey && authHeader !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const results = { success: 0, skipped: 0, errors: 0 };
    const allArticles = [];

    // Fetch all feeds in parallel
    const feedPromises = RSS_FEEDS.map(async (feed) => {
      try {
        const response = await fetch(feed.url, {
          headers: { 'User-Agent': 'NewsGrid/1.0' },
          signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) return [];

        const xml = await response.text();
        const items = parseRSS(xml, feed);
        return items;
      } catch (err) {
        console.error(`Failed to fetch ${feed.source}:`, err.message);
        results.errors++;
        return [];
      }
    });

    const feedResults = await Promise.all(feedPromises);
    feedResults.forEach(items => allArticles.push(...items));

    // Calculate positions for articles
    const articlesWithPositions = calculatePositions(allArticles);

    // Upsert articles into database
    for (const article of articlesWithPositions) {
      try {
        const { error } = await supabase
          .from('articles')
          .upsert(article, {
            onConflict: 'url',
            ignoreDuplicates: true
          });

        if (error) {
          if (error.code === '23505') { // Duplicate
            results.skipped++;
          } else {
            console.error('Insert error:', error);
            results.errors++;
          }
        } else {
          results.success++;
        }
      } catch (err) {
        results.errors++;
      }
    }

    return res.status(200).json({
      message: 'Ingestion complete',
      feeds_processed: RSS_FEEDS.length,
      articles_found: allArticles.length,
      ...results
    });
  } catch (err) {
    console.error('Ingestion error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function parseRSS(xml, feed) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];

    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link') || extractAttr(itemXml, 'link', 'href');
    const pubDate = extractTag(itemXml, 'pubDate') || extractTag(itemXml, 'dc:date');

    // Try to extract image
    let image = null;
    const mediaMatch = itemXml.match(/url=["']([^"']+\.(jpg|jpeg|png|gif|webp)[^"']*)/i);
    if (mediaMatch) image = mediaMatch[1];

    // Try enclosure
    if (!image) {
      const enclosureMatch = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
      if (enclosureMatch) image = enclosureMatch[1];
    }

    if (title && link) {
      items.push({
        url: link,
        title: decodeEntities(title).slice(0, 500),
        source: feed.source,
        categories: feed.categories,
        published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        thumbnail_url: image,
        analyzed: false
      });
    }
  }

  return items;
}

function extractTag(xml, tag) {
  // Handle CDATA
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  // Handle regular content
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function extractAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]+${attr}=["']([^"']+)["']`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/<[^>]+>/g, '');
}

function calculatePositions(articles) {
  // Group articles by primary category
  const categoryGroups = {};

  articles.forEach(article => {
    const primaryCat = article.categories[0] || 'world';
    if (!categoryGroups[primaryCat]) {
      categoryGroups[primaryCat] = [];
    }
    categoryGroups[primaryCat].push(article);
  });

  // Assign positions within each category cluster
  const cardWidth = 340;
  const cardHeight = 240;
  const gap = 20;

  const positionedArticles = [];

  Object.entries(categoryGroups).forEach(([category, catArticles]) => {
    const center = CATEGORY_CENTERS[category] || { x: 0, y: 0 };
    const cols = Math.ceil(Math.sqrt(catArticles.length));

    catArticles.forEach((article, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);

      // Add some randomness to avoid perfect grid
      const jitterX = (Math.random() - 0.5) * 40;
      const jitterY = (Math.random() - 0.5) * 40;

      positionedArticles.push({
        ...article,
        grid_x: center.x + (col - cols/2) * (cardWidth + gap) + jitterX,
        grid_y: center.y + row * (cardHeight + gap) + jitterY
      });
    });
  });

  return positionedArticles;
}
