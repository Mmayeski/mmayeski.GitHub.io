// API endpoint to fetch and parse RSS feeds
// Returns normalized article data from multiple sources

const RSS_FEEDS = [
  { name: 'Reuters', url: 'https://feeds.reuters.com/reuters/topNews' },
  { name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews' },
  { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
];

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const articles = [];

    // Fetch all feeds in parallel
    const feedPromises = RSS_FEEDS.map(async (feed) => {
      try {
        const response = await fetch(feed.url, {
          headers: { 'User-Agent': 'NewsGrid/1.0' }
        });

        if (!response.ok) return [];

        const xml = await response.text();
        const items = parseRSS(xml, feed.name);
        return items;
      } catch (err) {
        console.error(`Failed to fetch ${feed.name}:`, err.message);
        return [];
      }
    });

    const results = await Promise.all(feedPromises);
    results.forEach(items => articles.push(...items));

    // Sort by date, newest first
    articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    return res.status(200).json({
      status: 'ok',
      articles: articles.slice(0, 60) // Limit to 60 articles
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Simple RSS parser (handles RSS 2.0 format)
function parseRSS(xml, sourceName) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];

    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const pubDate = extractTag(itemXml, 'pubDate');
    const description = extractTag(itemXml, 'description');

    // Try to extract image from media:content or enclosure
    let image = null;
    const mediaMatch = itemXml.match(/url=["']([^"']+\.(jpg|jpeg|png|gif|webp)[^"']*)/i);
    if (mediaMatch) image = mediaMatch[1];

    if (title && link) {
      items.push({
        source: { name: sourceName },
        title: decodeEntities(title),
        url: link,
        urlToImage: image,
        publishedAt: pubDate || new Date().toISOString(),
        description: description ? decodeEntities(description).slice(0, 200) : ''
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

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ''); // Strip remaining HTML tags
}
