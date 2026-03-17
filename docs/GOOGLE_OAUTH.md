# Google OAuth Setup (Account Picker)

LoopMail uses `launchWebAuthFlow` with `prompt=select_account` so users can choose which Google account to use. The Chrome Extension OAuth client type does not allow adding redirect URIs, so you need a **Web Application** client.

## Step 1: Create a Web Application OAuth Client

1. Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=autoplayloops)
2. Click **+ Create credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `LoopMail Web` (or any name)
5. Under **Authorized redirect URIs**, click **+ ADD URI** and add:
   ```
   https://omeocjleanlhooinejpgmcjceodcifcg.chromiumapp.org/
   ```
   (Replace `omeocjleanlhooinejpgmcjceodcifcg` with your extension ID from `chrome://extensions`)
6. Click **Create**
7. Copy the **Client ID** (looks like `123456789-xxxx.apps.googleusercontent.com`)

## Step 2: Add Client ID to Extension

1. Open `lib/config.js`
2. Set `LOOPMAIL_WEB_OAUTH_CLIENT_ID` to your new Web client ID:
   ```js
   var LOOPMAIL_WEB_OAUTH_CLIENT_ID = 'YOUR-WEB-CLIENT-ID.apps.googleusercontent.com';
   ```
3. Reload the extension
