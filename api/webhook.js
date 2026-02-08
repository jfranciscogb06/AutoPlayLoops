/**
 * LoopMail - Stripe webhook handler
 * POST /api/webhook
 * Handles checkout.session.completed and customer.subscription.* events
 */

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-11-20.acacia' });
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = req.rawBody || await getRawBody(req);
    const sig = req.headers['stripe-signature'];
    if (!sig || !webhookSecret) {
      return res.status(400).json({ error: 'Missing signature or webhook secret' });
    }

    stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(400).json({ error: err.message || 'Webhook failed' });
  }

  return res.status(200).json({ received: true });
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
