import { MongoClient } from 'mongodb';
import { Resend } from 'resend';

const uri = process.env.MONGODB_URI;
const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { email, password, code, action } = req.body || {};

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');

        // Send phone verification code for signup (anti-bot)
        if (action === 'send-phone-verify') {
            const { phone } = req.body;
            if (!phone) return res.status(400).json({ error: 'Phone number required' });
            const vcode = Math.floor(100000 + Math.random() * 900000).toString();
            const expiry = new Date(Date.now() + 10 * 60 * 1000);
            // Store temp verify code against phone number in a temp collection
                        const c2 = new MongoClient(process.env.MONGODB_URI);
            try {
                await c2.connect();
                await c2.db('foundry_db').collection('phone_verifications').updateOne(
                    { phone },
                    { $set: { phone, code: vcode, expiry, createdAt: new Date() } },
                    { upsert: true }
                );
            } finally { await c2.close(); }
            // Send SMS via SignalWire
            const swProjectId = process.env.SIGNALWIRE_PROJECT_ID;
            const swToken = process.env.SIGNALWIRE_TOKEN;
            const swSpace = process.env.SIGNALWIRE_SPACE;
            const swFrom = process.env.SIGNALWIRE_FROM;
            if (!swProjectId || !swToken) return res.status(500).json({ error: 'SMS not configured. Please contact support.' });
            const swRes = await fetch(`https://${swSpace}/api/laml/2010-04-01/Accounts/${swProjectId}/Messages.json`, {
                method: 'POST',
                headers: { 'Authorization': 'Basic ' + Buffer.from(swProjectId + ':' + swToken).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ From: swFrom, To: phone, Body: `Your Mova99 verification code: ${vcode}. Expires in 10 minutes.` })
            });
            if (!swRes.ok) {
                const errText = await swRes.text();
                console.error('SignalWire error:', errText);
                return res.status(500).json({ error: 'Failed to send SMS. Please check your phone number.' });
            }
            return res.status(200).json({ success: true });
        }

        // Verify phone code for signup
        if (action === 'verify-phone-code') {
            const { phone, code } = req.body;
            if (!phone || !code) return res.status(400).json({ error: 'Missing fields' });
                        const c2 = new MongoClient(process.env.MONGODB_URI);
            try {
                await c2.connect();
                const record = await c2.db('foundry_db').collection('phone_verifications').findOne({ phone });
                if (!record || record.code !== code) return res.status(401).json({ error: 'Invalid code. Please try again.' });
                if (new Date() > new Date(record.expiry)) return res.status(401).json({ error: 'Code expired. Please request a new one.' });
                // Delete used code
                await c2.db('foundry_db').collection('phone_verifications').deleteOne({ phone });
                return res.status(200).json({ success: true });
            } finally { await c2.close(); }
        }

        // Send verification code
        if (action === 'send-code') {
            const { method } = req.body;
            if (!email || !method) return res.status(400).json({ error: 'Missing fields' });
            const user = await db.collection('users').findOne({ email: email.toLowerCase() });
            if (!user) return res.status(404).json({ error: 'User not found' });

            const vcode = Math.floor(100000 + Math.random() * 900000).toString();
            const expiry = new Date(Date.now() + 10 * 60 * 1000);
            await db.collection('users').updateOne({ email: email.toLowerCase() }, { $set: { verifyCode: vcode, verifyCodeExpiry: expiry } });

            if (method === 'email') {
                await resend.emails.send({
                    from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>', to: user.email,
                    subject: 'Your Mova99 Login Code',
                    html: `<div style="font-family:sans-serif;max-width:500px;margin:auto;padding:40px;background:#0a0a0a;color:#fafafa">
                    <h2 style="font-size:20px;font-weight:900;text-transform:uppercase;color:#c9a84c">Login Verification</h2>
                    <p style="font-size:14px;color:#aaa;margin:16px 0">Your one-time login code:</p>
                    <div style="background:#111;border:2px solid #c9a84c;padding:24px;text-align:center;margin:16px 0">
                    <p style="font-size:42px;font-weight:900;letter-spacing:10px;margin:0;color:#fafafa">${vcode}</p>
                    </div>
                    <p style="font-size:12px;color:#555">Expires in 10 minutes. Do not share this code.</p>
                    </div>`
                });
                return res.status(200).json({ success: true, method: 'email', masked: user.email.replace(/(.{2}).*(@.*)/, '$1***$2') });
            }

if (method === 'sms') {
                // SMS temporarily disabled — use email verification instead
                return res.status(200).json({ success: true, method: 'email', masked: user.email });
            }
        }

        // Standard login
        if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
        const user = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid email or password' });

        if (code) {
            if (!user.verifyCode || user.verifyCode !== code) return res.status(401).json({ error: 'Invalid verification code' });
            if (new Date() > new Date(user.verifyCodeExpiry)) return res.status(401).json({ error: 'Code expired. Please request a new one.' });
            await db.collection('users').updateOne({ email: email.toLowerCase() }, { $unset: { verifyCode: '', verifyCodeExpiry: '' } });
        }

        const token = Buffer.from(user.uniqueID + ':' + Date.now()).toString('base64');
        return res.status(200).json({ token, id: user.uniqueID });
    } finally { await client.close(); }
}
