import { MongoClient } from 'mongodb';
import axios from 'axios';

const uri = process.env.MONGODB_URI;

// ── Image proxy — bypass CJ CDN hotlink protection ──────────────
async function handleImageProxy(req, res) {
    const url = req.query.img ? decodeURIComponent(req.query.img) : null;
    if (!url) return res.status(400).end();
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Vary', 'Accept');
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Referer': 'https://cjdropshipping.com/product/',
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'sec-fetch-dest': 'image',
                'sec-fetch-mode': 'no-cors',
                'sec-fetch-site': 'same-site'
            },
            redirect: 'follow'
        });
        if (!response.ok) return res.status(response.status).end();
        const ct = response.headers.get('content-type') || 'image/jpeg';
        const buf = await response.arrayBuffer();
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(Buffer.from(buf));
    } catch (e) {
        console.error('Image proxy error:', e.message);
        return res.status(500).end();
    }
}

// ── 17track API: register a tracking number ──────────────────────
async function register17track(trackingNumber) {
    const apiKey = process.env.TRACK17_API_KEY;
    if (!apiKey) return false;
    try {
        await axios.post('https://api.17track.net/track/v2.2/register',
            [{ number: trackingNumber }],
            {
                headers: {
                    '17token': apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 8000
            }
        );
        return true;
    } catch (e) {
        console.error('17track register error:', e.message);
        return false;
    }
}

// ── 17track API: fetch live tracking events ──────────────────────
async function fetch17trackEvents(trackingNumber) {
    const apiKey = process.env.TRACK17_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await axios.post('https://api.17track.net/track/v2.2/gettrackinfo',
            [{ number: trackingNumber }],
            {
                headers: {
                    '17token': apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        const accepted = r.data?.data?.accepted || [];
        if (!accepted.length) return null;

        const info = accepted[0];
        const track = info.track || {};


        // Events — each has: a=timestamp, s=description, l=location
        const events = (track.tracking_list || []).map(e => ({
            trackStatus: e.s || '',
            trackTime:   e.a || '',
            location:    e.l || '',
        })).filter(e => e.trackStatus);

        // Try every possible field where 17track puts the status code
        const latestStatus = info.tag || info.w1 || track.e || track.z0 || track.b || track.tag || '';
        const deliveryTime = track.edd || track.es || track.b1 || '';

        return { events, latestStatus, deliveryTime };
    } catch (e) {
        console.error('17track fetch error:', e.message);
        return null;
    }
}

// ── Main handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.query.img) return handleImageProxy(req, res);

    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const orders = client.db('foundry_db').collection('orders');
        const userOrders = await orders.find({ userId }).sort({ createdAt: -1 }).toArray();

        for (const order of userOrders) {

            // ── Enrich missing item names from CJ ──
            const needsEnrich = (order.items || []).some(i => !i.name || i.name === 'undefined');
            if (needsEnrich) {
                try {
                    const enriched = [];
                    for (const item of (order.items || [])) {
                        if (!item.name || item.name === 'undefined') {
                            try {
                                const r = await axios.get(
                                    'https://developers.cjdropshipping.com/api2.0/v1/product/variant/query',
                                    { headers: { 'CJ-Access-Token': process.env.PRODUCTS_API_KEY }, params: { pid: item.pid } }
                                );
                                const v = (r.data?.data || [])[0] || {};
                                enriched.push({ ...item, name: v.productNameEn || v.variantNameEn || ('Product ' + (item.pid || '').substring(0, 8)), image: v.variantImage || item.image || '' });
                            } catch (e) {
                                enriched.push({ ...item, name: 'Product ' + (item.pid || '').substring(0, 8) });
                            }
                        } else {
                            enriched.push(item);
                        }
                    }
                    await orders.updateOne({ _id: order._id }, { $set: { items: enriched } });
                    order.items = enriched;
                } catch (e) {}
            }

            // ── Live tracking via 17track ──────────────────────────
            if (order.trackingNumber && ['shipped', 'processing', 'payment_received'].includes(order.status)) {
                try {
                    // Register with 17track first (safe to call multiple times — idempotent)
                    await register17track(order.trackingNumber);

                    // Fetch live events
                    const trackData = await fetch17trackEvents(order.trackingNumber);

                    if (trackData) {
                        order.trackingEvents   = trackData.events;
                        order.trackingStatus   = trackData.latestStatus;
                        order.estimatedDelivery = trackData.deliveryTime;

                        // Auto-mark delivered — check status code (language-independent)
                        const deliveredCodes = ['Delivered', 'delivered', 'DELIVERED'];
                        if (deliveredCodes.includes(trackData.latestStatus) && order.status !== 'delivered') {
                            await orders.updateOne({ _id: order._id }, { $set: { status: 'delivered' } });
                            order.status = 'delivered';
                        }
                    }
                } catch (e) {
                    console.error('17track tracking error:', order.trackingNumber, e.message);
                }
            }
        }

        res.status(200).json(userOrders);
    } catch (error) {
        console.error('get-orders error:', error.message);
        res.status(500).json({ error: 'Failed to fetch orders' });
    } finally {
        await client.close();
    }
}
