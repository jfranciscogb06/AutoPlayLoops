/**
 * LoopMail - Background Service Worker
 * Handles Gmail API, auth, queue, and offscreen audio coordination
 */

importScripts('../lib/config.js', '../lib/gmail.js');

const PRELOAD_COUNT = 5;
let progressBroadcastInterval = null;

const preloadCache = new Map();
let activeTabId = null;

function getTabState(tabId) {
  if (!tabStateMap.has(tabId)) {
    tabStateMap.set(tabId, {
      queue: [],
      currentIndex: -1,
      isPlaying: false,
      isPaused: false,
      shuffleOn: false,
      originalQueue: null,
    });
  }
  return tabStateMap.get(tabId);
}

const tabStateMap = new Map();
let loadQueueGeneration = 0;
const STORAGE_LOOPMAIL_TOKEN = 'loopmail_access_token';
const STORAGE_LOOPMAIL_EMAIL = 'loopmail_email';
const STORAGE_GMAIL_TOKEN = 'gmail_access_token';

function isLoopmailToken(token) {
  return typeof token === 'string' && token.startsWith('lm.');
}
let globalState = {
  accessToken: null,
  gmailAccessToken: null,
  subscriptionActive: false,
  playbackStartTime: null,
  pausedElapsedSeconds: null,
  playDurationSeconds: 10,
  currentSearchQuery: '',
};

async function getAccessToken(interactive = false) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(token);
      }
    });
  });
}

async function verifySubscription(token) {
  const base = typeof LOOPMAIL_API_BASE !== 'undefined' ? LOOPMAIL_API_BASE : 'https://getloopmail.com/api';
  const url = `${base}/auth`;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, type: 'google' }),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { subscribed: false, error: `API returned ${res.status} (not JSON). Is the server running?`, transient: true };
    }
    if (data.subscribed) return { subscribed: true };
    if (data.needsPayment && data.checkoutUrl) return { needsPayment: true, checkoutUrl: data.checkoutUrl };
    const err = data.error || `API ${res.status}: ${text.slice(0, 60)}`;
    return { subscribed: false, error: err };
  } catch (e) {
    console.error('Subscription verify failed:', e);
    const msg = e.name === 'AbortError' ? 'Server took too long (free tier may be starting). Try again—second attempt is usually faster.' : (e.message || 'Network error');
    return { subscribed: false, error: msg, transient: true };
  }
}

/** Verifies subscription; on expired/invalid, tries token refresh once before giving up. Returns sub + refreshedToken if refreshed. */
async function verifyWithRetry(token) {
  let sub = await verifySubscription(token);
  if (sub.subscribed || sub.needsPayment || sub.transient) return sub;
  // LoopMail JWTs can't be silently refreshed — user must sign in again.
  if (isLoopmailToken(token)) return sub;
  const isAuthError = sub.error && (sub.error.includes('expired') || sub.error.includes('Invalid') || /invalid.*token|token.*invalid/i.test(sub.error));
  if (!isAuthError) return sub;
  const fresh = await getAccessToken(false);
  if (fresh && fresh !== token) {
    const retrySub = await verifySubscription(fresh);
    if (retrySub.subscribed) return { ...retrySub, refreshedToken: fresh };
  }
  return sub;
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')],
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Play audio loops from Gmail',
  });
}

async function loadPlayDuration() {
  const result = await chrome.storage.local.get('playDuration');
  globalState.playDurationSeconds = Math.min(120, Math.max(1, result.playDuration ?? 10));
}

const QUEUE_STATES_KEY = 'aplQueueStates';
const QUEUE_STATE_MAX_AGE_MS = 60 * 60 * 1000;
const TAB_STATE_PREFIX = 'apl_tab_';
const TAB_STATE_MAX_AGE_MS = 60 * 60 * 1000;

function saveTabStateToStorage(tabId) {
  const state = tabStateMap.get(tabId);
  if (!state || !state.queue || state.queue.length === 0) return;
  const key = TAB_STATE_PREFIX + tabId;
  const data = {
    queue: state.queue,
    currentIndex: Math.max(0, Math.min(state.currentIndex, state.queue.length - 1)),
    shuffleOn: state.shuffleOn || false,
    originalQueue: state.originalQueue ? state.originalQueue.slice(0, 500) : null,
    savedAt: Date.now(),
  };
  chrome.storage.local.set({ [key]: data }).catch(() => {});
}

