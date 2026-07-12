import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

// Simple in-memory client reuse for serverless
let cachedClient = null;
async function getClient() {
    if (cachedClient) return cachedClient;
    cachedClient = new MongoClient(uri);
    await cachedClient.connect();
    return cachedClient;
}

function sanitize(str, max) {
    return String(str || '').replace(/[<>]/g, '').trim().substring(0, max);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const client = await getClient();
        const db = client.db('foundry_db');
        const reviews = db.collection('reviews');

        // ── GET: load reviews for a product ──
        if (req.method === 'GET') {
            const pid = sanitize(req.query.pid, 100);
            if (!pid) return res.status(400).json({ error: 'Missing pid' });

            const list = await reviews
                .find({ pid })
                .sort({ createdAt: -1 })
                .limit(100)
                .toArray();

            const count = list.length;
            const avg = count
                ? (list.reduce((s, r) => s + (r.rating || 0), 0) / count)
                : 0;

            // rating breakdown (how many 5-star, 4-star, etc.)
            const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
            list.forEach(r => { if (breakdown[r.rating] !== undefined) breakdown[r.rating]++; });

            return res.status(200).json({
                reviews: list.map(r => ({
                    name: r.name,
                    rating: r.rating,
                    title: r.title,
                    text: r.text,
                    date: r.createdAt
                })),
                count,
                average: Math.round(avg * 10) / 10,
                breakdown
            });
        }

        // ── POST: submit a new review ──
        if (req.method === 'POST') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
            const pid = sanitize(body.pid, 100);
            const rating = parseInt(body.rating);
            const name = sanitize(body.name, 40) || 'Anonymous';
            const title = sanitize(body.title, 80);
            const text = sanitize(body.text, 1000);

            if (!pid) return res.status(400).json({ error: 'Missing product' });
            if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Rating must be 1-5 stars' });
            if (!text || text.length < 3) return res.status(400).json({ error: 'Please write a short review' });

            // Basic rate-limit: max 1 review per pid per name per 60s (light abuse guard)
            const recent = await reviews.findOne({
                pid, name,
                createdAt: { $gt: new Date(Date.now() - 60 * 1000) }
            });
            if (recent) return res.status(429).json({ error: 'Please wait a moment before posting again' });

            const doc = {
                pid,
                rating,
                name,
                title,
                text,
                createdAt: new Date()
            };
            await reviews.insertOne(doc);

            return res.status(200).json({ success: true, review: {
                name: doc.name, rating: doc.rating, title: doc.title, text: doc.text, date: doc.createdAt
            }});
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (e) {
        console.error('Reviews API error:', e.message);
        return res.status(500).json({ error: 'Server error' });
    }
}
