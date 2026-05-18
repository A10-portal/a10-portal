import { MongoClient } from 'mongodb';
import { Resend } from 'resend';

const uri = process.env.MONGODB_URI;

// Reusable connection for serverless
let _client = null;
async function getDb() {
    if (!_client) {
        _client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    }
    try {
        // ping to check if connection is alive (works with MongoDB driver v6+)
        await _client.db('foundry_db').command({ ping: 1 });
    } catch(e) {
        // reconnect if ping fails
        _client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await _client.connect();
    }
    return _client.db('foundry_db');
}

export default async function handler(req, res) {
    // Enable CORS for same-origin fetch
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query.action;

    // ── GET user by id ──────────────────────────────────
    if (req.method === 'GET' && !action) {
        const rawId = req.query.id;
        if (!rawId) return res.status(400).json({ error: 'Missing id' });
        const id = decodeURIComponent(String(rawId)).trim();

        try {
            const db = await getDb();
            // Try both string and the raw value
            const user = await db.collection('users').findOne({
                $or: [{ uniqueID: id }, { uniqueID: id.toString() }]
            });

            if (!user) {
                console.error('[get-user] Not found. id=', id);
                return res.status(404).json({ error: 'User not found', queriedId: id });
            }

            return res.status(200).json({
                fullName:     user.fullName     || '',
                email:        user.email        || '',
                phone:        user.phone        || '',
                uniqueID:     user.uniqueID,
                referralCode: user.referralCode || ''
            });
        } catch (e) {
            console.error('[get-user] DB error:', e.message);
            return res.status(500).json({ error: 'Database error', detail: e.message });
        }
    }

    // ── POST actions ────────────────────────────────────
    if (req.method === 'POST') {

        // update-profile
        if (action === 'update-profile') {
            const { userId, field, value } = req.body || {};
            if (!userId || !field || value === undefined) return res.status(400).json({ error: 'Missing fields' });
            const allowed = ['fullName', 'email', 'phone', 'referralCode'];
            if (!allowed.includes(field)) return res.status(400).json({ error: 'Invalid field' });
            try {
                const db = await getDb();
                const update = {};
                update[field] = field === 'email' ? (value || '').toLowerCase() : value;
                await db.collection('users').updateOne({ uniqueID: String(userId) }, { $set: update });
                return res.status(200).json({ success: true });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // change-password
        if (action === 'change-password') {
            const { userId, oldPassword, newPassword } = req.body || {};
            if (!userId || !oldPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
            if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
            try {
                const db = await getDb();
                const user = await db.collection('users').findOne({ uniqueID: String(userId) });
                if (!user) return res.status(404).json({ error: 'User not found' });
                if (user.password !== oldPassword) return res.status(401).json({ error: 'Current password is incorrect' });
                await db.collection('users').updateOne({ uniqueID: String(userId) }, { $set: { password: newPassword } });
                return res.status(200).json({ success: true });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // forgot-password
        if (action === 'forgot-password') {
            const { email, code, newPassword, action: step } = req.body || {};
            const resend = new Resend(process.env.RESEND_API_KEY);
            try {
                const db = await getDb();
                if (step === 'send-code') {
                    if (!email) return res.status(400).json({ error: 'Email required' });
                    const user = await db.collection('users').findOne({ email: email.toLowerCase() });
                    if (!user) return res.status(404).json({ error: 'No account found with that email' });
                    const vcode = Math.floor(100000 + Math.random() * 900000).toString();
                    const expiry = new Date(Date.now() + 15 * 60 * 1000);
                    await db.collection('users').updateOne({ email: email.toLowerCase() }, { $set: { resetCode: vcode, resetCodeExpiry: expiry } });
                    await resend.emails.send({
                        from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>',
                        to: email,
                        subject: 'Reset Your Mova99 Password',
                        html: `<div style="font-family:sans-serif;max-width:500px;margin:auto;padding:40px;background:#0a0a0a;color:#fafafa"><h2 style="color:#ff6100">Password Reset</h2><p style="color:#aaa;margin:16px 0">Your reset code:</p><div style="background:#111;border:2px solid #ff6100;padding:24px;text-align:center"><p style="font-size:42px;font-weight:900;letter-spacing:10px;margin:0">${vcode}</p></div><p style="color:#555;font-size:12px;margin-top:16px">Expires in 15 minutes.</p></div>`
                    });
                    return res.status(200).json({ success: true });
                }
                if (step === 'verify-code') {
                    const user = await db.collection('users').findOne({ email: email.toLowerCase() });
                    if (!user || user.resetCode !== code) return res.status(401).json({ error: 'Invalid code' });
                    if (new Date() > new Date(user.resetCodeExpiry)) return res.status(401).json({ error: 'Code expired' });
                    return res.status(200).json({ success: true });
                }
                if (step === 'reset-password') {
                    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Missing fields' });
                    if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
                    const user = await db.collection('users').findOne({ email: email.toLowerCase() });
                    if (!user || user.resetCode !== code) return res.status(401).json({ error: 'Invalid or expired code' });
                    if (new Date() > new Date(user.resetCodeExpiry)) return res.status(401).json({ error: 'Code expired' });
                    await db.collection('users').updateOne({ email: email.toLowerCase() }, { $set: { password: newPassword }, $unset: { resetCode: '', resetCodeExpiry: '' } });
                    return res.status(200).json({ success: true });
                }
                return res.status(400).json({ error: 'Invalid step' });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // contact form
        if (action === 'contact') {
            const { name, email, phone, subject, message, isExistingCustomer } = req.body || {};
            if (!name || !email || !message) return res.status(400).json({ error: 'Missing fields' });
            const resend = new Resend(process.env.RESEND_API_KEY);
            const tag = isExistingCustomer ? '🛍️ EXISTING CUSTOMER MESSAGE' : '📬 WEBSITE CONTACT';
            const tagColor = isExistingCustomer ? '#22c55e' : '#ff6100';
            try {
                await resend.emails.send({
                    from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>',
                    to: process.env.ADMIN_EMAIL2 || process.env.ADMIN_EMAIL,
                    subject: (isExistingCustomer ? '[CUSTOMER] ' : '[WEBSITE] ') + (subject || 'Support Request') + ' — ' + name,
                    html: `<div style="font-family:sans-serif;max-width:650px;margin:auto;padding:0;background:#0a0a0a;color:#fafafa">
                    <div style="background:#111;padding:20px 32px;border-bottom:3px solid ${tagColor}">
                        <p style="font-size:10px;font-weight:900;text-transform:uppercase;color:${tagColor};margin:0 0 4px">${tag}</p>
                        <h2 style="font-size:18px;font-weight:900;margin:0">${subject || 'Support Request'}</h2>
                    </div>
                    <div style="padding:28px 32px">
                    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;background:#111">
                        <tr><td style="padding:10px 14px;color:#888;width:120px;border-bottom:1px solid #1a1a1a">Full Name</td><td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #1a1a1a">${name}</td></tr>
                        <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">Email</td><td style="padding:10px 14px;color:#4da6ff;border-bottom:1px solid #1a1a1a"><a href="mailto:${email}" style="color:#4da6ff">${email}</a></td></tr>
                        <tr><td style="padding:10px 14px;color:#888;border-bottom:1px solid #1a1a1a">Phone</td><td style="padding:10px 14px;color:#aaa;border-bottom:1px solid #1a1a1a">${phone || '—'}</td></tr>
                        <tr><td style="padding:10px 14px;color:#888">Type</td><td style="padding:10px 14px;color:${tagColor};font-weight:700">${isExistingCustomer ? 'Existing Customer' : 'New Visitor'}</td></tr>
                    </table>
                    <div style="background:#111;padding:20px;border-left:4px solid ${tagColor}">
                        <p style="font-size:14px;color:#ddd;line-height:1.8;margin:0;white-space:pre-wrap">${message.replace(/\n/g, '<br>')}</p>
                    </div>
                    <p style="font-size:11px;color:#555;margin-top:20px">Reply to <a href="mailto:${email}" style="color:#4da6ff">${email}</a></p>
                    </div></div>`
                });
                return res.status(200).json({ success: true });
            } catch (e) {
                console.error('Contact error:', e.message);
                return res.status(500).json({ error: 'Failed to send' });
            }
        }
    }

    return res.status(400).json({ error: 'Invalid request' });
}
