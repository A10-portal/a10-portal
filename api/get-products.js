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

export default async function handler(req, res) {
    // NO server-side cache — always fetch fresh from CJ so products vary every request
    // Browser cache also disabled so refresh always gets new products
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    const {
        page      = 1,
        pageSize  = 20,
        keyword   = '',
        search    = '',
        minPrice  = '',
        maxPrice  = '',
        countryCode = '',
        seed      = ''   // client sends a random seed to vary results
    } = req.query;

    const q = (keyword || search || '').trim();
    const token = process.env.PRODUCTS_API_KEY;

    // For browse (no search), use the seed from the client to pick a keyword.
    // Each page load the dashboard sends a different random seed → different keyword → different products.
    let browseKeyword = q;
    if (!q) {
        const seedNum = parseInt(seed) || Math.floor(Math.random() * KEYWORDS.length * 10);
        browseKeyword = KEYWORDS[seedNum % KEYWORDS.length];
    }

    // Pick a random page within a safe range (1-8) so results vary even for same keyword
    const requestedPage = parseInt(page) || 1;
    // For fresh browse loads (page=1), randomise the actual CJ page to get variety
    const cjPage = (!q && requestedPage === 1)
        ? (Math.floor(Math.random() * 6) + 1)  // random page 1-6 for browsing
        : requestedPage;

    const base = {
        pageNum:     cjPage,
        pageSize:    Math.min(parseInt(pageSize) || 20, 30),
        countryCode: countryCode || 'US'
    };

    if (minPrice) base.priceFrom = (parseFloat(minPrice) / 2.4).toFixed(2);
    if (maxPrice) base.priceTo   = (parseFloat(maxPrice) / 2.4).toFixed(2);

    try {
        let products = [], total = 0;

        // Primary fetch
        let d = await fetchFromCJ(browseKeyword, base, token);
        products = d.list || [];
        total    = d.total || 0;

        // If no results (e.g. page too high), retry on page 1 with same keyword
        if (!products.length && cjPage > 1) {
            d = await fetchFromCJ(browseKeyword, { ...base, pageNum: 1 }, token);
            products = d.list || [];
            total    = d.total || 0;
        }

        // Fallback keyword chain if still empty
        if (!products.length && !q) {
            for (const fallback of ['women dress', 'sneakers', 'phone case', 'jewelry']) {
                d = await fetchFromCJ(fallback, { ...base, pageNum: 1 }, token);
                if ((d.list||[]).length) { products = d.list; total = d.total||0; break; }
            }
        }

        // For user search: try progressively shorter terms
        if (!products.length && q) {
            const stop = new Set(['for','the','and','with','a','an','in','on','of','to']);
            const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !stop.has(w));
            for (const w of words.slice(0, 3)) {
                d = await fetchFromCJ(w, { ...base, pageNum: 1 }, token);
                if ((d.list||[]).length) { products = d.list; total = d.total||0; break; }
            }
        }

        // Apply 2.4x markup
        let result = products.map(p => ({
            ...p,
            sellPrice:     (parseFloat(p.sellPrice || 0) * 2.4).toFixed(2),
            originalPrice: p.sellPrice
        }));

        // Shuffle the result so the order itself varies on every load
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }

        // Price filter after markup
        if (minPrice) result = result.filter(p => parseFloat(p.sellPrice) >= parseFloat(minPrice));
        if (maxPrice) result = result.filter(p => parseFloat(p.sellPrice) <= parseFloat(maxPrice));

        // ── Google Merchant Feed format ──────────────────────────
        // When called with ?format=feed returns TSV for Google Merchant
        if (req.query.format === 'feed') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'public, s-maxage=86400');
            res.setHeader('Content-Disposition', 'inline; filename="products.txt"');

            const CATEGORY_MAP = {
                'women dress':'Apparel & Accessories > Clothing > Dresses',
                'men shirt':'Apparel & Accessories > Clothing > Shirts & Tops',
                'sneakers':'Apparel & Accessories > Shoes > Athletic Shoes',
                'jewelry accessories':'Apparel & Accessories > Jewelry',
                'handbag':'Apparel & Accessories > Handbags, Wallets & Cases > Handbags',
                'home kitchen':'Home & Garden > Kitchen & Dining',
                'beauty makeup':'Health & Beauty > Personal Care > Cosmetics',
                'kids clothing':'Apparel & Accessories > Clothing',
                'sports fitness':'Sporting Goods',
                'watch':'Apparel & Accessories > Jewelry > Watches',
                'sunglasses':'Apparel & Accessories > Clothing Accessories > Sunglasses',
                'backpack':'Apparel & Accessories > Bags > Backpacks',
                'bedding set':'Home & Garden > Linens & Bedding',
                'pet supplies':'Animals & Pet Supplies',
                'bluetooth earphones':'Electronics > Audio > Headphones',
                'car accessories':'Vehicles & Parts > Vehicle Accessories',
                'women hoodie':'Apparel & Accessories > Clothing > Outerwear',
                'men jacket':'Apparel & Accessories > Clothing > Outerwear',
                'sandals':'Apparel & Accessories > Shoes > Sandals',
                'boots':'Apparel & Accessories > Shoes > Boots',
            };

            const headers = ['id','title','description','price','condition','link','availability','image_link','google_product_category','brand','shipping'].join('	');
            const rows = [headers];

            result.forEach(p => {
                const title = (p.productNameEn || p.productName || '').replace(/[一-鿿]+/g,'').replace(/	|
/g,' ').trim().substring(0,150);
                if (!title || !p.productImage) return;
                const desc  = title;
                const price = parseFloat(p.sellPrice).toFixed(2) + ' USD';
                const link  = 'https://www.mova99.com/product?pid=' + encodeURIComponent(p.pid);
                const cat   = CATEGORY_MAP[browseKeyword] || 'Apparel & Accessories';
                const row   = [p.pid, title, desc, price, 'new', link, 'in_stock', p.productImage, cat, 'Mova99', 'US:::0 USD'].map(v => String(v||'').replace(/	/g,' ')).join('	');
                rows.push(row);
            });

            return res.status(200).send(rows.join('
'));
        }
        // ── Normal JSON response ──────────────────────────────────
        return res.status(200).json({ products: result, total, page: cjPage, pageSize: base.pageSize, keyword: browseKeyword });
    } catch (e) {
        console.error('Products handler error:', e.message);
        return res.status(500).json({ error: 'Failed to fetch products', products: [] });
    }
}