async function restoreTabStateFromStorage(tabId) {
  if (tabStateMap.has(tabId)) return;
  const key = TAB_STATE_PREFIX + tabId;
  const result = await chrome.storage.local.get(key);
  const data = result[key];
  if (!data || !data.queue || data.queue.length === 0) return;
  if (Date.now() - (data.savedAt || 0) > TAB_STATE_MAX_AGE_MS) return;
  const state = {
    queue: data.queue,
    currentIndex: Math.max(0, Math.min(data.currentIndex, data.queue.length - 1)),
    isPlaying: false,
    isPaused: false,
    shuffleOn: !!data.shuffleOn,
    originalQueue: data.originalQueue || null,
  };
  tabStateMap.set(tabId, state);
}

function saveQueueState(searchQuery, state) {
  if (!state || state.queue.length === 0) return;
  const key = searchQuery || '__inbox__';
  const entry = {
    queue: state.queue,
    currentIndex: Math.max(0, Math.min(state.currentIndex, state.queue.length - 1)),
    shuffleOn: state.shuffleOn || false,
    originalQueue: state.originalQueue || null,
    savedAt: Date.now(),
  };
  chrome.storage.local.get(QUEUE_STATES_KEY).then((result) => {
    const map = result[QUEUE_STATES_KEY] || {};
    map[key] = entry;
    chrome.storage.local.set({ [QUEUE_STATES_KEY]: map }).catch(() => {});
  }).catch(() => {});
}

function getStatePayload(tabId) {
  const state = tabId ? getTabState(tabId) : null;
  const currentLoop = state?.queue?.[state.currentIndex] || null;
  const isActiveTab = tabId === activeTabId;
  let elapsedSeconds = 0;
  if (isActiveTab && state?.isPaused && globalState.pausedElapsedSeconds != null) {
    elapsedSeconds = globalState.pausedElapsedSeconds;
  } else if (isActiveTab && state?.isPlaying && globalState.playbackStartTime) {
    elapsedSeconds = Math.min(globalState.playDurationSeconds, (Date.now() - globalState.playbackStartTime) / 1000);
  }
  return {
    queue: state?.queue ?? [],
    currentIndex: state?.currentIndex ?? -1,
    isPlaying: isActiveTab && state?.isPlaying,
    isPaused: isActiveTab && state?.isPaused,
    currentLoop,
    elapsedSeconds,
    playDuration: globalState.playDurationSeconds,
    shuffleOn: state?.shuffleOn ?? false,
    hasToken: !!globalState.accessToken && !!globalState.gmailAccessToken && globalState.subscriptionActive,
  };
}

function broadcastState() {
  chrome.tabs.query({ url: '*://mail.google.com/*' }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        const payload = getStatePayload(tab.id);
        chrome.tabs.sendMessage(tab.id, { type: 'STATE_UPDATE', payload }).catch(() => {});
      }
    });
  });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', payload: getStatePayload(activeTabId) }).catch(() => {});
}

