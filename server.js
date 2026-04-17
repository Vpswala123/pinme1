const express = require('express');
const { Pool } = require('pg');
const ogs = require('open-graph-scraper');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Database Connection
if (!process.env.DATABASE_URL) {
    console.warn("⚠️  WARNING: DATABASE_URL environment variable is missing! The server will crash on database operations.");
    console.warn("Please add your Supabase or Postgres Connection String in your Render Dashboard.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false
});

// Initialize Table
pool.query(`
    CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        page VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        brand TEXT,
        category VARCHAR(255),
        image_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    -- Ensure category column exists since it was missing in the manual Supabase schema
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(255);
`).then(() => console.log('Connected to PostgreSQL database.')).catch(console.error);

// ── Fallback regex for Myntra if Scraping is blocked ──
function getMyntraImage(url) {
    const match = url.match(/\/(\d{7,})\//);
    if (match) return `https://assets.myntassets.com/h_720,q_90,w_540/v1/assets/images/${match[1]}/`;
    return '';
}
function parseMyntraUrl(url) {
    try {
      const parts = url.split('/').filter(Boolean);
      if (parts.length >= 5) {
        const brand = decodeURIComponent(parts[parts.length - 4]).replace(/-/g, ' ');
        const nameRaw = decodeURIComponent(parts[parts.length - 3]).replace(/-/g, ' ');
        return { brand, name: nameRaw };
      }
    } catch(e) {}
    return { brand: '', name: url };
}

// GET /api/products
app.get('/api/products', async (req, res) => {
    const page = req.query.page || 'default';
    try {
        const result = await pool.query('SELECT * FROM products WHERE page = $1 ORDER BY created_at DESC', [page]);
        const mapped = result.rows.map(row => ({
            id: row.id,
            page: row.page,
            url: row.url,
            name: row.title,
            brand: row.brand,
            category: row.category,
            image: row.image_url,
            addedAt: row.created_at
        }));
        res.json(mapped);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/pages
app.get('/api/pages', async (req, res) => {
    try {
        const result = await pool.query('SELECT DISTINCT page FROM products');
        res.json(result.rows.map(r => r.page));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/products
app.post('/api/products', async (req, res) => {
    let { page, url, category } = req.body;
    if (!page || !url) return res.status(400).json({ error: 'Page and valid URL are required' });

    let image = '';
    let title = '';
    let brand = '';

    // First attempt Universal Scraping
    try {
        const { result } = await ogs({ url: url.trim(), timeout: 5000 });
        if (result.ogImage && result.ogImage.length) image = result.ogImage[0].url;
        if (result.ogTitle) title = result.ogTitle;
        if (result.ogSiteName) brand = result.ogSiteName;
    } catch (e) {
        console.log("Note: Scraper blocked. Attempting Myntra Fallback...");
    }

    // Myntra explicit fallback if scraper limits
    if (!image && url.includes('myntra.com')) {
        image = getMyntraImage(url);
        const parsed = parseMyntraUrl(url);
        if (!title) title = parsed.name;
        if (!brand) brand = parsed.brand;
    }

    title = title || url;

    try {
        const query = `INSERT INTO products (page, url, title, brand, category, image_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
        const params = [page, url.trim(), title, brand, category, image];
        const result = await pool.query(query, params);
        const row = result.rows[0];
        
        res.json({ message: 'success', data: {
            id: row.id, page: row.page, url: row.url,
            name: row.title, brand: row.brand, category: row.category, image: row.image_url
        }});
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// DELETE /api/products/:id
app.delete('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
        res.json({ message: 'deleted' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
