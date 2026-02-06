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

// Category display order for the grid layout (arranged in rows of 3)
const CATEGORY_ORDER = [
  'technology', 'science', 'business',
  'politics', 'world', 'health',
  'sports', 'entertainment'
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
  // Group articles by primary category
  const categoryGroups = {};

  articles.forEach(article => {
    const primaryCat = article.categories[0] || 'world';
    if (!categoryGroups[primaryCat]) {
      categoryGroups[primaryCat] = [];
    }
    categoryGroups[primaryCat].push(article);
  });

  const cardWidth = 340;
  const cardHeight = 240;
  const gap = 20;
  const categoryGap = 60; // Gap between category blocks
  const maxColsPerCategory = 4;

  // Only include categories that have articles, in display order
  const activeCategories = CATEGORY_ORDER.filter(
    cat => categoryGroups[cat] && categoryGroups[cat].length > 0
  );
  // Include any categories not in the predefined order
  Object.keys(categoryGroups).forEach(cat => {
    if (!activeCategories.includes(cat)) activeCategories.push(cat);
  });

  // Calculate the grid dimensions each category block needs
  const categoryDims = {};
  activeCategories.forEach(cat => {
    const count = categoryGroups[cat].length;
    const cols = Math.min(maxColsPerCategory, Math.ceil(Math.sqrt(count)));
    const rows = Math.ceil(count / cols);
    categoryDims[cat] = {
      cols,
      rows,
      width: cols * (cardWidth + gap) - gap,
      height: rows * (cardHeight + gap) - gap
    };
  });

  // Arrange category blocks in a packed meta-grid (3 categories per row)
  const metaCols = 3;
  const positionedArticles = [];
  let currentY = 0;

  for (let metaRow = 0; metaRow < Math.ceil(activeCategories.length / metaCols); metaRow++) {
    const rowCategories = activeCategories.slice(metaRow * metaCols, (metaRow + 1) * metaCols);

    // This meta-row is exactly as tall as its tallest category block
    const maxHeight = Math.max(...rowCategories.map(cat => categoryDims[cat].height));

    // Find the widest possible column width for uniform spacing
    let currentX = 0;

    rowCategories.forEach(cat => {
      const dim = categoryDims[cat];
      const catArticles = categoryGroups[cat];

      catArticles.forEach((article, i) => {
        const col = i % dim.cols;
        const row = Math.floor(i / dim.cols);

        positionedArticles.push({
          ...article,
          grid_x: currentX + col * (cardWidth + gap),
          grid_y: currentY + row * (cardHeight + gap)
        });
      });

      currentX += dim.width + categoryGap;
    });

    currentY += maxHeight + categoryGap;
  }

  // Center the entire grid around (0, 0)
  if (positionedArticles.length > 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    positionedArticles.forEach(a => {
      minX = Math.min(minX, a.grid_x);
      maxX = Math.max(maxX, a.grid_x + cardWidth);
      minY = Math.min(minY, a.grid_y);
      maxY = Math.max(maxY, a.grid_y + cardHeight);
    });

    const centerOffsetX = (minX + maxX) / 2;
    const centerOffsetY = (minY + maxY) / 2;

    positionedArticles.forEach(a => {
      a.grid_x -= centerOffsetX;
      a.grid_y -= centerOffsetY;
    });
  }

  return positionedArticles;
}
