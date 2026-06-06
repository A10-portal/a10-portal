import Stripe from 'stripe';
import { MongoClient } from 'mongodb';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { cart, userId, checkedItems, guestEmail } = req.body;

        const itemsToCheckout = checkedItems && checkedItems.length > 0
            ? cart.filter(item => checkedItems.includes(item.pid))
            : cart;

        let userEmail = guestEmail || '';
        if (userId) {
            const _mc = new MongoClient(process.env.MONGODB_URI);
            try {
                await _mc.connect();
                const _u = await _mc.db('foundry_db').collection('users').findOne({ uniqueID: userId });
                if (_u) userEmail = _u.email || '';
            } catch(e) {} finally { await _mc.close(); }
        }

        if (!itemsToCheckout || itemsToCheckout.length === 0) return res.status(400).json({ error: 'Cart is empty' });

        const totalQty = itemsToCheckout.reduce((sum, item) => sum + (item.qty || 1), 0);
        const shippingGroups = Math.ceil(totalQty / 6);
        const shippingAmount = Math.round(241 * shippingGroups);

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

        const cartMeta = itemsToCheckout.map(i => ({
            pid:     (i.pid     || '').substring(0, 36),
            price:   i.price    || '0',
            name:    (i.name    || '').substring(0, 45),
            image:   (i.image   || '').substring(0, 100),
            qty:     i.qty      || 1,
            color:   (i.color   || '').substring(0, 20),
            size:    (i.size    || '').substring(0, 10),
            variant: (i.variant || '').substring(0, 30)
        }));

        let cartStr = JSON.stringify(cartMeta);
        if (cartStr.length > 490) {
            cartStr = JSON.stringify(cartMeta.map(i => ({
                pid: i.pid, price: i.price, qty: i.qty,
                name: i.name.substring(0, 25),
                color: i.color, size: i.size, variant: i.variant
            })));
        }
        if (cartStr.length > 490) {
            cartStr = JSON.stringify(cartMeta.map(i => ({
                pid: i.pid, price: i.price, qty: i.qty, variant: i.variant
            })));
        }

        const shippingLabel = shippingGroups > 1
            ? `Standard Shipping x${shippingGroups} ($${(shippingAmount/100).toFixed(2)})`
            : 'Standard Shipping (3-8 business days)';

        const sessionData = {
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
            metadata: {
                userId: userId || '',
                userEmail: userEmail || '',
                guestEmail: guestEmail || '',
                isGuest: userId ? 'false' : 'true',
                cart: cartStr
            },
            return_url: (req.headers.origin || 'https://www.mova99.com') + '/success.html?session_id={CHECKOUT_SESSION_ID}',
        };

        // Pre-fill email if we have it
        if (userEmail) {
            sessionData.customer_email = userEmail;
        }

        const session = await stripe.checkout.sessions.create(sessionData);
        return res.status(200).json({ clientSecret: session.client_secret });
    } catch (error) {
        console.error('Checkout error:', error.message);
        return res.status(500).json({ error: 'Failed to create checkout: ' + error.message });
    }
}
