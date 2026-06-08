import axios from 'axios';

export default async function handler(req, res) {
  try {
    // Fetch products from CJ
    const r = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
      headers: { 'CJ-Access-Token': process.env.PRODUCTS_API_KEY },
      params: { pageNum: 1, pageSize: 200 },
      timeout: 10000
    });

    const products = r.data?.data?.list || [];

    const items = products.map(p => {
      const pid = p.pid || '';
      const name = (p.productNameEn || p.productName || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const price = parseFloat(p.sellPrice || 0).toFixed(2);
      const image = p.productImage || '';
      const link = `https://www.mova99.com/product?pid=${pid}`;
      const desc = (p.productDescription || p.remark || name).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\u4e00-\u9fff]+/g,'').substring(0, 500);

      return `
    <item>
      <g:id>${pid}</g:id>
      <g:title>${name.substring(0, 150)}</g:title>
      <g:description>${desc}</g:description>
      <g:link>${link}</g:link>
      <g:image_link>${image}</g:image_link>
      <g:price>${price} USD</g:price>
      <g:availability>in stock</g:availability>
      <g:condition>new</g:condition>
      <g:brand>Mova99</g:brand>
      <g:shipping>
        <g:country>US</g:country>
        <g:price>2.41 USD</g:price>
      </g:shipping>
    </item>`;
    }).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Mova99 Shopping Store</title>
    <link>https://www.mova99.com</link>
    <description>Millions of products with flat $2.41 shipping across the USA</description>
    ${items}
  </channel>
</rss>`;

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).send(xml);
  } catch(e) {
    console.error('Google feed error:', e.message);
    return res.status(500).json({ error: 'Feed generation failed' });
  }
}
