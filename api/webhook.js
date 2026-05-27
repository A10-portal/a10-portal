import Stripe from 'stripe';
import { MongoClient } from 'mongodb';
import { Resend } from 'resend';
import axios from 'axios';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const uri = process.env.MONGODB_URI;
const resend = new Resend(process.env.RESEND_API_KEY);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const SITE = 'https://www.mova99.com';

export default async function handler(req, res) {
    // Always return 200 to Stripe immediately
    if (req.method !== 'POST') return res.status(200).json({ received: true });

    let rawBody;
    try { rawBody = await getRawBody(req); } catch(e) { return res.status(200).json({ received: true }); }

    let event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
        console.error('Webhook signature error:', e.message);
        return res.status(200).json({ received: true });
    }

    if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true });

    const rawSession = event.data.object;
    let session = rawSession;
    try {
        session = await stripe.checkout.sessions.retrieve(rawSession.id, { expand: ['customer_details'] });
    } catch(e) { console.error('Failed to expand session:', e.message); }

    const userId    = session.metadata?.userId    || '';
    const userEmail = session.metadata?.userEmail || '';
    const stripeSessionId = session.id;
    const paymentIntentId = session.payment_intent || '';
    const amountTotal = session.amount_total || 0;
    const customerEmail = session.customer_details?.email || session.customer_email || '';
    const customerName = session.customer_details?.name || '';
    const customerPhone = session.customer_details?.phone || '';
    const shippingAddress = session.shipping_details?.address || session.customer_details?.address || null;
    const shippingName = session.shipping_details?.name || customerName || '';

    let cartItems = [];
    try { cartItems = JSON.parse(session.metadata?.cart || '[]'); } catch (e) {}

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');

        const existing = await db.collection('orders').findOne({ stripeSessionId });
        if (existing) {
            console.log('[webhook] duplicate skipped:', stripeSessionId);
            return res.status(200).json({ received: true });
        }

        const user = await db.collection('users').findOne({ uniqueID: userId });
        const realName = user?.fullName || customerName || 'Customer';
        const firstName = realName.split(' ')[0];

        const enrichedItems = await Promise.all(cartItems.map(async (item) => {
            const basePid = (item.pid || '').split('-')[0];
            const vidPart = item.pid && item.pid.includes('-') ? item.pid.split('-').slice(1).join('-') : '';

            const rawName = (item.name || '');
            let productName, variantName;
            if (rawName.includes(' — ')) {
                const parts = rawName.split(' — ');
                productName = parts[0].trim() || ('Product ' + basePid.substring(0, 8));
                variantName = parts.slice(1).join(' — ').replace(/\(x\d+\)/, '').trim();
            } else if (rawName.includes(' - ')) {
                const parts = rawName.split(' - ');
                productName = parts[0].trim() || ('Product ' + basePid.substring(0, 8));
                variantName = parts.slice(1).join(' - ').replace(/\(x\d+\)/, '').trim();
            } else {
                productName = rawName.replace(/\(x\d+\)/, '').trim() || ('Product ' + basePid.substring(0, 8));
                variantName = item.variant || item.color || '';
            }
            const colorLabel = item.color || '';
            const sizeLabel  = item.size  || '';
            const variantDisplay = [colorLabel, sizeLabel].filter(Boolean).join(' / ') || variantName;

            let productSku = '', variantSku = '', productImage = item.image || '';

            try {
                const vr = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/variant/query', {
                    headers: { 'CJ-Access-Token': process.env.PRODUCTS_API_KEY },
                    params: { pid: basePid }
                });
                const variants = vr.data?.data || [];
                if (variants.length > 0) {
                    productSku = variants[0].productSku || variants[0].sku || '';
                    if (vidPart) {
                        const matched = variants.find(v => v.vid === vidPart);
                        if (matched) {
                            variantSku = matched.variantSku || '';
                            variantName = variantName || matched.variantNameEn || matched.variantName || '';
                            if (matched.variantImage) productImage = matched.variantImage;
                        }
                    }
                }
            } catch (e) {}

            const qty = item.qty || 1;
            const displayPrice = parseFloat(item.price || 0).toFixed(2);

            return {
                pid: item.pid, name: productName, sku: productSku, variantSku,
                variant: variantDisplay || variantName || '',
                image: productImage, color: item.color || '', size: item.size || '',
                price: item.price, qty, displayPrice
            };
        }));

        const orderDoc = {
            userId, stripeSessionId, paymentIntentId, amountTotal,
            customerEmail, customerName: realName, customerPhone,
            shippingName, shippingAddress, items: enrichedItems,
            status: 'payment_received', createdAt: new Date()
        };

        const inserted = await db.collection('orders').insertOne(orderDoc);
        const orderId = inserted.insertedId.toString();

        // Auto referral 5% balance
        try {
            if (userId) {
                const buyer = await db.collection('users').findOne({ uniqueID: userId });
                if (buyer && buyer.referredBy) {
                    const commission = parseFloat(((amountTotal / 100) * 0.05).toFixed(2));
                    await db.collection('users').updateOne(
                        { referralCode: buyer.referredBy },
                        { $inc: { referralBalance: commission } }
                    );
                }
            }
        } catch(e) { console.error('[webhook] Referral error:', e.message); }

        const addrLines = shippingAddress ? [
            shippingAddress.line1 || '',
            shippingAddress.line2 || '',
            [shippingAddress.city, shippingAddress.state, shippingAddress.postal_code].filter(Boolean).join(', '),
            shippingAddress.country || ''
        ].filter(Boolean) : ['Not provided'];

        const addrHtml = addrLines.join('<br>');

        async function proxyImg(u) {
            if (!u) return '';
            try {
                const r = await fetch(u, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
                        'Referer': 'https://www.mova99.com/',
                        'Accept': 'image/*'
                    }
                });
                if (!r.ok) return `${SITE}/api/get-orders?img=` + encodeURIComponent(u);
                const buf = await r.arrayBuffer();
                const b64 = Buffer.from(buf).toString('base64');
                const ct  = r.headers.get('content-type') || 'image/jpeg';
                return `data:${ct};base64,${b64}`;
            } catch(e) {
                return `${SITE}/api/get-orders?img=` + encodeURIComponent(u);
            }
        }

        const adminImgUrls = await Promise.all(enrichedItems.map(i => proxyImg(i.image || '')));
        const itemsAdminHtml = enrichedItems.map((i, idx) => {
            const imgCell = i.image
                ? `<img src="${adminImgUrls[idx]}" width="70" height="70" style="object-fit:cover;display:block;border:1px solid #333">`
                : `<div style="width:70px;height:70px;background:#1a1a1a;border:1px solid #333"></div>`;
            return `<tr>
                <td style="padding:12px;border-bottom:1px solid #222;vertical-align:top;width:82px">${imgCell}</td>
                <td style="padding:12px;border-bottom:1px solid #222;vertical-align:top">
                    <div style="font-size:13px;font-weight:700;color:#fafafa;margin-bottom:4px">${i.name}</div>
                    ${i.variant ? `<div style="font-size:12px;color:#c9a84c;margin-bottom:3px">🎨 ${i.variant}</div>` : ''}
                    ${i.sku ? `<div style="font-size:11px;color:#aaa;margin-top:3px">SKU: <span style="font-family:monospace;color:#fff">${i.sku}</span></div>` : ''}
                    ${i.variantSku ? `<div style="font-size:11px;color:#aaa">Variant SKU: <span style="font-family:monospace;color:#fff">${i.variantSku}</span></div>` : ''}
                    <a href="https://www.mova99.com/dashboard" style="font-size:11px;color:#4da6ff;margin-top:4px;display:inline-block">View Order →</a>
                </td>
                <td style="padding:12px;border-bottom:1px solid #222;text-align:center;color:#fafafa;vertical-align:top;font-size:14px;font-weight:700">${i.qty}</td>
                <td style="padding:12px;border-bottom:1px solid #222;text-align:right;color:#c9a84c;font-weight:700;vertical-align:top;font-size:14px">$${i.displayPrice}</td>
            </tr>`;
        }).join('');

        try {
            await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <support@mova99.com>',
                to: [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL2].filter(Boolean),
                subject: `🛒 NEW ORDER #${orderId.slice(-6).toUpperCase()} — $${(amountTotal/100).toFixed(2)} — ${realName}`,
                html: `<div style="font-family:Arial,sans-serif;max-width:780px;margin:auto;padding:0;background:#0a0a0a;color:#fafafa">
                <div style="background:#0a0a0a;padding:28px 32px;border-bottom:3px solid #c9a84c">
                    <h1 style="font-size:20px;font-weight:900;text-transform:uppercase;margin:0;color:#fafafa">Mova<span style="color:#c9a84c">99</span> — New Order</h1>
                </div>
                <div style="padding:28px 32px">
                <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;background:#111;border:1px solid #222">
                    <tr><td style="padding:10px 14px;color:#888;width:160px;border-bottom:1px solid #1a1a1a">Order Date</td><td style="padding:10px 14px;font-weight:700;color:#fafafa;border-bottom:1px solid #1a1a1a">${new Date().toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'America/New_York'})} EST</td></tr>
                    <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">Order ID</td><td style="padding:10px 14px;font-weight:700;color:#fafafa;border-bottom:1px solid #1a1a1a;font-family:monospace">${orderId}</td></tr>
                    <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">Payment ID</td><td style="padding:10px 14px;color:#aaa;border-bottom:1px solid #1a1a1a;font-family:monospace">${paymentIntentId}</td></tr>
                    <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">Customer</td><td style="padding:10px 14px;font-weight:700;color:#fafafa;border-bottom:1px solid #1a1a1a">${realName}</td></tr>
                    <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">Email</td><td style="padding:10px 14px;color:#4da6ff;border-bottom:1px solid #1a1a1a">${customerEmail}</td></tr>
                    <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">Phone</td><td style="padding:10px 14px;color:#aaa;border-bottom:1px solid #1a1a1a">${customerPhone || user?.phone || '—'}</td></tr>
                    <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">User ID</td><td style="padding:10px 14px;color:#aaa;border-bottom:1px solid #1a1a1a;font-family:monospace">${userId}</td></tr>
                    <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">Amount Paid</td><td style="padding:10px 14px;font-weight:900;font-size:18px;color:#c9a84c;border-bottom:1px solid #1a1a1a">$${(amountTotal/100).toFixed(2)}</td></tr>
                    <tr><td style="padding:10px 14px;color:#888">Ship To</td><td style="padding:10px 14px;color:#fafafa;line-height:1.6">${shippingName}<br>${addrHtml}</td></tr>
                </table>
                <h3 style="font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:#c9a84c;margin-bottom:12px;border-top:1px solid #222;padding-top:20px">Items (${enrichedItems.length})</h3>
                <table style="width:100%;border-collapse:collapse;background:#111;border:1px solid #222">
                    <tr style="background:#1a1a1a">
                        <th style="padding:10px;text-align:left;color:#888;font-size:10px;text-transform:uppercase">Image</th>
                        <th style="padding:10px;text-align:left;color:#888;font-size:10px;text-transform:uppercase">Product</th>
                        <th style="padding:10px;text-align:center;color:#888;font-size:10px;text-transform:uppercase">Qty</th>
                        <th style="padding:10px;text-align:right;color:#888;font-size:10px;text-transform:uppercase">Total</th>
                    </tr>
                    ${itemsAdminHtml}
                </table>
                <div style="margin-top:20px;padding:14px 18px;background:#111;border-left:4px solid #c9a84c">
                    <a href="https://dashboard.stripe.com/payments/${paymentIntentId}" style="color:#c9a84c;font-size:13px;font-weight:700">→ View on Stripe Dashboard</a>
                </div>
                </div></div>`
            });
        } catch (e) { console.error('Admin email error:', e.message); }

        const userImgUrls = await Promise.all(enrichedItems.map(i => proxyImg(i.image || '')));
        const itemsUserHtml = enrichedItems.map((i, idx) => {
            const imgCell = i.image
                ? `<img src="${userImgUrls[idx]}" width="65" height="65" style="object-fit:cover;display:block;border:1px solid #eee;border-radius:6px">`
                : `<div style="width:65px;height:65px;background:#f5f5f5;border:1px solid #eee;border-radius:6px"></div>`;
            return `<tr>
                <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top;width:77px">${imgCell}</td>
                <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top">
                    <div style="font-size:13px;font-weight:700;margin-bottom:3px">${i.name}</div>
                    ${i.variant ? `<div style="font-size:12px;color:#666;margin-bottom:2px">${i.variant}</div>` : ''}
                    <div style="font-size:11px;color:#aaa">Qty: ${i.qty}</div>
                </td>
                <td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:700;vertical-align:top">$${i.displayPrice}</td>
            </tr>`;
        }).join('');

        const emailTo = (customerEmail && customerEmail.includes('@') ? customerEmail : '')
            || (user?.email && user.email.includes('@') ? user.email : '')
            || (userEmail && userEmail.includes('@') ? userEmail : '')
            || '';

        if (emailTo) {
            try {
                await resend.emails.send({
                    from: process.env.NT_EMAIL || 'Mova99 <support@mova99.com>',
                    to: emailTo,
                    subject: `Order Confirmed ✓ — Mova99 #${orderId.slice(-6).toUpperCase()}`,
                    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;background:#fafafa;padding:0">
                    <div style="background:#0a0a0a;padding:24px 32px">
                        <h1 style="font-size:22px;font-weight:900;text-transform:uppercase;color:#fafafa;margin:0">Mova<span style="color:#c9a84c">99</span></h1>
                        <p style="color:#888;font-size:11px;margin:4px 0 0;text-transform:uppercase;letter-spacing:.1em">Premium Marketplace</p>
                    </div>
                    <div style="background:white;padding:32px;border:1px solid #eee">
                        <h2 style="font-size:22px;font-weight:900;margin:0 0 6px;color:#0a0a0a">Order Confirmed ✓</h2>
                        <p style="color:#888;font-size:13px;border-bottom:1px solid #eee;padding-bottom:16px;margin-bottom:24px">Order Reference: <strong style="color:#0a0a0a">#${orderId.slice(-6).toUpperCase()}</strong></p>
                        <p style="font-size:15px;margin-bottom:8px">Dear <strong>${firstName}</strong>,</p>
                        <p style="font-size:14px;color:#555;line-height:1.7;margin-bottom:24px">Thank you for your order! Your payment has been received and we are now processing your items.</p>
                        <div style="background:#f8f8f8;border-left:4px solid #c9a84c;padding:16px 20px;margin-bottom:24px">
                            <table style="width:100%;border-collapse:collapse;font-size:13px">
                                <tr><td style="color:#888;padding:3px 0">Order Date</td><td style="text-align:right;font-weight:700">${new Date().toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'America/New_York'})} EST</td></tr>
                                <tr><td style="color:#888;padding:3px 0">Payment Status</td><td style="text-align:right;color:#22c55e;font-weight:700">✓ Received</td></tr>
                                <tr><td style="color:#888;padding:3px 0">Order Total</td><td style="text-align:right;font-weight:900;font-size:18px;color:#0a0a0a">$${(amountTotal/100).toFixed(2)}</td></tr>
                                <tr><td style="color:#888;padding:3px 0">Processing Time</td><td style="text-align:right;font-weight:700">1-2 Business Days</td></tr>
                                <tr><td style="color:#888;padding:3px 0">Estimated Delivery</td><td style="text-align:right;font-weight:700">3-8 Business Days</td></tr>
                            </table>
                        </div>
                        <h3 style="font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:#333;margin-bottom:12px">Your Items</h3>
                        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">${itemsUserHtml}</table>
                        <div style="background:#f5f5f5;padding:16px;margin-bottom:24px;font-size:13px;border-left:3px solid #e0e0e0">
                            <strong style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#333">Shipping To</strong><br>
                            <span style="color:#555;line-height:1.8;margin-top:6px;display:block">${shippingName}<br>${addrHtml}</span>
                        </div>
                        <a href="https://www.mova99.com/dashboard#orders" style="display:inline-block;background:#ff6100;color:white;padding:14px 28px;text-decoration:none;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;border-radius:8px">Track My Order →</a>
                    </div>
                    <p style="font-size:11px;color:#aaa;text-align:center;padding:16px">© 2026 Mova99 · Premium Marketplace · USA Delivery</p>
                    </div>`
                });
            } catch (e) { console.error('Customer email error:', e.message); }
        }

        return res.status(200).json({ received: true });
    } catch(e) {
        console.error('[webhook] Error:', e.message);
        return res.status(200).json({ received: true });
    } finally {
        try { await client.close(); } catch(e) {}
    }
}
