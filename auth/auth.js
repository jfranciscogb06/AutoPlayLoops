/**
 * LoopMail - Auth page
 * Uses launchWebAuthFlow with prompt=select_account so user can choose which Google account to use
 */

const API_BASE = typeof LOOPMAIL_API_BASE !== 'undefined' ? LOOPMAIL_API_BASE : 'https://autoplayloops.onrender.com/api';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function getToken() {
  const clientId = typeof LOOPMAIL_WEB_OAUTH_CLIENT_ID !== 'undefined' && LOOPMAIL_WEB_OAUTH_CLIENT_ID
    ? LOOPMAIL_WEB_OAUTH_CLIENT_ID
    : chrome.runtime.getManifest().oauth2?.client_id;
  if (!clientId) return Promise.resolve(null);

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = [
    'https://accounts.google.com/o/oauth2/v2/auth',
    `?client_id=${encodeURIComponent(clientId)}`,
    `&redirect_uri=${encodeURIComponent(redirectUri)}`,
    '&response_type=token',
    `&scope=${encodeURIComponent(SCOPES)}`,
    '&prompt=select_account',
  ].join('');

  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      if (!redirectUrl) {
        resolve(null);
        return;
      }
      const hash = redirectUrl.split('#')[1];
      if (!hash) {
        resolve(null);
        return;
      }
      const params = new URLSearchParams(hash);
      if (params.get('error')) {
        resolve(null);
        return;
      }
      const token = params.get('access_token');
      resolve(token || null);
    });
  });
}

async function checkSubscription(token) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 35000);
  try {
    const res = await fetch(`${API_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, type: 'google' }),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new Error(res.status === 404 ? 'API not found. Check that Render is a Web Service.' : 'Invalid response from server.');
    }
    if (!res.ok) {
      throw new Error(data.error || `API returned ${res.status}`);
    }
    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Server took too long (Render may be cold). Click the button to try again.');
    throw e;
  }
}

document.getElementById('signInBtn').addEventListener('click', async () => {
  const btn = document.getElementById('signInBtn');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.textContent = 'Opening Google sign-in...';
  status.className = 'status signing-in';

  let token;
  try {
    token = await getToken();
  } catch (e) {
    status.textContent = e.message || 'Sign-in failed';
    status.className = 'status error';
    btn.disabled = false;
    return;
  }

  if (!token) {
    status.textContent = 'Sign-in cancelled or failed. Make sure popups are not blocked.';
    status.className = 'status error';
    btn.disabled = false;
    return;
  }

  status.textContent = 'Checking subscription...';

  try {
    const data = await checkSubscription(token);
    if (data.subscribed) {
      chrome.runtime.sendMessage({ type: 'SIGN_IN_COMPLETE', token }).catch(() => {});
      status.textContent = 'Success! You can close this tab and return to Gmail.';
      status.className = 'status success';
    } else if (data.needsPayment && data.checkoutUrl) {
      window.location.replace(data.checkoutUrl);
    } else {
      status.textContent = data.error || 'Something went wrong.';
      status.className = 'status error';
      btn.disabled = false;
    }
  } catch (e) {
    status.textContent = e.message || 'Connection failed. Click the button to try again.';
    status.className = 'status error';
    btn.disabled = false;
  }
});
