import axios from 'axios';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Server-side cache to avoid hitting rate limit
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > CACHE_TTL) { cache.delete(key); return null; }
    return entry.data;
}

function setCache(key, data) {
    cache.set(key, { data, time: Date.now() });
}

const FASHION_KEYWORDS = [
    'women dress', 'women top', 'women blouse', 'women shirt',
    'women hoodie', 'women jacket', 'women activewear', 'women swimwear',
    'men shirt', 'men hoodie', 'men jacket', 'men t-shirt',
    'kids clothing', 'kids dress', 'boys shirt', 'girls dress',
    'sneakers', 'boots', 'sandals', 'shoes',
    'backpack', 'handbag', 'tote bag',
    'bedding set', 'bed sheets', 'blanket', 'curtains',
    'jewelry', 'watch', 'sunglasses', 'electronics', 'phone case'
];

// Global request queue to enforce 1 req/sec
let lastRequestTime = 0;
async function rateLimitedRequest(fn) {
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastRequestTime));
    if (wait > 0) await sleep(wait);
    lastRequestTime = Date.now();
    return fn();
}

async function productsFetch(keyword, params, token) {
    const cacheKey = JSON.stringify({ keyword, params });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    for (let i = 0; i < 4; i++) {
        try {
            const p = { ...params };
            if (keyword) p.productNameEn = keyword;

            const data = await rateLimitedRequest(() =>
                axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
                    headers: { 'CJ-Access-Token': token },
                    params: p,
                    timeout: 15000
                }).then(r => r.data?.data || {})
            );

            setCache(cacheKey, data);
            return data;
        } catch (e) {
            const msg = e.response?.data?.message || e.message || '';
            if (msg.includes('Too Many Requests')) {
                await sleep(2000 * (i + 1));
                continue;
            }
            if (i < 3) { await sleep(1200); continue; }
            console.error('Products fetch error:', e.response?.data || e.message);
            return {};
        }
    }
    return {};
}

export default async function handler(req, res) {
    // Set cache headers so browser caches results too
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

    const {
        page = 1,
        pageSize = 20,
        keyword = '',
        search = '',
        minPrice = '',
        maxPrice = '',
        countryCode = ''
    } = req.query;

    const q = (keyword || search || '').trim();

    const base = {
        pageNum: parseInt(page),
        pageSize: parseInt(pageSize),
        countryCode: countryCode || 'US'
    };

    if (minPrice) base.priceFrom = (parseFloat(minPrice) / 2.4).toFixed(2);
    if (maxPrice) base.priceTo = (parseFloat(maxPrice) / 2.4).toFixed(2);

    try {
        let products = [], total = 0;

        if (!q) {
            // Rotate keywords deterministically by minute so results vary but reliably return data
            const keyIdx = Math.floor(Date.now() / 60000) % FASHION_KEYWORDS.length;
            const chosenKeyword = FASHION_KEYWORDS[keyIdx];
            // Always use page 1-3 for no-keyword browse to avoid empty high-page results
            const safePage = Math.min(parseInt(page) || 1, 3);
            const safeBase = { ...base, pageNum: safePage };
            const d = await productsFetch(chosenKeyword, safeBase, process.env.PRODUCTS_API_KEY);
            products = d.list || []; total = d.total || 0;
            // Fallback chain through reliable keywords
            if (products.length === 0) {
                for (const fallbackKw of ['women dress', 'sneakers', 'phone case', 'jewelry']) {
                    const fb = await productsFetch(fallbackKw, { ...safeBase, pageNum: 1 }, process.env.PRODUCTS_API_KEY);
                    if ((fb.list || []).length > 0) { products = fb.list; total = fb.total || 0; break; }
                }
            }
        } else {
            let d = await productsFetch(q, base, process.env.PRODUCTS_API_KEY);
            products = d.list || []; total = d.total || 0;

            if (products.length === 0) {
                const stop = new Set(['for','the','and','with','a','an','in','on','of','to','my','i','is']);
                const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !stop.has(w));
                for (const w of words.slice(0, 3)) {
                    d = await productsFetch(w, base, process.env.PRODUCTS_API_KEY);
                    if ((d.list || []).length > 0) { products = d.list; total = d.total || 0; break; }
                }
            }

            if (products.length === 0) {
                const fallback = await productsFetch('women dress', base, process.env.PRODUCTS_API_KEY);
                products = fallback.list || []; total = fallback.total || 0;
            }
        }

        // Apply 2.4x markup
        let result = products.map(p => ({
            ...p,
            sellPrice: (parseFloat(p.sellPrice || 0) * 2.4).toFixed(2),
            originalPrice: p.sellPrice
        }));

        // Filter by displayed price AFTER markup
        if (minPrice) result = result.filter(p => parseFloat(p.sellPrice) >= parseFloat(minPrice));
        if (maxPrice) result = result.filter(p => parseFloat(p.sellPrice) <= parseFloat(maxPrice));

        return res.status(200).json({ products: result, total, page: parseInt(page), pageSize: parseInt(pageSize) });
    } catch (e) {
        console.error('Products handler error:', e.message);
        return res.status(500).json({ error: 'Failed to fetch products', products: [] });
    }
}
