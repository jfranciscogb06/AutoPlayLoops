/**
 * LoopMail - Auth & subscription verification
 * POST /api/auth
 * Body: { token: string } - Google access token from chrome.identity
 *
 * Returns:
 *   { subscribed: true } - user has active or trialing subscription
 *   { needsPayment: true, checkoutUrl: string } - user needs to complete Stripe checkout
 *   { error: string } - verification failed
 */

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-11-20.acacia' });
const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const TRIAL_DAYS = 7;

async function verifyGoogleToken(token) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error('Invalid token');
  const data = await res.json();
  if (!data.email) throw new Error('No email in token');
  return { email: data.email, sub: data.sub };
}

async function findOrCreateCustomer(email) {
  const list = await stripe.customers.list({ email, limit: 1 });
  if (list.data.length > 0) return list.data[0];
  return stripe.customers.create({ email });
}

async function hasActiveSubscription(customerId) {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 10,
  });
  return subs.data.some((s) => ['active', 'trialing'].includes(s.status));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing token' });
    }

    const { email } = await verifyGoogleToken(token);
    const customer = await findOrCreateCustomer(email);

    if (await hasActiveSubscription(customer.id)) {
      return res.status(200).json({ subscribed: true });
    }

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.BASE_URL || 'https://loopmail.vercel.app';
    const successUrl = `${baseUrl}/auth/success.html`;
    const cancelUrl = `${baseUrl}/auth/cancel.html`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
      },
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: { email },
    });

    return res.status(200).json({
      needsPayment: true,
      checkoutUrl: session.url,
    });
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: err.message || 'Auth failed' });
  }
}
