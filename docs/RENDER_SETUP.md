# Deploy LoopMail to Render

**Use a Blueprint** (easiest): **New** → **Blueprint** → connect repo. Render will use `render.yaml` automatically.

**Or manually:** **New** → **Web Service** (not Static Site—that won't run the API).

## Configure

| Field | Value |
|-------|-------|
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Branch** | main |

## Verify

After deploy:
- `https://your-app.onrender.com/api/health` should return `{"ok":true}`. If you get 404, the service type is wrong—it must be a Web Service.
- `https://your-app.onrender.com/api/debug` shows whether Stripe keys are configured (no secrets exposed). Use this to quickly verify `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` are set.

## 4. Environment Variables

Under **Environment**, add:

| Key | Value |
|-----|-------|
| `STRIPE_SECRET_KEY` | Your Stripe secret key (`sk_...`) |
| `STRIPE_PRICE_ID` | `price_1SyOgOBVF97kjNl3GfThEEzf` |
| `STRIPE_WEBHOOK_SECRET` | (Optional) For webhooks |

## 5. Deploy

Click **Create Web Service**. Render will build and deploy. Your API will be at:

```
https://your-service-name.onrender.com
```

## 6. Update the Extension

1. Open `lib/config.js`
2. Set your Render URL:
   ```js
   var LOOPMAIL_API_BASE = 'https://your-service-name.onrender.com/api';
   ```
3. In `manifest.json`, add to `host_permissions`:
   ```json
   "https://your-service-name.onrender.com/*"
   ```

## 7. Stripe Webhook (Optional)

1. In Stripe Dashboard → Webhooks → Add endpoint
2. **URL:** `https://your-service-name.onrender.com/api/webhook`
3. **Events:** `checkout.session.completed`, `customer.subscription.*`
4. Copy the signing secret → add as `STRIPE_WEBHOOK_SECRET` in Render

## 8. Free Tier Note

Render free tier spins down after 15 minutes of inactivity. The first request after idle may take 30–60 seconds. Upgrade to a paid plan for always-on.
