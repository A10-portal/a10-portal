import { MongoClient, ObjectId } from 'mongodb';
import { Resend } from 'resend';

const uri = process.env.MONGODB_URI;
const resend = new Resend(process.env.RESEND_API_KEY);

export const config = { api: { bodyParser: true } };

function verifyToken(req) {
    const token = req.headers['x-admin-token'];
    if (!token) return false;
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        return decoded.startsWith(process.env.ADMIN_PASSWORD) ||
               (process.env.ADMIN_PASSWORD2 && decoded.startsWith(process.env.ADMIN_PASSWORD2));
    }
    catch (e) { return false; }
}

async function handleAuth(req, res) {
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '';
    const allowedIP = process.env.ADMIN_ALLOWED_IP || '';
    if (allowedIP && clientIP !== allowedIP) return res.status(403).json({ error: 'Access denied' });
    const { password, adminType } = req.body || {};
    const isFood = adminType === 'food';
    const correctPass = isFood
        ? (process.env.ADMIN_PASSWORD2 || process.env.ADMIN_PASSWORD)
        : process.env.ADMIN_PASSWORD;
    if (!password || password !== correctPass) return res.status(401).json({ error: 'Invalid password' });
    const token = Buffer.from(password + ':' + Date.now()).toString('base64');
    return res.status(200).json({ success: true, token, adminType: adminType || 'product' });
}

async function handleStats(req, res) {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);
        const { dateFrom, dateTo } = req.query;
        const customStart = dateFrom ? new Date(dateFrom) : null;
        const customEnd = dateTo ? new Date(dateTo + 'T23:59:59') : null;

        const [totalUsers, totalOrders, pendingOrders, allOrders, todayOrders, weekOrders, newUsersToday, newUsersWeek] = await Promise.all([
            db.collection('users').countDocuments(),
            db.collection('orders').countDocuments(),
            db.collection('orders').countDocuments({ status: { $in: ['payment_received','processing'] } }),
            db.collection('orders').find({ status: { $in: ['payment_received','processing','shipped','delivered'] } }).toArray(),
            db.collection('orders').find({ createdAt: { $gte: todayStart } }).toArray(),
            db.collection('orders').find({ createdAt: { $gte: weekStart } }).toArray(),
            db.collection('users').countDocuments({ createdAt: { $gte: todayStart } }),
            db.collection('users').countDocuments({ createdAt: { $gte: weekStart } })
        ]);

        let customOrders = [], customUsers = 0;
        if (customStart) {
            const filter = { createdAt: { $gte: customStart, ...(customEnd ? { $lte: customEnd } : {}) } };
            customOrders = await db.collection('orders').find(filter).toArray();
            customUsers = await db.collection('users').countDocuments(filter);
        }
        return res.status(200).json({
            totalUsers, totalOrders, pendingOrders,
            totalRevenue: allOrders.reduce((s,o) => s+(o.amountTotal||0), 0),
            revenueToday: todayOrders.reduce((s,o) => s+(o.amountTotal||0), 0),
            revenueWeek: weekOrders.reduce((s,o) => s+(o.amountTotal||0), 0),
            ordersToday: todayOrders.length, ordersWeek: weekOrders.length,
            newUsersToday, newUsersWeek,
            customRevenue: customOrders.reduce((s,o) => s+(o.amountTotal||0), 0),
            customOrders: customOrders.length, customUsers
        });
    } finally { await client.close(); }
}

async function handleOrders(req, res) {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const orders = await client.db('foundry_db').collection('orders').find({}).sort({ createdAt: -1 }).toArray();
        return res.status(200).json(orders);
    } finally { await client.close(); }
}

