# Stripe Integration Guide

LoopMail uses Stripe for subscriptions ($4.99/month with a 7-day free trial). The integration is already wired up in the code—you just need to configure Stripe and add your keys.

## 1. Create a Stripe Account

1. Go to [dashboard.stripe.com](https://dashboard.stripe.com) and sign up (or sign in).
2. Use **Test mode** (toggle in the dashboard) while developing.

## 2. Create a Subscription Product

1. In Stripe Dashboard, go to **Products** → **Add product**.
2. Set:
   - **Name:** LoopMail Pro (or similar)
   - **Pricing:** Recurring
   - **Price:** $4.99 / month
   - **Currency:** USD (or your choice)
3. Click **Save product**.
4. Copy the **Price ID** (starts with `price_`) — you’ll need this for `STRIPE_PRICE_ID`.

## 3. Get Your API Keys

1. In Stripe Dashboard, open **Developers** → **API keys**.
2. Copy:
   - **Secret key** (starts with `sk_test_` in test mode) → `STRIPE_SECRET_KEY`

## 4. Set Environment Variables

If you deploy to Vercel:

1. Open your project → **Settings** → **Environment Variables**.
2. Add:

| Variable | Value | Notes |
|----------|-------|--------|
| `STRIPE_SECRET_KEY` | `sk_test_...` | From Stripe API keys |
| `STRIPE_PRICE_ID` | `price_...` | From your product’s Price ID |

For local development, create a `.env.local` (or `.env`) in the project root with the same variables.

## 5. Deploy the Backend

1. Deploy this project to Vercel (or your hosting provider).
2. Ensure your API base URL is reachable (e.g. `https://your-project.vercel.app/api`).
3. Update `lib/config.js` in the extension with your API URL:

```js
var LOOPMAIL_API_BASE = 'https://your-project.vercel.app/api';
```

4. Add your API host to `host_permissions` in `manifest.json` if it’s not already there:

```json
"https://your-project.vercel.app/*"
```

## 6. Configure Success & Cancel URLs

The auth API builds:

- **Success URL:** `https://your-domain.vercel.app/auth/success.html`
- **Cancel URL:** `https://your-domain.vercel.app/auth/cancel.html`

These live in `website/auth/`. If you use a different base URL, set `BASE_URL` in your environment variables.

## 7. Stripe Webhook (Optional)

Useful for handling subscription lifecycle (e.g. cancelled, past_due):

1. In Stripe Dashboard, go to **Developers** → **Webhooks** → **Add endpoint**.
2. **Endpoint URL:** `https://your-project.vercel.app/api/webhook`
3. **Events to listen for:**
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the **Signing secret** (starts with `whsec_`) → add as `STRIPE_WEBHOOK_SECRET` in your env.

## 8. Test the Flow

1. Load the extension in Chrome.
2. Click **Sign in** (or Sign in with Google).
3. When you’re not subscribed, you should be redirected to Stripe Checkout.
4. Use Stripe test card: `4242 4242 4242 4242`, any future expiry, any CVC.

## Going Live

1. Switch Stripe Dashboard to **Live mode**.
2. Create the product and price again in Live mode.
3. Replace `sk_test_...` and `price_...` with your live keys.
4. Update the webhook endpoint to use live mode if you use it.
5. Redeploy your app with the new env vars.
