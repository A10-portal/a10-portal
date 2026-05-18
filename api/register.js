import { MongoClient } from 'mongodb';
import { Resend } from 'resend';

const uri = process.env.MONGODB_URI;
const resend = new Resend(process.env.RESEND_API_KEY);

function generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'MOVA-';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { fullName, email, password, phone, referralCode, smsConsent, emailConsent } = req.body || {};
    if (!fullName || !email || !password) return res.status(400).json({ error: 'Missing required fields' });

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (existing) return res.status(409).json({ error: 'Email already registered' });

        let referredBy = '';
        if (referralCode && referralCode.trim()) {
            const referrer = await db.collection('users').findOne({ referralCode: referralCode.trim().toUpperCase() });
            if (referrer) referredBy = referralCode.trim().toUpperCase();
        }

        const uniqueID = Math.floor(1000000 + Math.random() * 9000000).toString();
        let finalReferralCode = generateReferralCode();
        while (await db.collection('users').findOne({ referralCode: finalReferralCode })) {
            finalReferralCode = generateReferralCode();
        }

        await db.collection('users').insertOne({
            uniqueID, fullName, email: email.toLowerCase(), password,
            phone: phone || '', referralCode: finalReferralCode,
            referredBy, smsConsent: smsConsent || false,
            emailConsent: emailConsent !== false, createdAt: new Date()
        });

        const token = Buffer.from(uniqueID + ':' + Date.now()).toString('base64');

        try {
            await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>', to: email,
                subject: 'Welcome to Mova99 — Your Account is Ready',
                html: `<div style="font-family:sans-serif;max-width:620px;margin:auto;padding:40px;background:#0a0a0a;color:#fafafa">
                <h1 style="font-size:28px;font-weight:900;text-transform:uppercase;border-bottom:3px solid #c9a84c;padding-bottom:12px;color:#fafafa">Welcome to Mova99</h1>
                <p style="font-size:15px;margin:20px 0">Hi ${fullName.split(' ')[0]},</p>
                <p style="font-size:14px;color:#aaa;line-height:1.7">Your account has been created. Start shopping thousands of premium products delivered directly to your door.</p>
                <div style="border:2px solid #c9a84c;padding:24px;margin:28px 0;background:#111">
                <p style="font-size:10px;text-transform:uppercase;color:#c9a84c;margin:0 0 8px;letter-spacing:.15em">Your Referral Code</p>
                <p style="font-size:28px;font-weight:900;margin:0;letter-spacing:4px;color:#fafafa">${finalReferralCode}</p>
                <p style="font-size:11px;color:#888;margin:10px 0 0">Share this code with friends to earn rewards</p>
                </div>
                <a href="https://www.mova99.com/dashboard" style="display:inline-block;background:#c9a84c;color:#0a0a0a;padding:14px 32px;text-decoration:none;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em">Start Shopping →</a>
                <p style="font-size:11px;color:#555;margin-top:32px">© 2026 Mova99 · Premium Marketplace · USA Delivery</p>
                </div>`
            });
        } catch (e) { console.error('Welcome email error:', e.message); }

        return res.status(200).json({ token, id: uniqueID, referralCode: finalReferralCode });
    } catch (e) {
        return res.status(500).json({ error: 'Server error' });
    } finally { await client.close(); }
}
 
