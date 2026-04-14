/**
 * LoopMail - Express server for Render deployment
 * Serves API routes and static website
 */

import express from 'express';
import Stripe from 'stripe';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2024-11-20.acacia' }) : null;

const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const TRIAL_DAYS = 7;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const JWT_SECRET = process.env.LOOPMAIL_JWT_SECRET || '';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// --- Password hashing (scrypt) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// --- JWT-ish tokens (HMAC-SHA256) ---
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signToken(email) {
  if (!JWT_SECRET) throw new Error('LOOPMAIL_JWT_SECRET is not set');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  }));
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `lm.${header}.${payload}.${sig}`;
}

function verifyLoopmailToken(token) {
  if (!JWT_SECRET) throw new Error('LOOPMAIL_JWT_SECRET is not set');
  if (!token || !token.startsWith('lm.')) return null;
  const parts = token.slice(3).split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data;
  try { data = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch { return null; }
  if (!data.email || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return { email: data.email };
}

function isLoopmailToken(token) {
  return typeof token === 'string' && token.startsWith('lm.');
}

// --- Shared subscription logic ---
async function findCustomerByEmail(email) {
  const list = await stripe.customers.list({ email, limit: 1 });
  return list.data[0] || null;
}

async function hasActiveSub(customerId) {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  return subs.data.some((s) => ['active', 'trialing'].includes(s.status));
}

async function createCheckoutSession(customerId, email) {
  const baseUrl = getBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    subscription_data: { trial_period_days: TRIAL_DAYS },
    success_url: `${baseUrl}/auth/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/auth/cancel.html`,
    metadata: { email },
  });
  return session.url;
}

function assertStripeReady(res) {
  if (!(process.env.STRIPE_SECRET_KEY || '').trim()) {
    res.status(503).json({ error: 'Server misconfigured: STRIPE_SECRET_KEY is not set.' });
    return false;
  }
  if (!(process.env.STRIPE_PRICE_ID || '').trim()) {
    res.status(503).json({ error: 'Server misconfigured: STRIPE_PRICE_ID is not set.' });
    return false;
  }
  if (!JWT_SECRET) {
    res.status(503).json({ error: 'Server misconfigured: LOOPMAIL_JWT_SECRET is not set.' });
    return false;
  }
  return true;
}

function isValidEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isValidPassword(s) { return typeof s === 'string' && s.length >= 6 && s.length <= 200; }

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

// POST /api/auth — verify subscription from a token (Google OAuth or LoopMail JWT)
app.post('/api/auth', async (req, res) => {
  try {
    if (!assertStripeReady(res)) return;

    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing token' });
    }

    let email;
    if (isLoopmailToken(token)) {
      const payload = verifyLoopmailToken(token);
      if (!payload) return res.status(401).json({ error: 'Token expired. Please sign in again.' });
      email = payload.email;
    } else {
      ({ email } = await verifyGoogleToken(token));
    }

    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    let customer = await findCustomerByEmail(email);
    if (!customer) customer = await stripe.customers.create({ email });

    if (await hasActiveSub(customer.id)) {
      return res.status(200).json({ subscribed: true });
    }

    const checkoutUrl = await createCheckoutSession(customer.id, email);
    return res.status(200).json({ needsPayment: true, checkoutUrl });
  } catch (err) {
    console.error('Auth error:', err);
    const isAuthError = /expired|invalid|token/i.test(err.message || '');
    return res.status(isAuthError ? 401 : 500).json({ error: err.message || 'Auth failed' });
  }
});

// POST /api/auth/signup — email + password
app.post('/api/auth/signup', async (req, res) => {
  try {
    if (!assertStripeReady(res)) return;
    const { email, password } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (!isValidPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const normalized = email.trim().toLowerCase();
    let customer = await findCustomerByEmail(normalized);
    if (customer && customer.metadata && customer.metadata.password_hash) {
      return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
    }

    const password_hash = hashPassword(password);
    if (customer) {
      customer = await stripe.customers.update(customer.id, {
        metadata: { ...(customer.metadata || {}), password_hash, auth_method: 'email' },
      });
    } else {
      customer = await stripe.customers.create({
        email: normalized,
        metadata: { password_hash, auth_method: 'email' },
      });
    }

    if (await hasActiveSub(customer.id)) {
      return res.status(200).json({ subscribed: true, token: signToken(normalized) });
    }
    const checkoutUrl = await createCheckoutSession(customer.id, normalized);
    return res.status(200).json({ needsPayment: true, checkoutUrl });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: err.message || 'Signup failed' });
  }
});

// POST /api/auth/signin — email + password
app.post('/api/auth/signin', async (req, res) => {
  try {
    if (!assertStripeReady(res)) return;
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const normalized = email.trim().toLowerCase();
    const customer = await findCustomerByEmail(normalized);
    const stored = customer && customer.metadata && customer.metadata.password_hash;
    if (!customer || !stored || !verifyPassword(password, stored)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (await hasActiveSub(customer.id)) {
      return res.status(200).json({ subscribed: true, token: signToken(normalized) });
    }
    const checkoutUrl = await createCheckoutSession(customer.id, normalized);
    return res.status(200).json({ needsPayment: true, checkoutUrl });
  } catch (err) {
    console.error('Signin error:', err);
    return res.status(500).json({ error: err.message || 'Signin failed' });
  }
});

// POST /api/billing-portal — returns a Stripe Customer Portal URL for the token's customer
app.post('/api/billing-portal', async (req, res) => {
  try {
    if (!assertStripeReady(res)) return;
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing token' });
    }

    let email;
    if (isLoopmailToken(token)) {
      const payload = verifyLoopmailToken(token);
      if (!payload) return res.status(401).json({ error: 'Token expired. Please sign in again.' });
      email = payload.email;
    } else {
      ({ email } = await verifyGoogleToken(token));
    }

    const customer = await findCustomerByEmail(email);
    if (!customer) return res.status(404).json({ error: 'No subscription found for this account.' });

    const portalConfig = (process.env.STRIPE_PORTAL_CONFIG_ID || '').trim();
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: getBaseUrl(),
      ...(portalConfig ? { configuration: portalConfig } : {}),
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Billing portal error:', err);
    return res.status(500).json({ error: err.message || 'Failed to open billing portal' });
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
