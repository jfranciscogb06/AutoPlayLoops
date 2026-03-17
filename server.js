/**
 * LoopMail - Express server for Render deployment
 * Serves API routes and static website
 */

import express from 'express';
import Stripe from 'stripe';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2024-11-20.acacia' }) : null;

const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const TRIAL_DAYS = 7;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

function getBaseUrl() {
  return process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
}

// Request logging (helps verify requests reach Render)
app.use('/api', (req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// CORS for API
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, stripe-signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Webhook MUST use raw body for Stripe signature - define before json parser
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const sig = req.headers['stripe-signature'];
    if (!sig || !WEBHOOK_SECRET) {
      return res.status(400).json({ error: 'Missing signature or webhook secret' });
    }
    stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(400).json({ error: err.message || 'Webhook failed' });
  }
});

// JSON body parser for other API routes
app.use('/api', express.json());

// GET /api/health - verify server is running
app.get('/api/health', (req, res) => res.json({ ok: true }));

// GET /api/debug - verify Stripe config (no secrets exposed)
app.get('/api/debug', (req, res) => {
  const hasSecretKey = !!(process.env.STRIPE_SECRET_KEY || '').trim();
  const hasPriceId = !!(process.env.STRIPE_PRICE_ID || '').trim();
  const hasWebhookSecret = !!(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const secretKeyType = hasSecretKey
    ? (process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'test' : process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'unknown')
    : null;
  res.json({
    stripeSecretKey: hasSecretKey ? 'set' : 'missing',
    stripeSecretKeyType: secretKeyType,
    stripePriceId: hasPriceId ? 'set' : 'missing',
    stripeWebhookSecret: hasWebhookSecret ? 'set' : 'missing',
    baseUrl: getBaseUrl(),
    ready: hasSecretKey && hasPriceId,
  });
});

async function verifyGoogleToken(token) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error_description || data.error || 'Invalid token';
    throw new Error(err === 'Invalid Value' || err.includes('invalid') ? 'Token expired. Please sign in again.' : err);
  }
  if (!data.email) throw new Error('No email in token');
  return { email: data.email };
}

// POST /api/auth (Google token only)
app.post('/api/auth', async (req, res) => {
  try {
    if (!(process.env.STRIPE_SECRET_KEY || '').trim()) {
      return res.status(503).json({ error: 'Server misconfigured: STRIPE_SECRET_KEY is not set. Add it in Render Environment.' });
    }
    if (!(process.env.STRIPE_PRICE_ID || '').trim()) {
      return res.status(503).json({ error: 'Server misconfigured: STRIPE_PRICE_ID is not set. Add it in Render Environment.' });
    }

    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing token' });
    }
    const { email } = await verifyGoogleToken(token);

    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    let customer = (await stripe.customers.list({ email, limit: 1 })).data[0];
    if (!customer) customer = await stripe.customers.create({ email });

    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 10 });
    if (subs.data.some((s) => ['active', 'trialing'].includes(s.status))) {
      return res.status(200).json({ subscribed: true });
    }

    const baseUrl = getBaseUrl();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_DAYS },
      success_url: `${baseUrl}/auth/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/auth/cancel.html`,
      metadata: { email },
    });

    return res.status(200).json({ needsPayment: true, checkoutUrl: session.url });
  } catch (err) {
    console.error('Auth error:', err);
    const isAuthError = /expired|invalid|token/i.test(err.message || '');
    return res.status(isAuthError ? 401 : 500).json({ error: err.message || 'Auth failed' });
  }
});

// Explicit privacy policy (required for Chrome Web Store)
app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'website', 'privacy.html'));
});

// Static files (website + auth success/cancel)
app.use(express.static(path.join(__dirname, 'website')));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`LoopMail server running on ${HOST}:${PORT}`);
  console.log(`Base URL: ${getBaseUrl()}`);
});