async function loadQueue(tabId, searchQuery = '', visibleThreadIds = null, visibleMessageIds = null) {
  const gen = ++loadQueueGeneration;
  // Only interrupt playback when reloading the tab that is currently playing.
  // Loading a queue for a different Gmail tab should not stop ongoing audio.
  if (activeTabId === tabId) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    if (progressBroadcastInterval) {
      clearInterval(progressBroadcastInterval);
      progressBroadcastInterval = null;
    }
    activeTabId = null;
  }
  const state = getTabState(tabId);

  globalState.currentSearchQuery = searchQuery || '';
  chrome.storage.local.remove(TAB_STATE_PREFIX + tabId).catch(() => {});
  state.queue = [];
  state.currentIndex = -1;
  state.isPlaying = false;
  state.isPaused = false;
  state.shuffleOn = false;
  state.originalQueue = null;
  globalState.pausedElapsedSeconds = null;
  preloadCache.clear();
  broadcastState();

  const gmailToken = globalState.gmailAccessToken;
  if (!gmailToken) {
    broadcastState();
    return;
  }

  const seenKeys = new Set();
  const pushAttachments = (attachments) => {
    if (gen !== loadQueueGeneration) return;
    const toAdd = attachments.filter((a) => {
      const key = `${a.messageId}-${a.attachmentId}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
    if (toAdd.length === 0) return;
    state.queue.push(...toAdd);
    if (state.currentIndex < 0 && state.queue.length > 0) {
      state.currentIndex = 0;
      prefetchPreload(tabId);
    }
    broadcastState();
    saveTabStateToStorage(tabId);
  };

  try {
    if (visibleThreadIds && visibleThreadIds.length > 0) {
      await buildAudioQueueFromThreadIds(gmailToken, visibleThreadIds, pushAttachments);
    } else if (visibleMessageIds && visibleMessageIds.length > 0) {
      await buildAudioQueueFromMessageIds(gmailToken, visibleMessageIds, pushAttachments);
    } else {
      await buildAudioQueueStreaming(gmailToken, searchQuery, pushAttachments, 0);
    }
  } catch (e) {
    if (gen === loadQueueGeneration) console.error('Failed to load queue:', e);
  }
  if (gen === loadQueueGeneration) {
    broadcastState();
    saveTabStateToStorage(tabId);
  }
}

function getCacheKey(loop) {
  return `${loop.messageId}-${loop.attachmentId}`;
}

function prefetchPreload(tabId) {
  const state = getTabState(tabId);
  const gmailToken = globalState.gmailAccessToken;
  if (!gmailToken || !state.queue.length) return;
  const start = state.currentIndex;
  const end = Math.min(start + PRELOAD_COUNT, state.queue.length);
  const toFetch = [];
  for (let i = start; i < end; i++) {
    const loop = state.queue[i];
    const key = getCacheKey(loop);
    if (preloadCache.has(key)) continue;
    toFetch.push(loop);
  }
  Promise.all(
    toFetch.map(async (loop) => {
      try {
        const data = await getAttachmentData(
          gmailToken,
          loop.messageId,
          loop.attachmentId,
          loop.mimeType || 'audio/mpeg'
        );
        preloadCache.set(getCacheKey(loop), data);
      } catch (e) {
        console.warn('Preload failed for', loop.filename, e);
      }
    })
  );
}

async function getCachedOrFetch(loop) {
  const key = getCacheKey(loop);
  const cached = preloadCache.get(key);
  if (cached) {
    preloadCache.delete(key);
    return cached;
  }
  const gmailToken = globalState.gmailAccessToken;
  if (!gmailToken) throw new Error('Gmail not connected');
  const data = await getAttachmentData(
    gmailToken,
    loop.messageId,
    loop.attachmentId,
    loop.mimeType || 'audio/mpeg'
  );
  return data;
}

async function playCurrent(tabId) {
  const state = getTabState(tabId);
  if (state.currentIndex < 0 || state.currentIndex >= state.queue.length) {
    state.isPlaying = false;
    broadcastState();
    return;
  }

  activeTabId = tabId;
  const loop = state.queue[state.currentIndex];
  state.isPlaying = true;
  globalState.playbackStartTime = Date.now();
  broadcastState();

  progressBroadcastInterval = setInterval(broadcastState, 1000);

  try {
    await loadPlayDuration();
    await ensureOffscreenDocument();
    await new Promise((r) => setTimeout(r, 150));
    const { base64, mimeType } = await getCachedOrFetch(loop);
    const loopName = loop.filename || loop.subject || 'Unknown';

    const durationMs = globalState.playDurationSeconds * 1000;
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PLAY',
      payload: { base64, mimeType, loopName, durationMs },
    }).catch(() => {});

    prefetchPreload(tabId);
    broadcastState();
  } catch (e) {
    console.error('Failed to play:', e);
    state.isPlaying = false;
    globalState.playbackStartTime = null;
    if (progressBroadcastInterval) {
      clearInterval(progressBroadcastInterval);
      progressBroadcastInterval = null;
    }
    broadcastState();
  }
}

async function pausePlayback(tabId) {
  const state = getTabState(tabId);
  if (!state.isPlaying || activeTabId !== tabId) return;
  const elapsedSeconds = globalState.playbackStartTime
    ? Math.min(globalState.playDurationSeconds, (Date.now() - globalState.playbackStartTime) / 1000)
    : 0;
  globalState.pausedElapsedSeconds = elapsedSeconds;
  globalState.playbackStartTime = null;
  state.isPlaying = false;
  state.isPaused = true;
  if (progressBroadcastInterval) {
    clearInterval(progressBroadcastInterval);
    progressBroadcastInterval = null;
  }
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_PAUSE' }).catch(() => {});
  broadcastState();
}

async function resumePlayback(tabId) {
  const state = getTabState(tabId);
  if (!state.isPaused) return;
  const loop = state.queue[state.currentIndex];
  if (!loop) return;
  const elapsedMs = (globalState.pausedElapsedSeconds ?? 0) * 1000;
  globalState.pausedElapsedSeconds = null;
  globalState.playbackStartTime = Date.now() - elapsedMs;
  activeTabId = tabId;
  state.isPlaying = true;
  state.isPaused = false;
  progressBroadcastInterval = setInterval(broadcastState, 1000);
  broadcastState();

  try {
    await ensureOffscreenDocument();
    const { base64, mimeType } = await getCachedOrFetch(loop);
    const durationMs = globalState.playDurationSeconds * 1000;
    const loopName = loop.filename || loop.subject || 'Unknown';
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PLAY_FROM',
      payload: { base64, mimeType, durationMs, startOffsetMs: elapsedMs, loopName },
    }).catch(() => {});
  } catch (e) {
    console.error('Resume failed:', e);
    state.isPlaying = false;
    state.isPaused = true;
    globalState.pausedElapsedSeconds = elapsedMs / 1000;
    if (progressBroadcastInterval) {
      clearInterval(progressBroadcastInterval);
      progressBroadcastInterval = null;
    }
    broadcastState();
  }
}

async function stopPlayback(tabId) {
  const state = getTabState(tabId);
  state.isPlaying = false;
  state.isPaused = false;
  if (activeTabId === tabId) {
    globalState.playbackStartTime = null;
    globalState.pausedElapsedSeconds = null;
    if (progressBroadcastInterval) {
      clearInterval(progressBroadcastInterval);
      progressBroadcastInterval = null;
    }
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
  }
  broadcastState();
}

async function goNext(tabId) {
  const state = getTabState(tabId);
  if (state.queue.length === 0) return;
  if (progressBroadcastInterval) {
    clearInterval(progressBroadcastInterval);
    progressBroadcastInterval = null;
  }
  globalState.playbackStartTime = null;
  state.currentIndex = Math.min(state.currentIndex + 1, state.queue.length - 1);
  state.isPaused = false;
  saveQueueState(globalState.currentSearchQuery, state);
  saveTabStateToStorage(tabId);
  broadcastState();
  if (activeTabId === tabId && (state.isPlaying || state.isPaused)) {
    await playCurrent(tabId);
  }
}

async function goPrev(tabId) {
  const state = getTabState(tabId);
  if (state.queue.length === 0) return;
  if (progressBroadcastInterval) {
    clearInterval(progressBroadcastInterval);
    progressBroadcastInterval = null;
  }
  globalState.playbackStartTime = null;
  state.currentIndex = Math.max(state.currentIndex - 1, 0);
  state.isPaused = false;
  saveQueueState(globalState.currentSearchQuery, state);
  saveTabStateToStorage(tabId);
  broadcastState();
  if (activeTabId === tabId && (state.isPlaying || state.isPaused)) {
    await playCurrent(tabId);
  }
}

function performSignOut(onDone, { keepGmail = false } = {}) {
  const tokenToRemove = globalState.accessToken;
  const gmailTokenToKeep = keepGmail ? globalState.gmailAccessToken : null;
  globalState.accessToken = null;
  globalState.subscriptionActive = false;
  chrome.storage.local.remove(STORAGE_LOOPMAIL_TOKEN);
  chrome.storage.local.remove(STORAGE_LOOPMAIL_EMAIL);
  if (!keepGmail) {
    globalState.gmailAccessToken = null;
    chrome.storage.local.remove(STORAGE_GMAIL_TOKEN);
  } else if (gmailTokenToKeep === tokenToRemove) {
    // Shared token between subscription and Gmail — the revoke below would kill both.
    // Drop the Gmail token too since it's about to be invalidated.
    globalState.gmailAccessToken = null;
    chrome.storage.local.remove(STORAGE_GMAIL_TOKEN);
  }
  tabStateMap.clear();
  activeTabId = null;
  preloadCache.clear();
  globalState.playbackStartTime = null;
  if (progressBroadcastInterval) {
    clearInterval(progressBroadcastInterval);
    progressBroadcastInterval = null;
  }
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
  broadcastState();
  if (tokenToRemove && !isLoopmailToken(tokenToRemove)) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${tokenToRemove}`, { method: 'POST' })
      .catch(() => {})
      .finally(() => {
        chrome.identity.removeCachedAuthToken({ token: tokenToRemove }, onDone);
      });
  } else {
    onDone();
  }
}

