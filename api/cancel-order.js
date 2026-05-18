import { MongoClient, ObjectId } from 'mongodb';
import { Resend } from 'resend';

const uri = process.env.MONGODB_URI;
const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
    const { orderId, userId } = req.query;
    if (!orderId || !userId) return res.status(400).json({ error: 'Missing fields' });

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('foundry_db');
        let objectId;
        try { objectId = new ObjectId(orderId); } catch (e) { return res.status(400).json({ error: 'Invalid order ID' }); }

        const order = await db.collection('orders').findOne({ _id: objectId, userId });
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const user = await db.collection('users').findOne({ uniqueID: userId });

        // Mark as cancelled
        await db.collection('orders').updateOne({ _id: objectId }, { $set: { status: 'cancelled', updatedAt: new Date() } });

        const itemsHtml = (order.items || []).map(i =>
            `<tr><td style="padding:8px;border-bottom:1px solid #333">
            ${i.image ? `<img src="${i.image}" width="50" height="50" style="object-fit:cover">` : ''}
            </td><td style="padding:8px;border-bottom:1px solid #333;color:#fafafa">
            <strong>${i.name || i.pid}</strong><br>
            ${i.variant ? `<span style="color:#c9a84c;font-size:12px">${i.variant}</span><br>` : ''}
            <span style="color:#888;font-size:11px">Qty: ${i.qty || 1}</span>
            </td></tr>`
        ).join('');

        const addrHtml = order.shippingAddress
            ? `${order.shippingAddress.line1 || ''}, ${order.shippingAddress.city || ''}, ${order.shippingAddress.state || ''} ${order.shippingAddress.postal_code || ''}`
            : 'N/A';

        try {
            await resend.emails.send({
                from: process.env.NT_EMAIL || 'Mova99 <onboarding@resend.dev>', to: process.env.ADMIN_EMAIL,
                subject: `⚠️ ORDER CANCELLATION — #${orderId.slice(-6).toUpperCase()}`,
                html: `<div style="font-family:sans-serif;max-width:700px;margin:auto;padding:40px;background:#0a0a0a;color:#fafafa">
                <h1 style="font-size:22px;font-weight:900;text-transform:uppercase;color:#ef4444;border-bottom:3px solid #ef4444;padding-bottom:12px">Order Cancellation Request</h1>
                <table style="width:100%;border-collapse:collapse;font-size:13px;margin:20px 0">
                <tr><td style="padding:7px;color:#888">Order ID</td><td style="padding:7px;font-weight:700">${orderId}</td></tr>
                <tr><td style="padding:7px;color:#888">Stripe Payment ID</td><td style="padding:7px">${order.paymentIntentId || '—'}</td></tr>
                <tr><td style="padding:7px;color:#888">Customer</td><td style="padding:7px;font-weight:700">${user?.fullName || userId}</td></tr>
                <tr><td style="padding:7px;color:#888">Email</td><td style="padding:7px">${user?.email || '—'}</td></tr>
                <tr><td style="padding:7px;color:#888">Phone</td><td style="padding:7px">${user?.phone || '—'}</td></tr>
                <tr><td style="padding:7px;color:#888">Amount Paid</td><td style="padding:7px;font-weight:700;color:#c9a84c">$${((order.amountTotal || 0)/100).toFixed(2)}</td></tr>
                <tr><td style="padding:7px;color:#888">Shipping To</td><td style="padding:7px">${addrHtml}</td></tr>
                <tr><td style="padding:7px;color:#888">Previous Status</td><td style="padding:7px">${order.status || '—'}</td></tr>
                </table>
                <h3 style="color:#c9a84c;font-size:13px;text-transform:uppercase">Items Ordered</h3>
                <table style="width:100%;border-collapse:collapse;background:#111">${itemsHtml}</table>
                <div style="margin-top:24px;padding:16px;background:#1a1a1a;border-left:3px solid #ef4444;font-size:13px;color:#aaa">
                If order was already placed with CJ, mark as Shipped in admin.<br>
                If not placed yet, reply to customer with refund confirmation (2-5 business days).
                </div>
                </div>`
            });
        } catch (e) { console.error('Cancel email error:', e.message); }

        return res.status(200).json({ success: true });
    } finally { await client.close(); }
}
