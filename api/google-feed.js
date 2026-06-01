import axios from 'axios';

// Google Merchant product categories mapping
const CATEGORY_MAP = {
  'women dress':        'Apparel & Accessories > Clothing > Dresses',
  'women hoodie':       'Apparel & Accessories > Clothing > Outerwear',
  'women blouse':       'Apparel & Accessories > Clothing > Shirts & Tops',
  'women activewear':   'Apparel & Accessories > Clothing > Activewear',
  'women swimwear':     'Apparel & Accessories > Clothing > Swimwear',
  'girls dress':        'Apparel & Accessories > Clothing > Dresses',
  'men shirt':          'Apparel & Accessories > Clothing > Shirts & Tops',
  'men jacket':         'Apparel & Accessories > Clothing > Outerwear',
  'men t-shirt':        'Apparel & Accessories > Clothing > Shirts & Tops',
  'boys shirt':         'Apparel & Accessories > Clothing > Shirts & Tops',
  'kids clothing':      'Apparel & Accessories > Clothing',
  'sneakers':           'Apparel & Accessories > Shoes > Athletic Shoes',
  'boots':              'Apparel & Accessories > Shoes > Boots',
  'sandals':            'Apparel & Accessories > Shoes > Sandals',
  'jewelry accessories':'Apparel & Accessories > Jewelry',
  'watch':              'Apparel & Accessories > Jewelry > Watches',
  'sunglasses':         'Apparel & Accessories > Clothing Accessories > Sunglasses',
  'handbag':            'Apparel & Accessories > Handbags, Wallets & Cases > Handbags',
  'tote bag':           'Apparel & Accessories > Handbags, Wallets & Cases > Handbags',
  'backpack':           'Apparel & Accessories > Bags > Backpacks',
  'beauty makeup':      'Health & Beauty > Personal Care > Cosmetics',
  'home kitchen':       'Home & Garden > Kitchen & Dining',
  'bedding set':        'Home & Garden > Linens & Bedding',
  'electronics':        'Electronics',
  'bluetooth earphones':'Electronics > Audio > Headphones',
  'car accessories':    'Vehicles & Parts > Vehicle Accessories',
  'sports fitness':     'Sporting Goods',
  'pet supplies':       'Animals & Pet Supplies',
};

// Keywords to fetch products from
const KEYWORDS = [
  'women dress', 'sneakers', 'handbag', 'jewelry accessories',
  'men shirt', 'home kitchen', 'beauty makeup', 'kids clothing',
  'sports fitness', 'watch', 'sunglasses', 'backpack',
  'bedding set', 'pet supplies', 'bluetooth earphones',
  'car accessories', 'women hoodie', 'men jacket', 'sandals',
  'women activewear', 'boots', 'tote bag'
];

// Fetch products from CJ for a keyword
async function fetchCJProducts(keyword, token) {
  try {
    const r = await axios.get(
      'https://developers.cjdropshipping.com/api2.0/v1/product/list',
      {
        headers: { 'CJ-Access-Token': token },
        params: {
          productNameEn: keyword,
          pageNum: Math.floor(Math.random() * 3) + 1,
          pageSize: 20,
          countryCode: 'US'
        },
        timeout: 10000
      }
    );
    return r.data?.data?.list || [];
  } catch (e) {
    console.error('CJ fetch error:', keyword, e.message);
    return [];
  }
}

// Clean product description for Google
function cleanDesc(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, ' ')           // strip HTML
    .replace(/[\u4e00-\u9fff]+/g, '')   // strip Chinese chars
    .replace(/https?:\/\/\S+/g, '')     // strip URLs
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim()
    .substring(0, 5000);                // Google max 5000 chars
}

// Clean product title for Google
function cleanTitle(text) {
  if (!text) return '';
  return text
    .replace(/[\u4e00-\u9fff]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 150);                 // Google max 150 chars
}

// Apply 2.4x markup
function applyMarkup(price) {
  const p = parseFloat(price || 0) * 2.4;
  return p.toFixed(2) + ' USD';
}

// Get Google category for a keyword
function getCategory(keyword) {
  return CATEGORY_MAP[keyword] || 'Apparel & Accessories';
}

export default async function handler(req, res) {
  const token = process.env.PRODUCTS_API_KEY;
  if (!token) {
    return res.status(500).send('PRODUCTS_API_KEY not configured');
  }

  // Cache headers — Google refreshes daily
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
  res.setHeader('Content-Disposition', 'inline; filename="products.txt"');

  // TSV header row — exactly what Google Merchant requires
  const headers = [
    'id',
    'title',
    'description',
    'price',
    'condition',
    'link',
    'availability',
    'image_link',
    'google_product_category',
    'brand',
    'shipping'
  ].join('\t');

  const rows = [headers];
  const seen = new Set();
  let totalProducts = 0;

  // Fetch products for each keyword
  for (const keyword of KEYWORDS) {
    const products = await fetchCJProducts(keyword, token);

    for (const p of products) {
      // Skip duplicates
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);

      const title = cleanTitle(p.productNameEn || p.productName || '');
      if (!title) continue;

      const image = p.productImage || '';
      if (!image) continue; // Google rejects products without images

      const price = applyMarkup(p.sellPrice);
      const desc  = cleanDesc(p.productDescription || p.productIntro || title);
      const cat   = getCategory(keyword);

      // Individual product page — buyer lands directly on this product
      const link = 'https://www.mova99.com/product?pid=' + encodeURIComponent(p.pid);

      const row = [
        p.pid,                    // id
        title,                    // title
        desc || title,            // description — fallback to title if empty
        price,                    // price
        'new',                    // condition
        link,                     // link
        'in_stock',               // availability
        image,                    // image_link — real CJ CDN URL
        cat,                      // google_product_category
        'Mova99',                 // brand
        'US:::0 USD'              // free shipping to USA
      ].map(v => String(v || '').replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t');

      rows.push(row);
      totalProducts++;
    }

    // Small delay between CJ requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[google-feed] Generated ${totalProducts} products`);

  // Return tab-delimited text file
  res.status(200).send(rows.join('\n'));
}
