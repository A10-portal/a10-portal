import Stripe from 'stripe';
import { MongoClient } from 'mongodb';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { cart, userId } = req.body;
        let userEmail = '';
        // Look up user email from DB so webhook can always reach them
        if (userId) {
            const _mc = new MongoClient(process.env.MONGODB_URI);
            try {
                await _mc.connect();
                const _u = await _mc.db('foundry_db').collection('users').findOne({ uniqueID: userId });
                if (_u) userEmail = _u.email || '';
            } catch(e) {} finally { await _mc.close(); }
        }
        if (!cart || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

        const lineItems = cart.map(item => {
            const qty = item.qty || 1;
            // price stored in cart is CJ cost * markup for ONE item * qty total
            // we need unit price = total price / qty
            const totalPrice = parseFloat(item.price) || 0;
            const unitPrice = totalPrice / qty;
            // Round to cents
            const unitAmount = Math.round(unitPrice * 100);

            const images = item.image && item.image.startsWith('http') ? [item.image] : [];
            // Support both ' - ' and ' — ' separators in item name
            const rawName = (item.name || 'Product');
            const sep = rawName.includes(' — ') ? ' — ' : ' - ';
            const nameParts = rawName.split(sep);
            const baseName = nameParts[0].trim().substring(0, 70);
            // Build variant label from color/size fields first, fallback to name suffix
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

        // Cart metadata for webhook — Stripe limit 500 chars per key
        // Include color/size/variant so webhook email shows correct info
        const cartMeta = cart.map(i => ({
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
            // Trim to fit — drop image first, then shorten name
            cartStr = JSON.stringify(cartMeta.map(i => ({
                pid: i.pid, price: i.price, qty: i.qty,
                name: i.name.substring(0, 25),
                color: i.color, size: i.size, variant: i.variant
            })));
        }
        if (cartStr.length > 490) {
            // Last resort — bare minimum
            cartStr = JSON.stringify(cartMeta.map(i => ({
                pid: i.pid, price: i.price, qty: i.qty, variant: i.variant
            })));
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            shipping_address_collection: { allowed_countries: ['US'] },
            phone_number_collection: { enabled: true },
            billing_address_collection: 'required',
            shipping_options: [{
                shipping_rate_data: {
                    type: 'fixed_amount',
                    fixed_amount: { amount: 241, currency: 'usd' },
                    display_name: 'Standard Shipping (4-9 business days)',
                    delivery_estimate: {
                        minimum: { unit: 'business_day', value: 4 },
                        maximum: { unit: 'business_day', value: 9 }
                    }
                }
            }],
            metadata: { userId: userId || '', userEmail: userEmail || '', cart: cartStr },
            success_url: (req.headers.origin || 'https://www.mova99.com') + '/success.html?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: (req.headers.origin || 'https://www.mova99.com') + '/dashboard'
        });

        return res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error.message);
        return res.status(500).json({ error: 'Failed to create checkout: ' + error.message });
    }
}
