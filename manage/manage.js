/**
 * LoopMail - Manage accounts page
 * Three views: step1 (subscription sign-in) → step2 (Gmail access) → manage (full)
 */

const API_BASE = typeof LOOPMAIL_API_BASE !== 'undefined' ? LOOPMAIL_API_BASE : 'https://getloopmail.com/api';

const step1View = document.getElementById('step1View');
const step2View = document.getElementById('step2View');
const manageView = document.getElementById('manageView');

function showView(name) {
  step1View.classList.toggle('hidden', name !== 'step1');
  step2View.classList.toggle('hidden', name !== 'step2');
  manageView.classList.toggle('hidden', name !== 'manage');
}

async function getState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve);
  });
}

async function getEmails() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_USER_EMAIL' }, resolve);
  });
}

// Route to the correct view based on current auth state.
async function routeView() {
  const res = await getEmails();
  const hasSubscription = !!res?.loopmailEmail;
  const hasGmail = !!res?.gmailEmail;
  if (!hasSubscription) {
    showView('step1');
    return;
  }
  if (!hasGmail) {
    document.getElementById('step2LoopmailEmail').textContent = res.loopmailEmail;
    showView('step2');
    return;
  }
  document.getElementById('loopmailEmail').textContent = res.loopmailEmail;
  document.getElementById('gmailEmail').textContent = res.gmailEmail;
  showView('manage');
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    if (!token) { resolve(); return; }
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

async function getToken({ tokenToReplace } = {}) {
  if (tokenToReplace) {
    await removeCachedToken(tokenToReplace);
  } else {
    await new Promise((resolve) => chrome.identity.clearAllCachedAuthTokens(resolve));
  }
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `API returned ${res.status}`);
    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Server took too long. Click the button to try again.');
    throw e;
  }
}

async function emailAuth(kind, email, password) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 35000);
  try {
    const res = await fetch(`${API_BASE}/auth/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
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

async function getGmailTokenWithPicker() {
  // Clear all cached tokens first so Chrome is forced to show the account picker
  // rather than silently reusing a cached token.
  await new Promise((resolve) => chrome.identity.clearAllCachedAuthTokens(resolve));
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: true }, (t) => {
      resolve(chrome.runtime.lastError ? null : t || null);
    });
  });
}

async function doConnectGmail(statusEl) {
  if (statusEl) {
    statusEl.textContent = 'Opening Google account picker...';
    statusEl.className = 'status signing-in';
    statusEl.style.display = 'block';
  }
  const token = await getGmailTokenWithPicker();
  if (statusEl) statusEl.style.display = 'none';
  if (token) {
    chrome.runtime.sendMessage({ type: 'SET_GMAIL_TOKEN', token });
    await routeView();
  }
}

// --- Step 1: tabs (sign in / sign up) ---
let authMode = 'signin';
const tabSignIn = document.getElementById('tabSignIn');
const tabSignUp = document.getElementById('tabSignUp');
const emailSubmitBtn = document.getElementById('emailSubmitBtn');
const passwordInput = document.getElementById('passwordInput');
const step1Title = document.getElementById('step1Title');
const step1Sub = document.getElementById('step1Sub');

function setAuthMode(mode) {
  authMode = mode;
  tabSignIn.classList.toggle('active', mode === 'signin');
  tabSignUp.classList.toggle('active', mode === 'signup');
  if (mode === 'signin') {
    step1Title.textContent = 'Sign in to your subscription';
    step1Sub.textContent = 'Welcome back. Sign in with the email tied to your LoopMail subscription.';
    emailSubmitBtn.textContent = 'Sign in';
    passwordInput.autocomplete = 'current-password';
  } else {
    step1Title.textContent = 'Create your account';
    step1Sub.textContent = 'Start your free week. Card required after the trial.';
    emailSubmitBtn.textContent = 'Create account';
    passwordInput.autocomplete = 'new-password';
  }
}
tabSignIn.addEventListener('click', () => setAuthMode('signin'));
tabSignUp.addEventListener('click', () => setAuthMode('signup'));

document.getElementById('showPassword').addEventListener('change', (e) => {
  passwordInput.type = e.target.checked ? 'text' : 'password';
});

// --- Step 1: email/password submission ---
document.getElementById('emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('emailInput').value.trim();
  const password = passwordInput.value;
  const status = document.getElementById('status');
  emailSubmitBtn.disabled = true;
  status.textContent = authMode === 'signin' ? 'Signing in...' : 'Creating account...';
  status.className = 'status signing-in';
  try {
    const data = await emailAuth(authMode, email, password);
    if (data.subscribed && data.token) {
      chrome.runtime.sendMessage({ type: 'SIGN_IN_COMPLETE', token: data.token, email }).catch(() => {});
      status.textContent = '';
      emailSubmitBtn.disabled = false;
      await routeView();
    } else if (data.needsPayment && data.checkoutUrl) {
      window.location.replace(data.checkoutUrl);
    } else {
      status.textContent = data.error || 'Something went wrong.';
      status.className = 'status error';
      emailSubmitBtn.disabled = false;
    }
  } catch (err) {
    status.textContent = err.message || 'Connection failed.';
    status.className = 'status error';
    emailSubmitBtn.disabled = false;
  }
});

// --- Step 1: Forgot password flow ---
const forgotView = document.getElementById('forgotView');
const emailForm = document.getElementById('emailForm');

document.getElementById('forgotBtn').addEventListener('click', () => {
  emailForm.classList.add('hidden');
  document.querySelector('.tabs').classList.add('hidden');
  forgotView.classList.remove('hidden');
  document.getElementById('step1Title').textContent = 'Reset your password';
  document.getElementById('step1Sub').textContent = '';
});

document.getElementById('forgotBackBtn').addEventListener('click', () => {
  emailForm.classList.remove('hidden');
  document.querySelector('.tabs').classList.remove('hidden');
  forgotView.classList.add('hidden');
  document.getElementById('forgotStep1').classList.remove('hidden');
  document.getElementById('forgotStep2').classList.add('hidden');
  setAuthMode(authMode);
});

document.getElementById('forgotSendBtn').addEventListener('click', async () => {
  const email = document.getElementById('forgotEmail').value.trim();
  const status = document.getElementById('forgotStatus');
  const btn = document.getElementById('forgotSendBtn');
  if (!email) { status.textContent = 'Enter your email.'; status.className = 'status error'; return; }
  btn.disabled = true;
  status.textContent = 'Sending code...';
  status.className = 'status signing-in';
  try {
    const res = await fetch(`${API_BASE}/auth/forgot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send code');
    document.getElementById('forgotEmailLabel').textContent = email;
    document.getElementById('forgotStep1').classList.add('hidden');
    document.getElementById('forgotStep2').classList.remove('hidden');
    status.textContent = '';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'status error';
  }
  btn.disabled = false;
});

