import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { orderId, email } = req.query;
  if (!orderId || !email) return res.status(400).json({ error: 'Order ID and email are required' });

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('foundry_db');

    const order = await db.collection('orders').findOne({
      $or: [
        { orderId: orderId, userEmail: email.toLowerCase() },
        { orderId: orderId, guestEmail: email.toLowerCase() },
        { stripeSessionId: orderId, userEmail: email.toLowerCase() },
        { stripeSessionId: orderId, guestEmail: email.toLowerCase() }
      ]
    });

    if (!order) return res.status(404).json({ error: 'No order found with these details. Please check your Order ID and email address.' });

    // Parse cart from metadata if stored as string
    let cart = order.cart || [];
    if (typeof cart === 'string') {
      try { cart = JSON.parse(cart); } catch(e) { cart = []; }
    }

    // Calculate totals
    const subtotal = cart.reduce((s, i) => s + parseFloat(i.price || 0), 0);
    const shippingAmount = order.shippingAmount || 2.41;
    const total = order.total || (subtotal + shippingAmount);

    return res.status(200).json({
      orderId: order.orderId || order.stripeSessionId || order._id,
      status: order.status || 'Processing',
      createdAt: order.createdAt || order.paidAt,
      cart,
      subtotal,
      shippingAmount,
      total,
      customerName: order.customerName || order.shippingAddress?.name || '',
      shippingAddress: order.shippingAddress || {},
      payment: order.payment || {},
      trackingNumber: order.trackingNumber || null,
      trackingUrl: order.trackingUrl || null,
    });
  } catch(e) {
    console.error('Track order error:', e.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    await client.close();
  }
}
