/**
 * LoopMail - Manage accounts page
 * Shows connected accounts, disconnect, reset cache, sign-in
 */

const API_BASE = typeof LOOPMAIL_API_BASE !== 'undefined' ? LOOPMAIL_API_BASE : 'https://getloopmail.com/api';

const signedOutView = document.getElementById('signedOutView');
const signedInView = document.getElementById('signedInView');
const loopmailEmail = document.getElementById('loopmailEmail');
const gmailEmail = document.getElementById('gmailEmail');

function showView(signedIn) {
  signedOutView.classList.toggle('hidden', signedIn);
  signedInView.classList.toggle('hidden', !signedIn);
}

async function getState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve);
  });
}

async function loadSignedInView() {
  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_USER_EMAIL' }, resolve);
  });
  loopmailEmail.textContent = res?.loopmailEmail || '—';
  const hasGmail = !!res?.gmailEmail;
  gmailEmail.textContent = res?.gmailEmail || 'Not connected';
  document.getElementById('switchGmailBtn').textContent = hasGmail ? 'Switch' : 'Connect';
}

// Returns a list of Chrome accounts, or [] if unavailable.
// chrome.identity.getAccounts is only available on Chrome OS; on other
// platforms the function doesn't exist, so we fall back to [].
function getAccounts() {
  if (typeof chrome.identity.getAccounts !== 'function') {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    chrome.identity.getAccounts((accounts) => {
      if (chrome.runtime.lastError) { resolve([]); return; }
      resolve(accounts || []);
    });
  });
}

// Gets an auth token for `account` (or interactively if no account given).
function getTokenForAccount(account) {
  return new Promise((resolve) => {
    const opts = account
      ? { account, interactive: true }
      : { interactive: true };
    chrome.identity.getAuthToken(opts, (token) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(token || null);
    });
  });
}

// Shows an inline account-picker if multiple Chrome accounts are available,
// otherwise returns the single account (or null for interactive fallback).
function showAccountPicker(accounts, container) {
  return new Promise((resolve) => {
    if (accounts.length <= 1) { resolve(accounts[0] || null); return; }
    container.innerHTML = '';
    const label = document.createElement('p');
    label.style.cssText = 'margin:0 0 8px;font-size:13px;color:var(--text-muted)';
    label.textContent = 'Choose an account:';
    container.appendChild(label);
    accounts.forEach((acct) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary btn-block';
      btn.style.marginTop = '6px';
      btn.textContent = acct.email || acct.id;
      btn.addEventListener('click', () => {
        container.innerHTML = '';
        resolve(acct);
      });
      container.appendChild(btn);
    });
  });
}

async function getToken(pickerContainer) {
  const accounts = await getAccounts();
  // Remove stale tokens so the selected account gets a fresh grant.
  await new Promise((resolve) => chrome.identity.clearAllCachedAuthTokens(resolve));
  const account = await showAccountPicker(accounts, pickerContainer || document.createElement('div'));
  return getTokenForAccount(account);
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `API returned ${res.status}`);
    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Server took too long. Click the button to try again.');
    throw e;
  }
}

async function doConnectGmail() {
  const status = document.getElementById('switchStatus');
  status.textContent = 'Choose an account below or waiting for sign-in...';
  status.className = 'status signing-in';
  status.style.display = 'block';
  const picker = document.getElementById('accountPickerContainerSwitch');
  const token = await getToken(picker);
  status.style.display = 'none';
  if (token) {
    chrome.runtime.sendMessage({ type: 'SET_GMAIL_TOKEN', token });
    await loadSignedInView();
  }
}

document.getElementById('disconnectLoopmailBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT_LOOPMAIL' }, () => {
    showView(false);
  });
});

document.getElementById('disconnectGmailBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT_GMAIL' }, () => {
    loadSignedInView();
  });
});

document.getElementById('switchGmailBtn').addEventListener('click', () => {
  doConnectGmail();
});

document.getElementById('resetCacheBtn').addEventListener('click', async () => {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLEAR_CACHE_AND_RELOAD' }, resolve);
  });
});

document.getElementById('switchAccountBtn').addEventListener('click', () => {
  doConnectGmail();
});

document.getElementById('signInBtn').addEventListener('click', async () => {
  const btn = document.getElementById('signInBtn');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.textContent = 'Opening Google sign-in...';
  status.className = 'status signing-in';

  let token;
  try {
    token = await getToken(document.getElementById('accountPickerContainerSignIn'));
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
      status.textContent = 'Success!';
      status.className = 'status success';
      await loadSignedInView();
      showView(true);
      btn.disabled = false;
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

(async () => {
  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_USER_EMAIL' }, resolve);
  });
  const hasSubscription = !!res?.loopmailEmail;
  if (hasSubscription) {
    await loadSignedInView();
    showView(true);
  } else {
    showView(false);
  }
})();