async function handleUsers(req, res) {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);
        const allUsers = await db.collection('users').find({}).sort({ createdAt: -1 }).toArray();
        const enriched = await Promise.all(allUsers.map(async (user) => {
            const uid = user.uniqueID, rc = user.referralCode || '';
            const [totalOrders, todayArr, weekArr, referredUsers, refWeek] = await Promise.all([
                db.collection('orders').countDocuments({ userId: uid }),
                db.collection('orders').find({ userId: uid, createdAt: { $gte: todayStart } }).toArray(),
                db.collection('orders').find({ userId: uid, createdAt: { $gte: weekStart } }).toArray(),
                db.collection('users').countDocuments({ referredBy: rc }),
                db.collection('orders').aggregate([
                    { $lookup: { from: 'users', localField: 'userId', foreignField: 'uniqueID', as: 'u' } },
                    { $match: { 'u.referredBy': rc, createdAt: { $gte: weekStart } } },
                    { $group: { _id: null, total: { $sum: '$amountTotal' } } }
                ]).toArray()
            ]);
            return {
                uniqueID: uid, fullName: user.fullName || '', email: user.email || '',
                phone: user.phone || '', referralCode: rc, referredBy: user.referredBy || '',
                referralBalance: parseFloat(user.referralBalance || 0),
                createdAt: user.createdAt, totalOrders,
                ordersToday: todayArr.length, revenueToday: todayArr.reduce((s,o) => s+(o.amountTotal||0), 0),
                ordersWeek: weekArr.length, revenueWeek: weekArr.reduce((s,o) => s+(o.amountTotal||0), 0),
                referredUsers, referralRevenueWeek: refWeek[0]?.total || 0
            };
        }));
        return res.status(200).json(enriched);
    } catch (e) { return res.status(500).json({ error: e.message }); }
    finally { await client.close(); }
}

async function handleUpdateUser(req, res) {
    const { userId, email, phone, password } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        const { fullName } = req.body || {};
        const update = {};
        const { referralBalance } = req.body || {};
        if (fullName) update.fullName = fullName;
        if (email) update.email = email.toLowerCase();
        if (phone) update.phone = phone;
        if (password) update.password = password;
        if (referralBalance !== undefined && referralBalance !== '') {
            const bal = parseFloat(referralBalance);
            if (!isNaN(bal) && bal >= 0) update.referralBalance = bal;
        }
        if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
        await db.collection('users').updateOne({ uniqueID: userId }, { $set: update });
        return res.status(200).json({ success: true });
    } finally { await client.close(); }
}

async function handleUpdateShipping(req, res) {
    const { orderId, shipName, shipAddr1, shipAddr2, shipCity, shipState, shipZip, shipCountry, shipPhone } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        let objectId;
        try { objectId = new ObjectId(orderId); } catch (e) { return res.status(400).json({ error: 'Invalid order ID' }); }
        const order = await db.collection('orders').findOne({ _id: objectId });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        // Only allow editing if not yet shipped
        if (order.status === 'shipped' || order.status === 'delivered') {
            return res.status(400).json({ error: 'Order already shipped — address cannot be changed' });
        }
        const newAddress = {
            line1: shipAddr1 || '',
            line2: shipAddr2 || '',
            city: shipCity || '',
            state: shipState || '',
            postal_code: shipZip || '',
            country: shipCountry || 'United States'
        };
        await db.collection('orders').updateOne(
            { _id: objectId },
            { $set: {
                shippingName: shipName || order.shippingName || '',
                shippingAddress: newAddress,
                customerPhone: shipPhone || order.customerPhone || '',
                updatedAt: new Date()
            } }
        );

        // Email the customer a confirmation of the updated address
        const custEmail = order.customerEmail || '';
        if (custEmail && custEmail.includes('@')) {
            const orderIdShort = order._id.toString().slice(-6).toUpperCase();
            const fName = (shipName || order.shippingName || order.customerName || 'Customer').split(' ')[0];
            const addrHtml = [
                shipName || order.shippingName || '',
                newAddress.line1,
                newAddress.line2,
                [newAddress.city, newAddress.state, newAddress.postal_code].filter(Boolean).join(', '),
                newAddress.country,
                shipPhone ? '📞 ' + shipPhone : ''
            ].filter(Boolean).join('<br>');
            try {
                await resend.emails.send({
                    from: process.env.NT_EMAIL || 'Mova99 <notifications@mova99.com>', to: custEmail,
                    subject: `Shipping Address Updated — Mova99 #${orderIdShort}`,
                    html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;background:#fafafa"><div style="background:#0a0a0a;padding:20px 28px;margin-bottom:24px"><h1 style="color:#fafafa;font-size:20px;font-weight:900;margin:0">Mova<span style="color:#c9a84c">99</span></h1></div><h2 style="font-size:20px;font-weight:900">Shipping Address Updated ✓</h2><p style="font-size:12px;color:#999;margin:0 0 4px">Order #${orderIdShort}</p><p style="font-size:12px;color:#999;margin:0 0 8px">Account: ${custEmail}</p><p style="color:#666;font-size:14px;margin:12px 0">Dear ${fName}, the shipping address for your order has been updated to:</p><div style="background:#f5f5f5;padding:16px 18px;margin:16px 0;border-left:3px solid #c9a84c;font-size:14px;line-height:1.7">${addrHtml}</div><p style="font-size:13px;color:#666">If this isn't correct, please contact support@mova99.com right away with your order number <strong>#${orderIdShort}</strong>.</p></div>`
                });
            } catch (e) { console.error('[update-shipping] email error:', e.message); }
        }

        return res.status(200).json({ success: true });
    } finally { await client.close(); }
}

