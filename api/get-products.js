import axios from 'axios';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const FASHION_KEYWORDS = [
    'women dress', 'women top', 'women blouse', 'women t-shirt', 'women shirt',
    'women hoodie', 'women jacket', 'women activewear', 'women swimwear', 'bikini',
    'women lingerie', 'women pajamas', 'women sleepwear', 'women joggers',
    'men shirt', 'men hoodie', 'men jacket', 'men joggers', 'men t-shirt',
    'men activewear', 'men pajamas', 'men sweatshirt',
    'kids clothing', 'kids dress', 'boys shirt', 'girls dress',
    'sneakers', 'trainers', 'boots', 'sandals', 'slippers', 'shoes',
    'backpack', 'handbag', 'tote bag', 'shoulder bag',
    'bedding set', 'bed sheets', 'duvet cover', 'blanket', 'throw blanket', 'curtains'
];

async function productsFetch(keyword, params, token) {
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
    if (minPrice) base.priceFrom = (parseFloat(minPrice) / 2.4).toFixed(2);
    if (maxPrice) base.priceTo   = (parseFloat(maxPrice) / 2.4).toFixed(2);

    try {
        let products = [], total = 0;

        if (!q) {
            const randomKeyword = FASHION_KEYWORDS[Math.floor(Math.random() * FASHION_KEYWORDS.length)];
            const d = await productsFetch(randomKeyword, base, process.env.PRODUCTS_API_KEY);
            products = d.list || []; total = d.total || 0;
            if (products.length === 0) {
                const fallback = await productsFetch(null, base, process.env.PRODUCTS_API_KEY);
                products = fallback.list || []; total = fallback.total || 0;
            }
        } else {
            let d = await productsFetch(q, base, process.env.PRODUCTS_API_KEY);
            products = d.list || []; total = d.total || 0;
            if (products.length === 0) {
                const stop = new Set(['for','the','and','with','a','an','in','on','of','to','my','i','is']);
                const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !stop.has(w));
                for (const w of words.slice(0, 5)) {
                    await sleep(500);
                    d = await productsFetch(w, base, process.env.PRODUCTS_API_KEY);
                    if ((d.list || []).length > 0) { products = d.list; total = d.total || 0; break; }
                }
            }
            if (products.length === 0) {
                const ql = q.toLowerCase();
                const matched = FASHION_KEYWORDS.find(k => k.includes(ql) || ql.includes(k.split(' ')[0]));
                if (matched) {
                    d = await productsFetch(matched, base, process.env.PRODUCTS_API_KEY);
                    products = d.list || []; total = d.total || 0;
                }
            }
            if (products.length === 0) {
                const fallback = await productsFetch(null, base, process.env.PRODUCTS_API_KEY);
                products = fallback.list || []; total = fallback.total || 0;
            }
        }

        let result = products.map(p => ({
            ...p,
            sellPrice: (parseFloat(p.sellPrice || 0) * 2.4).toFixed(2),
            originalPrice: p.sellPrice
        }));

        if (minPrice) result = result.filter(p => parseFloat(p.sellPrice) >= parseFloat(minPrice));
        if (maxPrice) result = result.filter(p => parseFloat(p.sellPrice) <= parseFloat(maxPrice));

        return res.status(200).json({ products: result, total, page: parseInt(page), pageSize: parseInt(pageSize) });
    } catch (e) {
        console.error('Products fetch error:', e.response?.data || e.message);
        return res.status(500).json({ error: 'Failed to fetch', products: [] });
    }
}
