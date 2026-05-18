import { MongoClient } from 'mongodb';
import axios from 'axios';

const uri = process.env.MONGODB_URI;

// Image proxy — handles GET ?img=<url> to bypass CJ CDN hotlink protection
async function handleImageProxy(req, res) {
    const url = req.query.img ? decodeURIComponent(req.query.img) : null;
    if (!url) return res.status(400).end();
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
        if (!response.ok) {
            console.log('Image proxy failed:', url, response.status);
            return res.status(response.status).end();
        }
        const ct = response.headers.get('content-type') || 'image/jpeg';
        const buf = await response.arrayBuffer();
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).send(Buffer.from(buf));
    } catch (e) {
        console.error('Image proxy error:', e.message, url);
        return res.status(500).end();
    }
}

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
            // Enrich missing item names
            const needsEnrich = (order.items || []).some(i => !i.name || i.name === 'undefined');
            if (needsEnrich) {
                try {
                    const enriched = [];
                    for (const item of (order.items || [])) {
                        if (!item.name || item.name === 'undefined') {
                            try {
                                const r = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/variant/query', { headers: { 'CJ-Access-Token': process.env.CJ_ACCESS_TOKEN }, params: { pid: item.pid } });
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

            // Fetch live tracking if shipped
            if (order.trackingNumber && order.status === 'shipped') {
                try {
                    const trackRes = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/logistic/trackInfo', { headers: { 'CJ-Access-Token': process.env.CJ_ACCESS_TOKEN }, params: { trackNumber: order.trackingNumber } });
                    const trackData = trackRes.data?.data;
                    if (trackData) {
                        order.trackingEvents = trackData.trackInfos || trackData.tracks || [];
                        if (trackData.finalStatus === 'Delivered' || trackData.status === 'Delivered') {
                            await orders.updateOne({ _id: order._id }, { $set: { status: 'delivered' } });
                            order.status = 'delivered';
                        }
                    }
                } catch (e) {}
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