async function handleFulfill(req, res) {
    const { orderId, userId, action, trackingNumber, trackingLink, declineReason } = req.body || {};
    if (!orderId || !action) return res.status(400).json({ error: 'Order ID and action are required' });
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        let objectId;
        try { objectId = new ObjectId(orderId); } catch (e) { return res.status(400).json({ error: 'Invalid order ID' }); }
        // Match by orderId + userId if userId provided, otherwise match by orderId alone (guest orders)
        const query = userId ? { _id: objectId, userId } : { _id: objectId };
        const order = await db.collection('orders').findOne(query);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        const lookupUserId = userId || order.userId || '';
        const user = lookupUserId ? await db.collection('users').findOne({ uniqueID: lookupUserId }) : null;
        const userEmail = user?.email || order.customerEmail || '';
        const firstName = (user?.fullName || order.customerName || 'Customer').split(' ')[0];
        const orderIdShort = order._id.toString().slice(-6).toUpperCase();
        const orderRefHtml = `<p style="font-size:12px;color:#999;margin:0 0 4px">Order #${orderIdShort}</p><p style="font-size:12px;color:#999;margin:0 0 12px">Account: ${userEmail || 'N/A'}</p>`;

        if (action === 'ship') {
            if (!trackingNumber) return res.status(400).json({ error: 'Tracking number required' });
            await db.collection('orders').updateOne({ _id: objectId }, { $set: { status: 'shipped', trackingNumber, trackingLink: trackingLink||'', updatedAt: new Date() } });
            if (userEmail) await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>', to: userEmail,
                subject: `Your Mova99 Order #${orderIdShort} Has Shipped!`,
                html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;background:#fafafa"><div style="background:#0a0a0a;padding:20px 28px;margin-bottom:24px"><h1 style="color:#fafafa;font-size:20px;font-weight:900;margin:0">Mova<span style="color:#c9a84c">99</span></h1></div><h2 style="font-size:22px;font-weight:900">Your Order is On Its Way! 📦</h2>${orderRefHtml}<p style="color:#666;font-size:14px;margin:12px 0">Dear ${firstName}, your order has been shipped.</p><div style="border:2px solid #0a0a0a;padding:20px;margin:20px 0;text-align:center"><p style="font-size:11px;text-transform:uppercase;color:#999;margin:0 0 8px;letter-spacing:.1em">Tracking Number</p><p style="font-size:22px;font-weight:900;margin:0;letter-spacing:2px">${trackingNumber}</p></div><p style="font-size:13px;color:#666">Estimated delivery: 6-13 business days.</p><a href="https://www.mova99.com/dashboard#orders" style="display:inline-block;background:#0a0a0a;color:white;padding:12px 24px;text-decoration:none;font-size:11px;font-weight:800;text-transform:uppercase;margin-top:16px">Track Order →</a></div>`
            });
            return res.status(200).json({ success: true });
        }

        if (action === 'decline') {
            if (!declineReason) return res.status(400).json({ error: 'Decline reason required' });
            await db.collection('orders').updateOne({ _id: objectId }, { $set: { status: 'declined', declineReason, updatedAt: new Date() } });
            if (userEmail) await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>', to: userEmail,
                subject: `Important Update on Your Mova99 Order #${orderIdShort}`,
                html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;background:#fafafa"><div style="background:#0a0a0a;padding:20px 28px;margin-bottom:24px"><h1 style="color:#fafafa;font-size:20px;font-weight:900;margin:0">Mova<span style="color:#c9a84c">99</span></h1></div><h2 style="font-size:20px;font-weight:900">Order Update</h2>${orderRefHtml}<p style="font-size:14px;color:#666;margin:12px 0">Dear ${firstName},</p><p style="font-size:14px;color:#444;line-height:1.6">We regret to inform you that we were unable to process your order for the following reason:</p><div style="border-left:4px solid #ef4444;background:#fff5f5;padding:16px 20px;margin:16px 0"><p style="color:#ef4444;font-size:14px;margin:0">${declineReason}</p></div><p style="font-size:14px;color:#444">Your refund will be processed within 2-5 business days to your original payment method.</p><p style="font-size:13px;color:#666;margin-top:20px">You are welcome to place a new order anytime from your dashboard.</p></div>`
            });
            return res.status(200).json({ success: true });
        }
        return res.status(400).json({ error: 'Invalid action' });
    } finally { await client.close(); }
}


