import Stripe from 'stripe';
import { MongoClient } from 'mongodb';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { cart, userId, checkedItems } = req.body;

        // Use only checked items if provided, otherwise use all cart items
        const itemsToCheckout = checkedItems && checkedItems.length > 0
            ? cart.filter(item => checkedItems.includes(item.pid))
            : cart;

        let userEmail = '';
        if (userId) {
            const _mc = new MongoClient(process.env.MONGODB_URI);
            try {
                await _mc.connect();
                const _u = await _mc.db('foundry_db').collection('users').findOne({ uniqueID: userId });
                if (_u) userEmail = _u.email || '';
            } catch(e) {} finally { await _mc.close(); }
        }

        if (!itemsToCheckout || itemsToCheckout.length === 0) return res.status(400).json({ error: 'Cart is empty' });

        // Calculate real shipping — use shippingCost from cart items if available
        // Each item carries its real CJ shipping cost fetched at product page load
        const totalShipping = itemsToCheckout.reduce((sum, item) => {
            const itemShip = parseFloat(item.shippingCost || 0);
            const qty = item.qty || 1;
            // Cap per-item shipping at qty * shippingCost (don't multiply full rate for each unit)
            return sum + (itemShip * Math.min(qty, 1));
        }, 0);
        // Minimum $2.41 shipping, round up to cents
        const shippingAmount = Math.round(Math.max(totalShipping, 2.41) * 100);
        const shippingGroups = 1; // kept for label compatibility

        const lineItems = itemsToCheckout.map(item => {
            const qty = item.qty || 1;
            const totalPrice = parseFloat(item.price) || 0;
            const unitPrice = totalPrice / qty;
            const unitAmount = Math.round(unitPrice * 100);
            const images = item.image && item.image.startsWith('http') ? [item.image] : [];
            const rawName = (item.name || 'Product');
            const sep = rawName.includes(' — ') ? ' — ' : ' - ';
            const nameParts = rawName.split(sep);
            const baseName = nameParts[0].trim().substring(0, 70);
            const colorSize = [item.color || '', item.size || ''].filter(Boolean).join(' / ');
            const nameSuffix = nameParts.length > 1 ? nameParts.slice(1).join(' — ').replace(/\(x\d+\)/, '').trim() : '';
            const variantLabel = colorSize || nameSuffix || (item.variant || '');
            const variantPart = variantLabel ? ' | ' + variantLabel.substring(0, 40) : '';
            return {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: (baseName + variantPart).substring(0, 127),
                        images: images.slice(0, 1)
                    },
                    unit_amount: unitAmount
                },
                quantity: qty
            };
        });

        // Build compressed cart string — must stay under 490 chars for Stripe metadata
        const buildCartStr = (items, level) => {
            if (level === 0) return JSON.stringify(items.map(i => ({
                p: (i.pid||'').substring(0,18),
                pr: parseFloat(i.price||0).toFixed(2),
                q: i.qty||1,
                c: (i.color||'').substring(0,6),
                s: (i.size||'').substring(0,5)
            })));
            if (level === 1) return JSON.stringify(items.map(i => ({
                p: (i.pid||'').substring(0,18),
                pr: parseFloat(i.price||0).toFixed(2),
                q: i.qty||1
            })));
            // Level 2 — absolute minimum
            return JSON.stringify(items.map(i => ({
                p: (i.pid||'').substring(0,15),
                pr: parseFloat(i.price||0).toFixed(2),
                q: i.qty||1
            })));
        };

        let cartStr = buildCartStr(itemsToCheckout, 0);
        if (cartStr.length > 490) cartStr = buildCartStr(itemsToCheckout, 1);
        if (cartStr.length > 490) cartStr = buildCartStr(itemsToCheckout, 2);
        if (cartStr.length > 490) cartStr = buildCartStr(itemsToCheckout.slice(0, 5), 2);
        if (cartStr.length > 490) cartStr = buildCartStr(itemsToCheckout.slice(0, 3), 2);

        // Build shipping label
        const shippingLabel = `Standard Shipping — USA ($${(shippingAmount/100).toFixed(2)})`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            ui_mode: 'embedded',
            shipping_address_collection: { allowed_countries: ['US'] },
            phone_number_collection: { enabled: true },
            billing_address_collection: 'required',
            shipping_options: [{
                shipping_rate_data: {
                    type: 'fixed_amount',
                    fixed_amount: { amount: shippingAmount, currency: 'usd' },
                    display_name: shippingLabel,
                    delivery_estimate: {
                        minimum: { unit: 'business_day', value: 3 },
                        maximum: { unit: 'business_day', value: 8 }
                    }
                }
            }],
            metadata: { userId: userId || '', userEmail: userEmail || '', cart: cartStr },
            return_url: (req.headers.origin || 'https://www.mova99.com') + '/success.html?session_id={CHECKOUT_SESSION_ID}',
        });

        return res.status(200).json({ clientSecret: session.client_secret });
    } catch (error) {
        console.error('Checkout error:', error.message);
        return res.status(500).json({ error: 'Failed to create checkout: ' + error.message });
    }
}
