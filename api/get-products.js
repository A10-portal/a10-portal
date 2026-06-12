import axios from 'axios';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const KEYWORDS = [
    'women dress', 'sneakers', 'phone case', 'jewelry accessories',
    'men shirt', 'home kitchen', 'beauty makeup', 'kids clothing',
    'handbag', 'sports fitness', 'watch', 'sunglasses',
    'bedding set', 'pet supplies', 'bluetooth earphones', 'car accessories',
    'women hoodie', 'men jacket', 'sandals', 'backpack',
    'women activewear', 'men t-shirt', 'tote bag', 'curtains',
    'women blouse', 'boots', 'electronics', 'blanket',
    'women swimwear', 'boys shirt', 'girls dress', 'bed sheets'
];

async function fetchFromCJ(keyword, params, token) {
    const p = { ...params };
    if (keyword) p.productNameEn = keyword;

    for (let i = 0; i < 3; i++) {
        try {
            const r = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
                headers: { 'CJ-Access-Token': token },
                params: p,
                timeout: 12000
            });
            return r.data?.data || {};
        } catch (e) {
            const msg = e.response?.data?.message || e.message || '';
            if (msg.includes('Too Many Requests')) {
                await sleep(2500 * (i + 1));
                continue;
            }
            if (i < 2) { await sleep(1000); continue; }
            console.error('CJ fetch error:', keyword, e.message);
            return {};
        }
    }
    return {};
}

// Fetch real shipping cost from CJ for a product
async function fetchShippingCost(pid, token) {
    try {
        const r = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate', {
            headers: { 'CJ-Access-Token': token },
            params: {
                startCountryCode: 'CN',
                endCountryCode: 'US',
                quantity: 1,
                pid
            },
            timeout: 8000
        });
        const list = r.data?.data || [];
        if (!list.length) return null;
        // Get cheapest shipping option
        const cheapest = list.reduce((min, s) => 
            parseFloat(s.logisticPrice || 999) < parseFloat(min.logisticPrice || 999) ? s : min
        , list[0]);
        return parseFloat(cheapest.logisticPrice || 0);
    } catch (e) {
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    const {
        page      = 1,
        pageSize  = 20,
        keyword   = '',
        search    = '',
        minPrice  = '',
        maxPrice  = '',
        countryCode = '',
        seed      = ''
    } = req.query;

    const q = (keyword || search || '').trim();
    const token = process.env.PRODUCTS_API_KEY;

    let browseKeyword = q;
    if (!q) {
        const seedNum = parseInt(seed) || Math.floor(Math.random() * KEYWORDS.length * 10);
        browseKeyword = KEYWORDS[seedNum % KEYWORDS.length];
    }

    const requestedPage = parseInt(page) || 1;
    const cjPage = (!q && requestedPage === 1)
        ? (Math.floor(Math.random() * 6) + 1)
        : requestedPage;

    const base = {
        pageNum:     cjPage,
        pageSize:    Math.min(parseInt(pageSize) || 20, 30),
        countryCode: countryCode || 'US'
    };

    if (minPrice) base.priceFrom = (parseFloat(minPrice) / 2.1).toFixed(2);
    if (maxPrice) base.priceTo   = (parseFloat(maxPrice) / 2.1).toFixed(2);

    try {
        let products = [], total = 0;

        let d = await fetchFromCJ(browseKeyword, base, token);
        products = d.list || [];
        total    = d.total || 0;

        if (!products.length && cjPage > 1) {
            d = await fetchFromCJ(browseKeyword, { ...base, pageNum: 1 }, token);
            products = d.list || [];
            total    = d.total || 0;
        }

        if (!products.length && !q) {
            for (const fallback of ['women dress', 'sneakers', 'phone case', 'jewelry']) {
                d = await fetchFromCJ(fallback, { ...base, pageNum: 1 }, token);
                if ((d.list||[]).length) { products = d.list; total = d.total||0; break; }
            }
        }

        if (!products.length && q) {
            const stop = new Set(['for','the','and','with','a','an','in','on','of','to']);
            const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !stop.has(w));
            for (const w of words.slice(0, 3)) {
                d = await fetchFromCJ(w, { ...base, pageNum: 1 }, token);
                if ((d.list||[]).length) { products = d.list; total = d.total||0; break; }
            }
        }

        // Apply 2.1x markup
        let result = products.map(p => ({
            ...p,
            sellPrice:     (parseFloat(p.sellPrice || 0) * 2.1).toFixed(2),
            originalPrice: p.sellPrice,
            shippingCost:  null // will be calculated below
        }));

        // Shuffle
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }

        // Price filter
        if (minPrice) result = result.filter(p => parseFloat(p.sellPrice) >= parseFloat(minPrice));
        if (maxPrice) result = result.filter(p => parseFloat(p.sellPrice) <= parseFloat(maxPrice));

        // Fetch shipping costs in parallel for up to 10 products
        // Filter out products where shipping > 40% of product price
        const shippingResults = await Promise.allSettled(
            result.slice(0, 10).map(p => fetchShippingCost(p.pid, token))
        );

        const finalResult = [];
        result.forEach((p, i) => {
            if (i < 10) {
                const shipCost = shippingResults[i].status === 'fulfilled' 
                    ? shippingResults[i].value 
                    : null;
                
                const sellPrice = parseFloat(p.sellPrice);
                
                // If we got shipping cost, check 40% rule
                if (shipCost !== null) {
                    const maxAllowedShipping = sellPrice * 0.4;
                    if (shipCost > maxAllowedShipping) return; // skip product
                    p.shippingCost = shipCost.toFixed(2);
                } else {
                    // No shipping data — include product but flag as unknown
                    p.shippingCost = null;
                }
                finalResult.push(p);
            } else {
                // Beyond 10 — include without shipping check
                finalResult.push(p);
            }
        });

        return res.status(200).json({ 
            products: finalResult, 
            total, 
            page: cjPage, 
            pageSize: base.pageSize, 
            keyword: browseKeyword 
        });
    } catch (e) {
        console.error('Products handler error:', e.message);
        return res.status(500).json({ error: 'Failed to fetch products', products: [] });
    }
}