async function handleAddManualOrder(req, res) {
    const { userId, customerEmail, productName, price, qty, description, color, size, photo, trackingNumber, trackingLink, markShipped,
            shipName, shipAddr1, shipAddr2, shipCity, shipState, shipZip, shipCountry, shipPhone } = req.body || {};
    if (!customerEmail || !productName || !price) return res.status(400).json({ error: 'Email, product name and price are required' });
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');

        // Try to link to an existing user by userId or email
        let user = null;
        if (userId) user = await db.collection('users').findOne({ uniqueID: userId });
        if (!user && customerEmail) user = await db.collection('users').findOne({ email: customerEmail });
        const linkedUserId = user?.uniqueID || userId || '';
        const firstName = (user?.fullName || shipName || 'Customer').split(' ')[0];
        const priceNum = parseFloat(price) || 0;
        const qtyNum = Math.max(parseInt(qty) || 1, 1);
        const amountCents = Math.round(priceNum * qtyNum * 100); // total = price × qty, in cents

        const orderDoc = {
            userId: linkedUserId,
            customerEmail,
            customerPhone: shipPhone || user?.phone || '',
            shippingName: shipName || user?.fullName || '',
            shippingAddress: {
                line1: shipAddr1 || '',
                line2: shipAddr2 || '',
                city: shipCity || '',
                state: shipState || '',
                postal_code: shipZip || '',
                country: shipCountry || 'United States'
            },
            items: [{
                pid: 'MANUAL-' + Date.now(),
                name: productName,
                price: priceNum.toFixed(2),
                description: description || '',
                color: color || '',
                size: size || '',
                image: photo || '',
                qty: qtyNum
            }],
            amountTotal: amountCents,
            status: markShipped ? 'shipped' : 'processing',
            manualOrder: true,
            source: 'support_manual',
            trackingNumber: markShipped ? (trackingNumber || '') : '',
            trackingLink: markShipped ? (trackingLink || '') : '',
            createdAt: new Date(),
            updatedAt: new Date()
        };
        const result = await db.collection('orders').insertOne(orderDoc);
        const orderIdShort = result.insertedId.toString().slice(-6).toUpperCase();

        // Notify customer if marked shipped
        if (markShipped && customerEmail) {
            await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <notifications@mova99.com>', to: customerEmail,
                subject: `Your Mova99 Order #${orderIdShort} Has Shipped!`,
                html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;background:#fafafa"><div style="background:#0a0a0a;padding:20px 28px;margin-bottom:24px"><h1 style="color:#fafafa;font-size:20px;font-weight:900;margin:0">Mova<span style="color:#c9a84c">99</span></h1></div><h2 style="font-size:22px;font-weight:900">Your Order is On Its Way! 📦</h2><p style="font-size:12px;color:#999;margin:0 0 4px">Order #${orderIdShort}</p><p style="font-size:12px;color:#999;margin:0 0 8px">Account: ${customerEmail}</p><p style="color:#666;font-size:14px;margin:12px 0">Dear ${firstName}, your order for <strong>${productName}</strong>${qtyNum > 1 ? ` (x${qtyNum})` : ''} has been shipped.</p>${trackingNumber ? `<div style="border:2px solid #0a0a0a;padding:20px;margin:20px 0;text-align:center"><p style="font-size:11px;text-transform:uppercase;color:#999;margin:0 0 8px;letter-spacing:.1em">Tracking Number</p><p style="font-size:22px;font-weight:900;margin:0;letter-spacing:2px">${trackingNumber}</p></div>` : ''}<p style="font-size:13px;color:#666">Estimated delivery: 6-13 business days.</p><a href="https://www.mova99.com/dashboard#orders" style="display:inline-block;background:#0a0a0a;color:white;padding:12px 24px;text-decoration:none;font-size:11px;font-weight:800;text-transform:uppercase;margin-top:16px">Track Order →</a></div>`
            });
        } else if (customerEmail) {
            // Not shipped yet — send an "order received" confirmation with full details
            const shipBlock = (shipAddr1 || shipCity) ? `<div style="background:#f5f5f5;padding:14px 16px;margin:16px 0;border-left:3px solid #e0e0e0;font-size:13px;line-height:1.6"><strong style="font-size:11px;text-transform:uppercase;color:#333">Shipping To</strong><br>${shipName || firstName}<br>${shipAddr1 || ''}${shipAddr2 ? '<br>'+shipAddr2 : ''}<br>${[shipCity, shipState, shipZip].filter(Boolean).join(', ')}<br>${shipCountry || 'United States'}${shipPhone ? '<br>📞 '+shipPhone : ''}</div>` : '';
            const prodBlock = `<div style="border:1px solid #eee;padding:16px;margin:16px 0"><table style="width:100%;font-size:13px"><tr><td style="padding:4px 0"><strong>Product</strong></td><td style="text-align:right">${productName}${qtyNum > 1 ? ` (x${qtyNum})` : ''}</td></tr>${color ? `<tr><td style="padding:4px 0;color:#888">Color</td><td style="text-align:right">${color}</td></tr>` : ''}${size ? `<tr><td style="padding:4px 0;color:#888">Size</td><td style="text-align:right">${size}</td></tr>` : ''}<tr><td style="padding:4px 0;color:#888">Unit Price</td><td style="text-align:right">$${priceNum.toFixed(2)}</td></tr><tr><td style="padding:4px 0;color:#888">Quantity</td><td style="text-align:right">${qtyNum}</td></tr>${description ? `<tr><td style="padding:8px 0;color:#888" colspan="2"><em style="font-size:12px">${description}</em></td></tr>` : ''}</table></div>`;
            await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <notifications@mova99.com>', to: customerEmail,
                subject: `Order Received ✓ — Mova99 #${orderIdShort}`,
                html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;background:#fafafa"><div style="background:#0a0a0a;padding:20px 28px;margin-bottom:24px"><h1 style="color:#fafafa;font-size:20px;font-weight:900;margin:0">Mova<span style="color:#c9a84c">99</span></h1></div><h2 style="font-size:22px;font-weight:900">Order Received ✓</h2><p style="font-size:12px;color:#999;margin:0 0 4px">Order #${orderIdShort}</p><p style="font-size:12px;color:#999;margin:0 0 8px">Account: ${customerEmail}</p><p style="color:#666;font-size:14px;margin:12px 0">Dear ${firstName}, we've received your order and it's now being processed. You'll get another email with tracking once it ships.</p>${prodBlock}${shipBlock}<div style="background:#f8f8f8;border-left:4px solid #c9a84c;padding:14px 18px;margin:16px 0"><p style="font-size:13px;margin:0"><strong>Order Total:</strong> $${(amountCents/100).toFixed(2)}<br><strong>Shipping:</strong> <span style="color:#22c55e;font-weight:700">FREE</span></p></div><p style="font-size:12px;color:#888;margin-top:16px">Need to change your shipping address? Reply to this email or contact support@mova99.com with your order number <strong>#${orderIdShort}</strong> before it ships.</p></div>`
            });
        }
        return res.status(200).json({ success: true, orderId: result.insertedId.toString(), orderIdShort, linked: !!user });
    } finally { await client.close(); }
}

