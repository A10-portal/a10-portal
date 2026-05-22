import axios from 'axios';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Categories that reliably have color + size variants on CJ
const FASHION_KEYWORDS = [
    // Women's
    'women dress', 'women top', 'women blouse', 'women t-shirt', 'women shirt',
    'women hoodie', 'women jacket', 'women activewear', 'women swimwear', 'bikini',
    'women lingerie', 'women pajamas', 'women sleepwear', 'women joggers',
    // Men's
    'men shirt', 'men hoodie', 'men jacket', 'men joggers', 'men t-shirt',
    'men activewear', 'men pajamas', 'men sweatshirt',
    // Kids
    'kids clothing', 'kids dress', 'boys shirt', 'girls dress',
    // Footwear
    'sneakers', 'trainers', 'boots', 'sandals', 'slippers', 'shoes',
    // Bags
    'backpack', 'handbag', 'tote bag', 'shoulder bag',
    // Home textiles
    'bedding set', 'bed sheets', 'duvet cover', 'blanket', 'throw blanket', 'curtains'
];

async function cjFetch(keyword, params, token) {
    for (let i = 0; i < 3; i++) {
        try {
            const p = { ...params };
            if (keyword) p.productNameEn = keyword;
            const r = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
                headers: { 'CJ-Access-Token': token }, params: p
            });
            return r.data?.data || {};
        } catch (e) {
            if ((e.response?.data?.message || '').includes('Too Many Requests') && i < 2) {
                await sleep(1400); continue;
            }
            throw e;
        }
    }
    return {};
}

export default async function handler(req, res) {
    const { page = 1, pageSize = 20, keyword = '', search = '', minPrice = '', maxPrice = '', countryCode = '' } = req.query;
    const q = (keyword || search || '').trim();

    const base = {
        pageNum: parseInt(page),
        pageSize: parseInt(pageSize),
        countryCode: countryCode || 'US'
    };
    // Divide by markup (2.4x) so filters match displayed prices
    if (minPrice) base.priceFrom = (parseFloat(minPrice) / 2.4).toFixed(2);
    if (maxPrice) base.priceTo   = (parseFloat(maxPrice) / 2.4).toFixed(2);

    try {
        let products = [], total = 0;

        if (!q) {
            // No search — rotate through fashion keywords to show products with color+size
            const randomKeyword = FASHION_KEYWORDS[Math.floor(Math.random() * FASHION_KEYWORDS.length)];
            const d = await cjFetch(randomKeyword, base, process.env.CJ_ACCESS_TOKEN);
            products = d.list || []; total = d.total || 0;

            // If no results fall back to general catalog
            if (products.length === 0) {
                const fallback = await cjFetch(null, base, process.env.CJ_ACCESS_TOKEN);
                products = fallback.list || []; total = fallback.total || 0;
            }
        } else {
            // Step 1: exact query
            let d = await cjFetch(q, base, process.env.CJ_ACCESS_TOKEN);
            products = d.list || []; total = d.total || 0;

            // Step 2: try individual words
            if (products.length === 0) {
                const stop = new Set(['for','the','and','with','a','an','in','on','of','to','my','i','is']);
                const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !stop.has(w));
                for (const w of words.slice(0, 5)) {
                    await sleep(500);
                    d = await cjFetch(w, base, process.env.CJ_ACCESS_TOKEN);
                    if ((d.list || []).length > 0) {
                        products = d.list; total = d.total || 0; break;
                    }
                }
            }

            // Step 3: try matching against fashion keywords
            if (products.length === 0) {
                const ql = q.toLowerCase();
                const matched = FASHION_KEYWORDS.find(k => k.includes(ql) || ql.includes(k.split(' ')[0]));
                if (matched) {
                    d = await cjFetch(matched, base, process.env.CJ_ACCESS_TOKEN);
                    products = d.list || []; total = d.total || 0;
                }
            }

            // Step 4: general fallback
            if (products.length === 0) {
                const fallback = await cjFetch(null, base, process.env.CJ_ACCESS_TOKEN);
                products = fallback.list || []; total = fallback.total || 0;
            }
        }

        // Apply 1.8× markup
        const result = products.map(p => ({
            ...p,
            sellPrice: (parseFloat(p.sellPrice || 0) * 2.4).toFixed(2),
            originalPrice: p.sellPrice
        }));

        return res.status(200).json({ products: result, total, page: parseInt(page), pageSize: parseInt(pageSize) });
    } catch (e) {
        console.error('get-products error:', e.response?.data || e.message);
        return res.status(500).json({ error: 'Failed to fetch', products: [] });
    }
}
