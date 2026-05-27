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

async function handleFulfill(req, res) {
    const { orderId, userId, action, trackingNumber, trackingLink, declineReason } = req.body || {};
    if (!orderId || !userId || !action) return res.status(400).json({ error: 'Missing fields' });
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        let objectId;
        try { objectId = new ObjectId(orderId); } catch (e) { return res.status(400).json({ error: 'Invalid order ID' }); }
        const order = await db.collection('orders').findOne({ _id: objectId, userId });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        const user = await db.collection('users').findOne({ uniqueID: userId });
        const userEmail = user?.email || order.customerEmail || '';
        const firstName = (user?.fullName || 'Customer').split(' ')[0];

        if (action === 'ship') {
            if (!trackingNumber) return res.status(400).json({ error: 'Tracking number required' });
            await db.collection('orders').updateOne({ _id: objectId }, { $set: { status: 'shipped', trackingNumber, trackingLink: trackingLink||'', updatedAt: new Date() } });
            if (userEmail) await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>', to: userEmail,
                subject: 'Your Mova99 Order Has Shipped!',
                html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;background:#fafafa"><div style="background:#0a0a0a;padding:20px 28px;margin-bottom:24px"><h1 style="color:#fafafa;font-size:20px;font-weight:900;margin:0">Mova<span style="color:#c9a84c">99</span></h1></div><h2 style="font-size:22px;font-weight:900">Your Order is On Its Way! 📦</h2><p style="color:#666;font-size:14px;margin:12px 0">Dear ${firstName}, your order has been shipped.</p><div style="border:2px solid #0a0a0a;padding:20px;margin:20px 0;text-align:center"><p style="font-size:11px;text-transform:uppercase;color:#999;margin:0 0 8px;letter-spacing:.1em">Tracking Number</p><p style="font-size:22px;font-weight:900;margin:0;letter-spacing:2px">${trackingNumber}</p></div><p style="font-size:13px;color:#666">Estimated delivery: 6-13 business days.</p><a href="https://www.mova99.com/dashboard#orders" style="display:inline-block;background:#0a0a0a;color:white;padding:12px 24px;text-decoration:none;font-size:11px;font-weight:800;text-transform:uppercase;margin-top:16px">Track Order →</a></div>`
            });
            return res.status(200).json({ success: true });
        }

        if (action === 'decline') {
            if (!declineReason) return res.status(400).json({ error: 'Decline reason required' });
            await db.collection('orders').updateOne({ _id: objectId }, { $set: { status: 'declined', declineReason, updatedAt: new Date() } });
            if (userEmail) await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>', to: userEmail,
                subject: 'Important Update on Your Mova99 Order',
                html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;background:#fafafa"><h2 style="font-size:20px;font-weight:900">Order Update</h2><p style="font-size:14px;color:#666;margin:12px 0">Dear ${firstName},</p><p style="font-size:14px;color:#444;line-height:1.6">We regret to inform you that we were unable to process your order for the following reason:</p><div style="border-left:4px solid #ef4444;background:#fff5f5;padding:16px 20px;margin:16px 0"><p style="color:#ef4444;font-size:14px;margin:0">${declineReason}</p></div><p style="font-size:14px;color:#444">Your refund will be processed within 2-5 business days to your original payment method.</p><p style="font-size:13px;color:#666;margin-top:20px">You are welcome to place a new order anytime from your dashboard.</p></div>`
            });
            return res.status(200).json({ success: true });
        }
        return res.status(400).json({ error: 'Invalid action' });
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