async function handleReferralStats(req, res) {
    const { refCode, dateFrom, dateTo } = req.query;
    if (!refCode) return res.status(400).json({ error: 'Missing refCode' });

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');

        // Count users who signed up with this referral code
        const referredUsers = await db.collection('users').countDocuments({ referredBy: refCode });

        // Get all users who were referred by this code
        const referredUserDocs = await db.collection('users').find({ referredBy: refCode }).toArray();
        const referredIds = referredUserDocs.map(u => u.uniqueID);

        // Build date filter
        const dateFilter = {};
        if (dateFrom) dateFilter.$gte = new Date(dateFrom);
        if (dateTo) dateFilter.$lte = new Date(dateTo + 'T23:59:59');

        // Get orders from referred users only
        const orderFilter = { userId: { $in: referredIds } };
        if (Object.keys(dateFilter).length > 0) orderFilter.createdAt = dateFilter;

        const referralOrderDocs = await db.collection('orders').find(orderFilter).toArray();
        const referralOrders = referralOrderDocs.length;
        const referralRevenue = referralOrderDocs.reduce((sum, o) => sum + (o.amountTotal || 0), 0);

        return res.status(200).json({ referredUsers, referralOrders, referralRevenue });
    } finally { await client.close(); }
}

export default async function handler(req, res) {
    const action = req.query.action;

    // ── IP check — called before admin page renders ──────────────
    if (action === 'check-ip') {
        const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
        const allowedIP = (process.env.ADMIN_ALLOWED_IP || '').trim();
        if (!allowedIP) return res.status(200).json({ allowed: true });
        const allowed = clientIP === allowedIP || clientIP.includes(allowedIP);
        console.log('[admin] IP check — client:', clientIP, 'allowed:', allowedIP, 'result:', allowed);
        return res.status(200).json({ allowed });
    }

    // Transaction routes
    if (action === 'add-transaction') return handleAddTransaction(req, res);
    if (action === 'get-transactions') return handleGetTransactions(req, res);

    if (action === 'auth') return handleAuth(req, res);
    if (!verifyToken(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (action === 'stats') return handleStats(req, res);
    if (action === 'orders') return handleOrders(req, res);
    if (action === 'users') return handleUsers(req, res);
    if (action === 'update-user') return handleUpdateUser(req, res);
    if (action === 'fulfill') return handleFulfill(req, res);
    if (action === 'update-shipping') return handleUpdateShipping(req, res);
    if (action === 'add-manual-order') return handleAddManualOrder(req, res);
    if (action === 'referral-stats') return handleReferralStats(req, res);
    return res.status(404).json({ error: 'Unknown action' });
}

// ── TRANSACTION HANDLER ─────────────────────────────────────
async function handleAddTransaction(req, res) {
    if (!verifyToken(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { userId, amount, type, paymentMethod, note } = req.body || {};
    if (!userId || !amount || !type) return res.status(400).json({ error: 'Missing fields' });
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        const user = await db.collection('users').findOne({ uniqueID: userId });
        if (!user) return res.status(404).json({ error: 'User not found' });
        const amt = parseFloat(amount);
        const transaction = {
            userId, type, amount: amt,
            paymentMethod: paymentMethod || 'Direct Deposit',
            note: note || '',
            createdAt: new Date()
        };
        await db.collection('transactions').insertOne(transaction);
        // Update referral balance
        if (type === 'debit') {
            await db.collection('users').updateOne({ uniqueID: userId }, { $inc: { referralBalance: -amt } });
        } else {
            await db.collection('users').updateOne({ uniqueID: userId }, { $inc: { referralBalance: amt } });
        }
        return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
    finally { await client.close(); }
}

async function handleGetTransactions(req, res) {
    if (!verifyToken(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        const transactions = await db.collection('transactions')
            .find({ userId })
            .sort({ createdAt: -1 })
            .toArray();
        return res.status(200).json(transactions);
    } catch(e) { return res.status(500).json({ error: e.message }); }
    finally { await client.close(); }
}
