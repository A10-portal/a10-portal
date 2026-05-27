import { MongoClient } from 'mongodb';

function verifyToken(req) {
    const token = req.headers['x-admin-token'];
    if (!token) return false;
    try { return Buffer.from(token, 'base64').toString('utf8').startsWith(process.env.ADMIN_PASSWORD); }
    catch (e) { return false; }
}

async function sendFirebaseNotification(tokens, title, body, landingPage) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    // Get access token using JWT
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
        iss: clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
    })).toString('base64url');

    const { createSign } = await import('crypto');
    const sign = createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(privateKey, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Send to all tokens in batches of 500
    const results = [];
    for (let i = 0; i < tokens.length; i += 500) {
        const batch = tokens.slice(i, i + 500);
        for (const token of batch) {
            try {
                const r = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: {
                            token,
                            notification: { title, body },
                            webpush: {
                                headers: {
                                    Urgency: 'high',
                                    VAPID: process.env.FIREBASE_VAPID_KEY || ''
                                },
                                notification: {
                                    title,
                                    body,
                                    icon: 'https://www.mova99.com/image/logo.png',
                                    badge: 'https://www.mova99.com/image/logo.png',
                                    click_action: `https://www.mova99.com${landingPage || '/dashboard'}`
                                },
                                fcm_options: {
                                    link: `https://www.mova99.com${landingPage || '/dashboard'}`
                                }
                            },
                            android: {
                                notification: {
                                    icon: 'logo',
                                    click_action: `https://www.mova99.com${landingPage || '/dashboard'}`
                                }
                            },
                            apns: {
                                payload: {
                                    aps: { badge: 1 }
                                }
                            },
                            data: { landing: landingPage || '/dashboard' }
                        }
                    })
                });
                results.push(r.ok);
            } catch(e) { results.push(false); }
        }
    }
    return results;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Register device token
    if (req.method === 'POST' && req.query.action === 'register') {
        const { token, userId } = req.body || {};
        if (!token) return res.status(400).json({ error: 'Missing token' });
        const client = new MongoClient(process.env.MONGODB_URI);
        try {
            await client.connect();
            const db = client.db('foundry_db');
            await db.collection('push_tokens').updateOne(
                { token },
                { $set: { token, userId: userId || '', updatedAt: new Date() } },
                { upsert: true }
            );
            return res.status(200).json({ success: true });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        } finally { await client.close(); }
    }

    // Send notification — admin only
    if (req.method === 'POST' && req.query.action === 'send') {
        if (!verifyToken(req)) return res.status(401).json({ error: 'Unauthorized' });
        const { title, body, landingPage } = req.body || {};
        if (!title || !body) return res.status(400).json({ error: 'Missing title or body' });

        const client = new MongoClient(process.env.MONGODB_URI);
        try {
            await client.connect();
            const db = client.db('foundry_db');
            const tokenDocs = await db.collection('push_tokens').find({}).toArray();
            const tokens = tokenDocs.map(t => t.token).filter(Boolean);

            if (tokens.length === 0) return res.status(200).json({ success: true, sent: 0, message: 'No registered devices' });

            const results = await sendFirebaseNotification(tokens, title, body, landingPage);
            const sent = results.filter(Boolean).length;

            // Save notification to DB for history
            await db.collection('notifications').insertOne({
                title, body, landingPage: landingPage || '/dashboard',
                sentTo: tokens.length, delivered: sent,
                createdAt: new Date()
            });

            return res.status(200).json({ success: true, sent, total: tokens.length });
        } catch(e) {
            console.error('Push notification error:', e.message);
            return res.status(500).json({ error: e.message });
        } finally { await client.close(); }
    }

    return res.status(400).json({ error: 'Invalid request' });
}
