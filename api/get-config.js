export default function handler(req, res) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.status(200).json({
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || ''
    });
}
