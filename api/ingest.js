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


export default async function handler(req, res) {
  // Only allow POST with a secret key for security
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ingestKey = req.headers['x-ingest-key'];
  const expectedKey = process.env.INGEST_SECRET_KEY;

  if (expectedKey && ingestKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const results = { inserted: 0, errors: 0 };
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

    // Upsert articles into database (updates existing articles including positions)
    for (const article of articlesWithPositions) {
      try {
        const { data, error } = await supabase
          .from('articles')
          .upsert(article, {
            onConflict: 'url'
          })
          .select('id');

        if (error) {
          console.error('Upsert error:', error);
          results.errors++;
        } else {
          results.inserted++;
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
  const cardWidth = 340;
  const cardHeight = 240;
  const gap = 20;

  // Sort by date (newest first)
  const sorted = [...articles].sort((a, b) => {
    return new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime();
  });

  const count = sorted.length;
  if (count === 0) return [];

  // Uniform rectangular grid
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const centerCol = (cols - 1) / 2;
  const centerRow = (rows - 1) / 2;

  // Generate all grid slots sorted by distance from center
  const slots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = (c - centerCol) * (cardWidth + gap);
      const dy = (r - centerRow) * (cardHeight + gap);
      slots.push({ r, c, dist: Math.sqrt(dx * dx + dy * dy) });
    }
  }
  slots.sort((a, b) => a.dist - b.dist || a.r - b.r || a.c - b.c);

  // Assign newest articles to center slots, oldest to edges
  return sorted.map((article, i) => {
    const slot = slots[i];
    return {
      ...article,
      grid_x: (slot.c - centerCol) * (cardWidth + gap),
      grid_y: (slot.r - centerRow) * (cardHeight + gap)
    };
  });
}
