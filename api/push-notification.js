import { MongoClient } from 'mongodb';
import webpush from 'web-push';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  'mailto:support@mova99.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

function verifyToken(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  try { return Buffer.from(token, 'base64').toString('utf8').startsWith(process.env.ADMIN_PASSWORD); }
  catch(e) { return false; }
}

// Auto scheduled messages
const AUTO_MESSAGES = {
  morning: [
    { title: 'Good Morning! ☀️', body: 'Jewelry from $3.22 — flat $2.41 shipping anywhere in the USA!', landing: '/dashboard' },
    { title: 'Mova99 Morning Deals 🛍️', body: 'Fresh deals just dropped! Shop millions of products from $8.', landing: '/dashboard' },
    { title: 'Start Your Day With Savings 💰', body: 'Flat $2.41 shipping on every order. Shop now at Mova99!', landing: '/dashboard' },
    { title: 'New Arrivals Today! ✨', body: 'Fashion, electronics, beauty and more — all with flat $2.41 shipping.', landing: '/dashboard' },
    { title: 'Morning Flash Sale ⚡', body: 'Limited time deals on jewelry, fashion and electronics at Mova99!', landing: '/dashboard' },
    { title: 'Earn While You Sleep 💸', body: 'Join our referral program — earn 5% on every purchase. Free to join!', landing: '/signup' },
    { title: 'Good Morning Shopper! 🌅', body: 'Millions of products waiting for you. Fast 3-8 day USA delivery.', landing: '/dashboard' },
  ],
  afternoon: [
    { title: 'Afternoon Deals at Mova99 🔥', body: 'Hot products from $8 with flat $2.41 shipping. Shop now!', landing: '/dashboard' },
    { title: 'Flash Sale Now Live! ⚡', body: 'Limited time prices on jewelry, fashion and electronics.', landing: '/dashboard' },
    { title: 'Did You See This? 👀', body: 'Jewelry from $3.22 with flat $2.41 shipping — only at Mova99!', landing: '/dashboard' },
    { title: 'Referral Earnings Waiting 💰', body: '300 referrals × $1,000 × 5% = $15,000. Start earning free!', landing: '/signup' },
    { title: 'Midday Deals 🛒', body: 'Shop millions of products with fast 3-8 day USA delivery.', landing: '/dashboard' },
    { title: 'Someone Just Ordered This 📦', body: 'Top selling products at unbeatable prices. See what\'s trending!', landing: '/dashboard' },
    { title: 'Flat $2.41 Shipping 🚚', body: 'No matter what you buy — shipping is always $2.41 at Mova99.', landing: '/dashboard' },
  ],
  evening: [
    { title: 'Evening Deals at Mova99 🌙', body: 'End your day with great savings. Products from $8 flat $2.41 ship!', landing: '/dashboard' },
    { title: 'Tonight Only Deals 🔥', body: 'Shop jewelry, fashion, electronics and more at Mova99!', landing: '/dashboard' },
    { title: 'Before You Sleep 💤', body: 'Grab tonight\'s best deals at Mova99. Fast USA delivery!', landing: '/dashboard' },
    { title: 'Earn $15,000 Free 💸', body: 'Join Mova99 referral program. 5% on every purchase. No investment!', landing: '/signup' },
    { title: 'Good Evening! 🌙', body: 'Millions of products from $8. Flat $2.41 shipping on every order.', landing: '/dashboard' },
    { title: 'Night Shopping at Mova99 🛍️', body: 'Browse and buy anytime. 24/7 shopping with fast USA delivery.', landing: '/dashboard' },
    { title: 'Last Chance Tonight ⏰', body: 'Today\'s best deals on jewelry, fashion and electronics!', landing: '/dashboard' },
  ]
};

function getRandomMessage(period) {
  const msgs = AUTO_MESSAGES[period] || AUTO_MESSAGES.morning;
  return msgs[Math.floor(Math.random() * msgs.length)];
}

async function sendToAll(db, title, body, landing) {
  const tokenDocs = await db.collection('push_tokens').find({}).toArray();
  const subscriptions = tokenDocs.map(t => {
    try { return JSON.parse(t.token); } catch(e) { return null; }
  }).filter(Boolean);

  if (!subscriptions.length) return { sent: 0, total: 0 };

  const payload = JSON.stringify({
    title,
    body,
    icon: 'https://www.mova99.com/image/logo.png',
    badge: 'https://www.mova99.com/image/logo.png',
    landing: landing || '/dashboard',
    url: 'https://www.mova99.com' + (landing || '/dashboard')
  });

  let sent = 0;
  const invalid = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        invalid.push(JSON.stringify(sub));
      }
    }
  }

  // Remove invalid tokens
  if (invalid.length > 0) {
    await db.collection('push_tokens').deleteMany({ token: { $in: invalid } });
  }

  return { sent, total: subscriptions.length };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = new MongoClient(process.env.MONGODB_URI);

  // Register device subscription
  if (req.method === 'POST' && req.query.action === 'register') {
    const { token, userId } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing token' });
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

  // Auto send — triggered by Vercel cron
  if (req.method === 'GET' && req.query.action === 'auto') {
    const period = req.query.period || 'morning';
    const msg = getRandomMessage(period);
    try {
      await client.connect();
      const db = client.db('foundry_db');
      const result = await sendToAll(db, msg.title, msg.body, msg.landing);
      await db.collection('notifications').insertOne({
        title: msg.title, body: msg.body,
        landingPage: msg.landing, type: 'auto',
        period, sentTo: result.total, delivered: result.sent,
        createdAt: new Date()
      });
      return res.status(200).json({ success: true, ...result });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    } finally { await client.close(); }
  }

  // Manual send — admin only
  if (req.method === 'POST' && req.query.action === 'send') {
    if (!verifyToken(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { title, body, landingPage } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'Missing title or body' });
    try {
      await client.connect();
      const db = client.db('foundry_db');
      const result = await sendToAll(db, title, body, landingPage);
      await db.collection('notifications').insertOne({
        title, body, landingPage: landingPage || '/dashboard',
        type: 'manual', sentTo: result.total, delivered: result.sent,
        createdAt: new Date()
      });
      return res.status(200).json({ success: true, ...result });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    } finally { await client.close(); }
  }

  // Get subscriber count
  if (req.method === 'GET' && req.query.action === 'count') {
    try {
      await client.connect();
      const db = client.db('foundry_db');
      const count = await db.collection('push_tokens').countDocuments();
      return res.status(200).json({ count });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    } finally { await client.close(); }
  }

  return res.status(400).json({ error: 'Invalid request' });
}
