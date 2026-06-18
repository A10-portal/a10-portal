import axios from 'axios';

const H = tok => ({ 'CJ-Access-Token': tok });

const SIZES = new Set([
    'xs','s','m','l','xl','xxl','xxxl','2xl','3xl','4xl','5xl','6xl',
    'small','medium','large','free size','one size','freesize','onesize',
    '36','37','38','39','40','41','42','43','44','45','46',
    '6','6.5','7','7.5','8','8.5','9','9.5','10','10.5','11','11.5','12'
]);
const COLORS = new Set([
    'black','white','red','blue','green','yellow','pink','purple','gray','grey','brown',
    'orange','beige','navy','gold','silver','rose','khaki','camel','wine','cream','ivory',
    'nude','multicolor','multi','transparent','burgundy','maroon','coral','turquoise',
    'cyan','lavender','mint','teal','indigo','violet','tan','peach','champagne',
    'coffee','apricot','army green','dark green','dark blue','light blue','light gray',
    'dark gray','hot pink','sky blue','olive','charcoal','slate','off white'
]);

function isSize(s) {
    const l = s.toLowerCase().trim();
    return SIZES.has(l) || /^\d?xl$/i.test(l) || /^[sml]$/i.test(l);
}
function isColor(s) {
    return COLORS.has(s.toLowerCase().trim());
}

function parseVariantName(raw) {
    if (!raw) return { color: '', size: '' };
    let color = '', size = '';

    if (raw.includes(':')) {
        raw.split(/[-\/]+/).forEach(part => {
            const [k, v] = part.split(':').map(s => s.trim());
            if (!v) return;
            const kl = k.toLowerCase();
            if (kl.includes('color') || kl.includes('colour')) color = v;
            else if (kl.includes('size')) size = v.toUpperCase();
        });
        if (color || size) return { color, size };
    }

    const parts = raw.split(/[\-\/\|,_ ]+/).map(p => p.trim()).filter(p => p);
    parts.forEach(p => {
        if (!size  && isSize(p))  size  = p.toUpperCase();
        if (!color && isColor(p)) color = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    });

    if (!color && !size && parts.length > 0) {
        const last = parts[parts.length - 1];
        if (isSize(last)) size = last.toUpperCase();
        else color = last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
    }
    return { color, size };
}



export default async function handler(req, res) {
    const { pid } = req.query;
    const TOKEN = process.env.PRODUCTS_API_KEY;
    if (!pid) return res.status(400).json({ error: 'Missing pid' });

    try {
        const [varRes, prodRes] = await Promise.allSettled([
            axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/variant/query',
                { headers: H(TOKEN), params: { pid } }),
            axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query',
                { headers: H(TOKEN), params: { pid } })
        ]);

        const rawVariants = varRes.status === 'fulfilled' ? (varRes.value.data?.data || []) : [];
        const product     = prodRes.status === 'fulfilled' ? (prodRes.value.data?.data || {}) : {};

        const attrs = product.productAttributes || product.productAttribute || [];
        let attrColors = [], attrSizes = [];
        attrs.forEach(a => {
            const name = (a.attrEnName || a.attrName || '').toLowerCase();
            const vals = (a.attrEnValue || a.attrValue || '').split(/[,，]+/).map(v => v.trim()).filter(Boolean);
            if (name.includes('color') || name.includes('colour')) attrColors = vals;
            else if (name.includes('size')) attrSizes = vals;
        });

        // Size labels to map against SKU suffix index (0001=S, 0002=M, etc)
        const SIZE_MAP = ['S','M','L','XL','2XL','3XL','4XL','5XL','6XL'];

        // Try to extract color from product name
        const COLOR_NAMES = ['Black','White','Red','Blue','Green','Yellow','Pink','Purple',
            'Gray','Grey','Brown','Orange','Beige','Navy','Gold','Silver','Rose','Khaki',
            'Camel','Wine','Cream','Ivory','Nude','Coral','Turquoise','Lavender','Mint',
            'Teal','Leopard','Floral','Striped','Plaid','Tie Dye','Camo'];
        const productNameUpper = (product.productNameEn || product.productName || '').toLowerCase();
        const nameColor = COLOR_NAMES.find(c => productNameUpper.includes(c.toLowerCase()));

        const variants = rawVariants.map((v, i) => {
            const parsed = parseVariantName(v.variantNameEn || v.variantName || '');
            let color = parsed.color;
            let size  = parsed.size;

            if (!color && !size) {
                const vn = (v.variantNameEn || '').toLowerCase();
                if (!color) {
                    const matchedColor = attrColors.find(c => vn.includes(c.toLowerCase()) || c.toLowerCase().includes(vn));
                    if (matchedColor) color = matchedColor;
                }
                if (!size) {
                    const matchedSize = attrSizes.find(s => vn.includes(s.toLowerCase()) || s.toLowerCase() === vn);
                    if (matchedSize) size = matchedSize.toUpperCase();
                }
            }

            const displayName = color && size ? color + ' / ' + size
                : color || size
                || (v.variantNameEn || v.variantName || ('Option ' + (i + 1)));

            return {
                vid:              v.vid || '',
                variantNameEn:    v.variantNameEn || '',
                variantImage:     v.variantImage  || '',
                variantStock:     v.variantStock  > 0 ? v.variantStock : 999,
                variantSellPrice: v.variantSellPrice
                    ? (parseFloat(v.variantSellPrice) * 2.4).toFixed(2) : '',
                productSku:       v.productSku  || '',
                variantSku:       v.variantSku  || '',
                color, size, displayName
            };
        });

        const hasColorVariants = variants.some(v => v.color);
        const hasSizeVariants  = variants.some(v => v.size);

        const strip = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/[\u4e00-\u9fff]+/g, '').replace(/\s+/g, ' ').trim();

        return res.status(200).json({
            pid:             product.pid || pid,
            productNameEn:   product.productNameEn || product.productName || '',
            sellPrice:       product.sellPrice ? (parseFloat(product.sellPrice) * 2.4).toFixed(2) : '',
            productImage:    product.productImage  || '',
            productGallery:  product.productGallery || [],
            productSku:      product.productSku    || '',
            productWeight:   product.productWeight || '',
            categoryName:    product.categoryName  || '',
            productDescription: strip(
                product.productDescription ||
                product.description        ||
                product.productIntro       ||
                product.remark             || ''
            ),
            productMaterial:    strip(product.productMaterial || ''),
            packingList:        strip(product.packingList || product.packageList || ''),
            productAttributes:  (product.productAttributes || []).map(a => ({ name: a.attrEnName||a.attrName||'', value: a.attrEnValue||a.attrValue||'' })).filter(a => a.name && a.value),
            availableColors: hasColorVariants ? [] : attrColors,
            availableSizes:  hasSizeVariants  ? [] : attrSizes,
            // Shipping = 10% of sell price
            shippingCost:    product.sellPrice ? (function(p){ const base = p >= 101 ? 5 : 7 + (p * 0.1); return Math.max(base, 3).toFixed(2); })(parseFloat(product.sellPrice) * 2.4) : null,
            shippingName:    'Standard Shipping',
            shippingDays:    '3-8',
            variants
        });

    } catch (e) {
        console.error('get-details error:', e.message);
        return res.status(500).json({ error: 'Failed', variants: [] });
    }
}
