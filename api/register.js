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

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action } = req.body || {};

    // ── ACTION: verify-otp — complete registration ────────────────
    if (action === 'verify-otp') {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ error: 'Missing fields' });

        const client = new MongoClient(uri);
        try {
            await client.connect();
            const db = client.db('foundry_db');

            const pending = await db.collection('pending_registrations').findOne({
                email: email.toLowerCase()
            });

            if (!pending) return res.status(400).json({ error: 'No pending registration found. Please sign up again.' });

            // Check expiry — 10 minutes
            const age = (Date.now() - new Date(pending.createdAt).getTime()) / 1000 / 60;
            if (age > 10) {
                await db.collection('pending_registrations').deleteOne({ email: email.toLowerCase() });
                return res.status(400).json({ error: 'Code expired. Please sign up again.' });
            }

            if (pending.otp !== otp.trim()) {
                return res.status(400).json({ error: 'Incorrect code. Please try again.' });
            }

            // OTP correct — save user to database
            const uniqueID = pending.uniqueID;
            const finalReferralCode = pending.referralCode;

            await db.collection('users').insertOne({
                uniqueID,
                fullName: pending.fullName,
                email: email.toLowerCase(),
                password: pending.password,
                phone: '',
                referralCode: finalReferralCode,
                referredBy: pending.referredBy || '',
                smsConsent: false,
                emailConsent: pending.emailConsent !== false,
                emailVerified: true,
                createdAt: new Date()
            });

            // Remove pending record
            await db.collection('pending_registrations').deleteOne({ email: email.toLowerCase() });

            // Send welcome email
            try {
                await resend.emails.send({
                    from: process.env.NT_EMAIL || 'Mova99 <support@mova99.com>',
                    to: email,
                    subject: 'Welcome to Mova99 — Your Account is Ready',
                    html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;background:#ffffff">
                    <div style="background:#0a0a0a;padding:28px 32px">
                        <h1 style="font-size:22px;font-weight:900;color:#ffffff;margin:0">Mova<span style="color:#FF6100">99</span></h1>
                    </div>
                    <div style="padding:32px">
                        <h2 style="font-size:22px;font-weight:900;color:#1a1a1a;margin:0 0 8px">Welcome, ${pending.fullName.split(' ')[0]}! 🎉</h2>
                        <p style="color:#555;font-size:14px;line-height:1.7">Your account has been verified and created. Start shopping 10 million+ premium products delivered directly to your door across the USA.</p>
                        <div style="background:#fff3ed;border-left:4px solid #FF6100;padding:20px;margin:24px 0">
                            <p style="font-size:10px;font-weight:800;text-transform:uppercase;color:#FF6100;letter-spacing:.12em;margin:0 0 6px">Your Referral Code</p>
                            <p style="font-size:28px;font-weight:900;color:#1a1a1a;letter-spacing:4px;margin:0">${finalReferralCode}</p>
                            <p style="font-size:11px;color:#888;margin:8px 0 0">Share this code — earn 5% cash commission on every order your referrals place</p>
                        </div>
                        <a href="https://www.mova99.com/dashboard" style="display:inline-block;background:#FF6100;color:#ffffff;padding:14px 32px;text-decoration:none;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;border-radius:8px">Start Shopping →</a>
                    </div>
                    <p style="font-size:11px;color:#aaa;text-align:center;padding:16px">© 2026 Mova99 LLC · Premium Marketplace · USA Delivery</p>
                    </div>`
                });
            } catch (e) { console.error('Welcome email error:', e.message); }

            const token = Buffer.from(uniqueID + ':' + Date.now()).toString('base64');
            return res.status(200).json({ success: true, token, id: uniqueID, referralCode: finalReferralCode });

        } catch (e) {
            console.error('verify-otp error:', e.message);
            return res.status(500).json({ error: 'Server error' });
        } finally { await client.close(); }
    }

    // ── DEFAULT ACTION: initiate registration — send OTP ─────────
    const { fullName, email, password, referralCode, emailConsent } = req.body || {};
    if (!fullName || !email || !password) return res.status(400).json({ error: 'Missing required fields' });

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');

        // Check if already registered
        const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (existing) return res.status(409).json({ error: 'Email already registered' });

        // Check referral code
        let referredBy = '';
        if (referralCode && referralCode.trim()) {
            const referrer = await db.collection('users').findOne({ referralCode: referralCode.trim().toUpperCase() });
            if (referrer) referredBy = referralCode.trim().toUpperCase();
        }

        // Generate uniqueID and referral code
        const uniqueID = Math.floor(1000000 + Math.random() * 9000000).toString();
        let finalReferralCode = generateReferralCode();
        while (await db.collection('users').findOne({ referralCode: finalReferralCode })) {
            finalReferralCode = generateReferralCode();
        }

        // Generate OTP
        const otp = generateOTP();

        // Save to pending_registrations (not users yet)
        await db.collection('pending_registrations').updateOne(
            { email: email.toLowerCase() },
            { $set: {
                uniqueID, fullName, email: email.toLowerCase(), password,
                referralCode: finalReferralCode, referredBy,
                emailConsent: emailConsent !== false,
                otp, createdAt: new Date()
            }},
            { upsert: true }
        );

        // Send OTP email
        try {
            await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <support@mova99.com>',
                to: email,
                subject: 'Mova99 — Verify Your Email Address',
                html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;background:#ffffff">
                <div style="background:#0a0a0a;padding:24px 32px">
                    <h1 style="font-size:20px;font-weight:900;color:#ffffff;margin:0">Mova<span style="color:#FF6100">99</span></h1>
                </div>
                <div style="padding:32px">
                    <h2 style="font-size:20px;font-weight:900;color:#1a1a1a;margin:0 0 8px">Verify Your Email</h2>
                    <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:24px">Hi ${fullName.split(' ')[0]}, enter the code below to verify your email and complete your Mova99 account setup.</p>
                    <div style="background:#fff3ed;border:2px solid #FF6100;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px">
                        <p style="font-size:11px;font-weight:800;text-transform:uppercase;color:#FF6100;letter-spacing:.15em;margin:0 0 12px">Your Verification Code</p>
                        <p style="font-size:42px;font-weight:900;color:#1a1a1a;letter-spacing:10px;margin:0">${otp}</p>
                        <p style="font-size:11px;color:#888;margin:12px 0 0">This code expires in <strong>10 minutes</strong></p>
                    </div>
                    <p style="font-size:12px;color:#aaa;line-height:1.6">If you did not create a Mova99 account, you can safely ignore this email.</p>
                </div>
                <p style="font-size:11px;color:#aaa;text-align:center;padding:16px">© 2026 Mova99 LLC · Premium Marketplace</p>
                </div>`
            });
        } catch (e) {
            console.error('OTP email error:', e.message);
            return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
        }

        return res.status(200).json({ success: true, pendingVerification: true });

    } catch (e) {
        console.error('register error:', e.message);
        return res.status(500).json({ error: 'Server error' });
    } finally { await client.close(); }
}