async function getTabIdFromSender(sender) {
  if (sender?.tab?.id) return sender.tab.id;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: '*://mail.google.com/*' });
  return tab?.id ?? null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabIdPromise = getTabIdFromSender(sender);

  if (msg.type === 'GET_STATE') {
    tabIdPromise.then(async (tabId) => {
      await restoreTabStateFromStorage(tabId);
      sendResponse(getStatePayload(tabId));
    });
    return true;
  }

  if (msg.type === 'GET_USER_EMAIL') {
    (async () => {
      const loopmailToken = globalState.accessToken;
      const gmailToken = globalState.gmailAccessToken;
      let loopmailEmail = null;
      let gmailEmail = null;
      try {
        if (loopmailToken) {
          if (isLoopmailToken(loopmailToken)) {
            const stored = await chrome.storage.local.get([STORAGE_LOOPMAIL_EMAIL]);
            loopmailEmail = stored[STORAGE_LOOPMAIL_EMAIL] || null;
            if (!loopmailEmail) {
              // Fall back to decoding the JWT payload (base64url).
              try {
                const payload = loopmailToken.slice(3).split('.')[1];
                const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
                loopmailEmail = json.email || null;
              } catch (_) {}
            }
          } else {
            const r1 = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(loopmailToken)}`);
            const d1 = await r1.json();
            loopmailEmail = d1.email || null;
          }
        }
        if (gmailToken) {
          const r2 = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(gmailToken)}`);
          const d2 = await r2.json();
          gmailEmail = d2.email || null;
        }
      } catch (_) {}
      sendResponse({ loopmailEmail, gmailEmail });
    })();
    return true;
  }

  if (msg.type === 'CLEAR_CACHE_AND_RELOAD') {
    (async () => {
      preloadCache.clear();
      await chrome.storage.local.remove(QUEUE_STATES_KEY);
      tabStateMap.forEach((state) => {
        state.queue = [];
        state.currentIndex = -1;
        state.isPlaying = false;
        state.isPaused = false;
        state.shuffleOn = false;
        state.originalQueue = null;
      });
      globalState.pausedElapsedSeconds = null;
      activeTabId = null;
      if (progressBroadcastInterval) {
        clearInterval(progressBroadcastInterval);
        progressBroadcastInterval = null;
      }
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
      const [gmailTab] = await chrome.tabs.query({ url: '*://mail.google.com/*', active: true, currentWindow: true });
      const tabId = gmailTab?.id ?? (await chrome.tabs.query({ url: '*://mail.google.com/*' }))[0]?.id;
      if (tabId) loadQueue(tabId);
      broadcastState();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'DISCONNECT_GMAIL') {
    const tokenToRevoke = globalState.gmailAccessToken;
    globalState.gmailAccessToken = null;
    chrome.storage.local.remove(STORAGE_GMAIL_TOKEN);
    tabStateMap.forEach((s) => {
      s.queue = [];
      s.currentIndex = -1;
      s.isPlaying = false;
      s.isPaused = false;
      s.originalQueue = null;
    });
    preloadCache.clear();
    activeTabId = null;
    broadcastState();
    // Revoke + evict from Chrome's cache so getAuthToken shows the picker on reconnect.
    if (tokenToRevoke) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${tokenToRevoke}`, { method: 'POST' }).catch(() => {});
      chrome.identity.removeCachedAuthToken({ token: tokenToRevoke }, () => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: true });
    }
    return true;
  }

  if (msg.type === 'SIGN_OUT') {
    performSignOut(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'DISCONNECT_LOOPMAIL') {
    // Disconnect only the subscription — keep the separately-connected Gmail token
    // so the user doesn't have to reconnect it after signing back in.
    performSignOut(() => sendResponse({ ok: true }), { keepGmail: true });
    return true;
  }

  if (msg.type === 'SET_GMAIL_TOKEN') {
    globalState.gmailAccessToken = msg.token;
    chrome.storage.local.set({ [STORAGE_GMAIL_TOKEN]: msg.token });
    getTabIdFromSender(sender).then((tabId) => {
      if (tabId) loadQueue(tabId);
      broadcastState();
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SIGN_IN_COMPLETE') {
    // Only set subscription token — Gmail access is a separate explicit step.
    globalState.accessToken = msg.token;
    globalState.subscriptionActive = true;
    const storageUpdate = { [STORAGE_LOOPMAIL_TOKEN]: msg.token };
    if (msg.email) storageUpdate[STORAGE_LOOPMAIL_EMAIL] = msg.email;
    chrome.storage.local.set(storageUpdate);
    chrome.tabs.query({ url: '*://mail.google.com/*' }, (tabs) => {
      const gmailTab = tabs.find((t) => t.active) || tabs[0];
      if (gmailTab?.id) loadQueue(gmailTab.id);
      broadcastState();
      tabs.forEach((tab) => {
        if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'SHOW_REFRESH_PROMPT' }).catch(() => {});
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OPEN_AUTH_TAB') {
    chrome.windows.create({ url: chrome.runtime.getURL('manage/manage.html'), type: 'popup', width: 560, height: 680, focused: true });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OPEN_BILLING_PORTAL') {
    (async () => {
      const token = globalState.accessToken;
      if (!token) { sendResponse({ error: 'Not signed in.' }); return; }
      try {
        const base = typeof LOOPMAIL_API_BASE !== 'undefined' ? LOOPMAIL_API_BASE : 'https://getloopmail.com/api';
        const res = await fetch(`${base}/billing-portal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.url) {
          sendResponse({ error: data.error || `Failed (${res.status})` });
          return;
        }
        sendResponse({ url: data.url });
      } catch (e) {
        sendResponse({ error: e.message || 'Network error' });
      }
    })();
    return true;
  }

  if (msg.type === 'REFRESH_SUBSCRIPTION') {
    (async () => {
      // Use the stored subscription token directly — don't replace with getAccessToken(false),
      // which always returns the current Chrome profile account and may differ from the
      // subscription account, causing account mixing.
      const token = globalState.accessToken;
      if (!token) {
        sendResponse({ ok: true });
        return;
      }
      const sub = await verifyWithRetry(token);
      if (sub.refreshedToken) {
        globalState.accessToken = sub.refreshedToken;
        // Never overwrite a separately-connected Gmail token.
        chrome.storage.local.set({ [STORAGE_LOOPMAIL_TOKEN]: sub.refreshedToken }).catch(() => {});
      } else {
        globalState.accessToken = token;
        // Never overwrite a separately-connected Gmail token.
        chrome.storage.local.set({ [STORAGE_LOOPMAIL_TOKEN]: token }).catch(() => {});
      }
      if (sub.subscribed) {
        globalState.subscriptionActive = true;
      } else if (!sub.transient) {
        // Only flip subscriptionActive off for clear auth failures (expired/invalid token
        // or explicit subscription lapse). Generic backend errors keep the current state
        // to avoid false sign-outs from Render cold starts or transient API issues.
        const isAuthFailure = sub.error && /expired|invalid.*token|token.*invalid|unauthorized|not.*subscribed|no.*subscription/i.test(sub.error);
        if (isAuthFailure) {
          globalState.subscriptionActive = false;
        }
        /* Never clear stored tokens on verify failure - only on explicit sign-out. */
      }
      broadcastState();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'CLEAR_TAB_FOR_RELOAD') {
    tabIdPromise.then((tabId) => {
      if (tabId) {
        const state = getTabState(tabId);
        state.queue = [];
        state.currentIndex = -1;
        state.isPlaying = false;
        state.isPaused = false;
        state.shuffleOn = false;
        state.originalQueue = null;
        if (activeTabId === tabId) {
          activeTabId = null;
          globalState.playbackStartTime = null;
          globalState.pausedElapsedSeconds = null;
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
        }
        broadcastState();
      }
      sendResponse({ ok: true });
    });
    return true;
  }


  if (msg.type === 'LOAD_QUEUE') {
    const searchQuery = msg.searchQuery || '';
    const visibleThreadIds = msg.visibleThreadIds || null;
    const visibleMessageIds = msg.visibleMessageIds || null;
    tabIdPromise.then((tabId) => {
      if (tabId) loadQueue(tabId, searchQuery, visibleThreadIds, visibleMessageIds).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
      else sendResponse({ error: 'No Gmail tab' });
    });
    return true;
  }

  if (msg.type === 'SHUFFLE') {
    tabIdPromise.then(async (tabId) => {
      if (tabId) await restoreTabStateFromStorage(tabId);
      const state = tabId ? getTabState(tabId) : null;
      if (!state || state.queue.length === 0) {
        sendResponse({ ok: true });
        return;
      }
      if (state.shuffleOn) {
        state.shuffleOn = false;
        if (state.originalQueue) {
          const currentLoop = state.queue[state.currentIndex];
          state.queue = [...state.originalQueue];
          state.originalQueue = null;
          const idx = state.queue.findIndex(
            (l) => l.messageId === currentLoop?.messageId && l.attachmentId === currentLoop?.attachmentId
          );
          state.currentIndex = idx >= 0 ? idx : 0;
        }
      } else {
        state.originalQueue = [...state.queue];
        const idx = state.currentIndex;
        const before = state.queue.slice(0, idx + 1);
        const after = state.queue.slice(idx + 1);
        for (let i = after.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [after[i], after[j]] = [after[j], after[i]];
        }
        state.queue = [...before, ...after];
        state.shuffleOn = true;
      }
      saveQueueState(globalState.currentSearchQuery, state);
      broadcastState();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    tabIdPromise.then(async (tabId) => {
      if (tabId) await restoreTabStateFromStorage(tabId);
      const state = tabId ? getTabState(tabId) : null;
      const loop = state?.queue?.[state.currentIndex];
      const gmailToken = globalState.gmailAccessToken;
      if (!loop || !gmailToken) {
        sendResponse({ error: 'No loop to download' });
        return;
      }
      try {
        const { base64, mimeType } = await getAttachmentData(
          gmailToken,
          loop.messageId,
          loop.attachmentId,
          loop.mimeType || 'audio/mpeg'
        );
        const ext = (loop.filename || '').split('.').pop() || (mimeType?.includes('wav') ? 'wav' : 'mp3');
        const filename = loop.filename || `${loop.subject || 'loop'}.${ext}`.replace(/[^\w.\-]/g, '_');
        const mime = mimeType || 'audio/mpeg';
        const b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
        const dataUrl = `data:${mime};base64,${b64}`;
        chrome.downloads.download({
          url: dataUrl,
          filename,
          saveAs: true,
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }

  if (msg.type === 'PLAY') {
    tabIdPromise.then(async (tabId) => {
      if (!tabId) {
        sendResponse({ error: 'No Gmail tab' });
        return;
      }
      await restoreTabStateFromStorage(tabId);
      const state = getTabState(tabId);
      if (state.isPaused) {
        resumePlayback(tabId);
        sendResponse({ ok: true });
      } else {
        playCurrent(tabId).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
      }
    });
    return true;
  }

  if (msg.type === 'STOP') {
    tabIdPromise.then(async (tabId) => {
      if (tabId) {
        await restoreTabStateFromStorage(tabId);
        const state = getTabState(tabId);
        if (state.isPaused) {
          stopPlayback(tabId);
        } else {
          pausePlayback(tabId);
        }
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'NEXT') {
    tabIdPromise.then(async (tabId) => {
      if (tabId) {
        await restoreTabStateFromStorage(tabId);
        goNext(tabId).then(() => sendResponse({ ok: true }));
      } else sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'PREV') {
    tabIdPromise.then(async (tabId) => {
      if (tabId) {
        await restoreTabStateFromStorage(tabId);
        goPrev(tabId).then(() => sendResponse({ ok: true }));
      } else sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'AUDIO_NEXT') {
    if (progressBroadcastInterval) {
      clearInterval(progressBroadcastInterval);
      progressBroadcastInterval = null;
    }
    if (activeTabId) goNext(activeTabId).then(() => sendResponse({ ok: true }));
    else sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'AUDIO_PREV') {
    if (activeTabId) goPrev(activeTabId).then(() => sendResponse({ ok: true }));
    else sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'AUDIO_PAUSE') {
    if (activeTabId) {
      restoreTabStateFromStorage(activeTabId).then(() => {
        pausePlayback(activeTabId);
        sendResponse({ ok: true });
      });
    } else sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'AUDIO_RESUME') {
    if (activeTabId) {
      restoreTabStateFromStorage(activeTabId).then(() => {
        resumePlayback(activeTabId);
        sendResponse({ ok: true });
      });
    } else sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: '*://mail.google.com/*' });
  const tabId = tab?.id ?? activeTabId;
  if (command === 'prev-loop' && tabId) goPrev(tabId);
  if (command === 'next-loop' && tabId) goNext(tabId);
  if (command === 'toggle-play-pause' && tabId) {
    const state = getTabState(tabId);
    if (state.isPaused) resumePlayback(tabId);
    else if (state.isPlaying) pausePlayback(tabId);
  }
});

chrome.identity.onSignInChanged.addListener(async (account, signedIn) => {
  if (!signedIn) {
    // This only applies to Google-signed-in users. Email/password users aren't
    // affected by Chrome's identity state changes.
    if (isLoopmailToken(globalState.accessToken)) return;
    // onSignInChanged fires spuriously during Chrome token refresh cycles.
    // Try a silent re-auth before treating this as a real sign-out.
    const freshToken = await getAccessToken(false);
    if (freshToken) {
      // Chrome recovered a valid token — just update subscription token and carry on.
      // Never overwrite a separately-connected Gmail token.
      globalState.accessToken = freshToken;
      broadcastState();
      return;
    }
    // Genuinely signed out of Chrome — clear session.
    globalState.accessToken = null;
    globalState.gmailAccessToken = null;
    globalState.subscriptionActive = false;
    tabStateMap.clear();
    activeTabId = null;
    broadcastState();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStateMap.delete(tabId);
  chrome.storage.local.remove(TAB_STATE_PREFIX + tabId).catch(() => {});
  if (activeTabId === tabId) {
    activeTabId = null;
    globalState.playbackStartTime = null;
    if (progressBroadcastInterval) {
      clearInterval(progressBroadcastInterval);
      progressBroadcastInterval = null;
    }
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    broadcastState();
  }
});

loadPlayDuration().then(async () => {
  const stored = await chrome.storage.local.get([STORAGE_LOOPMAIL_TOKEN, STORAGE_GMAIL_TOKEN]);
  const storedLoopmail = stored[STORAGE_LOOPMAIL_TOKEN];
  const storedGmail = stored[STORAGE_GMAIL_TOKEN];

  // Optimistically restore the stored subscription token immediately so GET_STATE calls
  // that arrive during the verification round-trip return hasToken=true.
  // Do NOT replace with getAccessToken(false) here — Chrome's identity always returns
  // the token for the current Chrome profile account, which may differ from the account
  // the user subscribed with, causing account mixing and false sign-outs.
  if (storedLoopmail) {
    globalState.accessToken = storedLoopmail;
    globalState.subscriptionActive = true;
    broadcastState();
  }
  // Gmail token is stored separately and only set via the explicit "Give Gmail access" flow.
  if (storedGmail) {
    globalState.gmailAccessToken = storedGmail;
  }

  let loopmailToken = storedLoopmail;
  if (loopmailToken) {
    const sub = await verifyWithRetry(loopmailToken);
    if (sub.refreshedToken) loopmailToken = sub.refreshedToken;
    if (sub.subscribed) {
      globalState.accessToken = loopmailToken;
      globalState.subscriptionActive = true;
      chrome.storage.local.set({ [STORAGE_LOOPMAIL_TOKEN]: loopmailToken }).catch(() => {});
    } else if (sub.needsPayment) {
      // Subscription explicitly lapsed — clear active flag but keep token for re-subscribe flow.
      globalState.subscriptionActive = false;
      globalState.accessToken = loopmailToken;
    } else {
      // Everything else (token errors, network failures, Chrome account mismatches) —
      // keep the user logged in optimistically. Never clear on verify failure at startup,
      // only on explicit sign-out. Matches the REFRESH_SUBSCRIPTION handler behaviour.
      globalState.accessToken = loopmailToken;
    }
  }
  broadcastState();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.playDuration) {
    loadPlayDuration().then(broadcastState);
  }
});

chrome.runtime.onMessageExternal.addListener((msg, sender) => {
  if (msg.type === 'BILLING_RETURN' && sender.tab?.id) {
    chrome.tabs.remove(sender.tab.id);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url?.startsWith('https://getloopmail.com/auth/billing-return')) {
    setTimeout(() => chrome.tabs.remove(tabId), 2000);
  }
});

chrome.runtime.onMessageExternal.addListener((msg, sender) => {
  if (msg.type === 'BILLING_RETURN' && sender.tab?.id) {
    chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL('manage/manage.html') });
  }
});
