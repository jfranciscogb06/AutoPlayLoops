# LoopMail

A Chrome extension that plays audio loops from your Gmail inbox. Perfect for music producers who receive loops via email and want to quickly preview them without opening each message.

## Features

- **10-second previews** – Plays the first 10 seconds of each audio file, then auto-advances
- **Inbox only** – Fetches audio attachments from your inbox (spam excluded)
- **Keyboard shortcuts** – Alt+Left (previous), Alt+Right (next)
- **Liked list** – Save loops you like for later
- **Background playback** – Audio keeps playing when you close the popup

## Supported formats

MP3, WAV, AIFF, FLAC, OGG, WebM

## Setup

### 1. Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select existing)
3. Enable **Gmail API**: APIs & Services → Library → search "Gmail API" → Enable
4. Create OAuth credentials:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Chrome extension**
   - Name: LoopMail (or any name)
   - You'll need the extension ID in the next step

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the folder containing this project
5. Copy the **Extension ID** (e.g. `abcdefghijklmnopqrstuvwxyz123456`)

### 3. Add extension ID to OAuth client

1. Back in Google Cloud Console → Credentials → your OAuth client
2. Under "Application type: Chrome extension", add your Extension ID
3. Save

### 4. Update manifest.json

1. Open `manifest.json`
2. Replace `YOUR_CLIENT_ID` in the `oauth2.client_id` field with your OAuth client ID (from the credentials page, e.g. `123456789-abc.apps.googleusercontent.com`)

### 5. Reload the extension

In `chrome://extensions`, click the reload icon on LoopMail.

### 6. Backend (Stripe + auth)

The extension requires a backend for auth and subscription. Only Google sign-in is supported.

1. **Create a Stripe account** and product:
   - See [docs/STRIPE_SETUP.md](docs/STRIPE_SETUP.md) for a step-by-step Stripe integration guide
   - Create a subscription product at $4.99/month
   - Copy the Price ID (`price_...`)

3. **Deploy** (Vercel or Render):
   - Connect this repo to Vercel
   - **Vercel:** Connect repo, add env vars, deploy
   - **Render:** See [docs/RENDER_SETUP.md](docs/RENDER_SETUP.md) for step-by-step
   - Your API will be at `https://your-app.onrender.com/api` (Render) or `https://your-project.vercel.app/api` (Vercel)

4. **Update the extension**:
   - Set `LOOPMAIL_API_BASE` in `lib/config.js` to your API URL
   - Add your API host to `host_permissions` in `manifest.json`

5. **Stripe webhook** (optional): Add endpoint for `checkout.session.completed`, `customer.subscription.*`

## Usage

1. Click the LoopMail icon in the toolbar
2. Click **Sign in with Google** (first time only)
3. Wait for your inbox to load
4. Click **Play** to start
5. Use **Prev/Next** or Alt+Left/Alt+Right to navigate
6. Click the heart to add loops to your liked list

## Project structure

```
LoopMail/
├── manifest.json
├── popup/           # Popup UI
├── offscreen/       # Audio playback (persists when popup closes)
├── background/      # Service worker, Gmail API, state
├── lib/              # Gmail API helpers
└── icons/
```