document.getElementById('forgotResetBtn').addEventListener('click', async () => {
  const email = document.getElementById('forgotEmail').value.trim();
  const code = document.getElementById('forgotCode').value.trim();
  const password = document.getElementById('forgotNewPassword').value;
  const status = document.getElementById('forgotResetStatus');
  const btn = document.getElementById('forgotResetBtn');
  if (!code || code.length !== 6) { status.textContent = 'Enter the 6-digit code.'; status.className = 'status error'; return; }
  if (!password || password.length < 6) { status.textContent = 'Password must be at least 6 characters.'; status.className = 'status error'; return; }
  btn.disabled = true;
  status.textContent = 'Resetting...';
  status.className = 'status signing-in';
  try {
    const res = await fetch(`${API_BASE}/auth/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Reset failed');
    status.textContent = 'Password reset! Signing you in...';
    status.className = 'status success';
    if (data.token) {
      chrome.runtime.sendMessage({ type: 'SIGN_IN_COMPLETE', token: data.token, email }).catch(() => {});
      setTimeout(() => routeView(), 1000);
    }
  } catch (e) {
    status.textContent = e.message;
    status.className = 'status error';
  }
  btn.disabled = false;
});

// --- Step 1: Continue with Google (disabled until CASA Tier 2 verified) ---
// TODO: Re-enable once CASA verified — uncomment this block and the HTML button.
// const signInBtn = document.getElementById('signInBtn');
// if (signInBtn) signInBtn.addEventListener('click', async () => { ... });

// --- Step 2: grant Gmail access ---
document.getElementById('connectGmailBtn').addEventListener('click', () => {
  doConnectGmail(document.getElementById('step2Status'));
});

document.getElementById('step2SignOutBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT_LOOPMAIL' }, () => {
    routeView();
  });
});

// --- Manage view ---
document.getElementById('disconnectLoopmailBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT_LOOPMAIL' }, () => {
    routeView();
  });
});

document.getElementById('disconnectGmailBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT_GMAIL' }, () => {
    routeView();
  });
});

document.getElementById('switchGmailBtn').addEventListener('click', () => {
  doConnectGmail(document.getElementById('switchStatus'));
});

document.getElementById('manageSubscriptionBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening Stripe...';
  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'OPEN_BILLING_PORTAL' }, resolve);
  });
  btn.disabled = false;
  btn.textContent = originalText;
  if (res?.url) {
    window.open(res.url, '_blank', 'noopener');
  } else {
    alert(res?.error || 'Failed to open billing portal.');
  }
});

document.getElementById('continueToGmailBtn')?.addEventListener('click', () => {
  window.location.href = 'https://mail.google.com';
});

document.getElementById('resetCacheBtn').addEventListener('click', async () => {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLEAR_CACHE_AND_RELOAD' }, resolve);
  });
});

routeView();
