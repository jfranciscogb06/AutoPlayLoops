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
let globalState = {
  accessToken: null,
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
  const base = typeof LOOPMAIL_API_BASE !== 'undefined' ? LOOPMAIL_API_BASE : 'https://autoplayloops.onrender.com/api';
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
      return { subscribed: false, error: `API returned ${res.status} (not JSON). Is the server running?` };
    }
    if (data.subscribed) return { subscribed: true };
    if (data.needsPayment && data.checkoutUrl) return { needsPayment: true, checkoutUrl: data.checkoutUrl };
    const err = data.error || `API ${res.status}: ${text.slice(0, 60)}`;
    return { subscribed: false, error: err };
  } catch (e) {
    console.error('Subscription verify failed:', e);
    const msg = e.name === 'AbortError' ? 'Server took too long (free tier may be starting). Try again—second attempt is usually faster.' : (e.message || 'Network error');
    return { subscribed: false, error: msg };
  }
}

function getLoopKey(loop) {
  return `${loop.messageId}-${loop.attachmentId}`;
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

async function closeOffscreenDocument() {
  await chrome.offscreen.closeDocument();
}

async function sendToOffscreen(msg) {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')],
  });
  if (contexts.length === 0) return;
  const offscreen = contexts[0];
  // Offscreen documents don't have a tabId; we broadcast to all extension pages
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function loadPlayDuration() {
  const result = await chrome.storage.local.get('playDuration');
  globalState.playDurationSeconds = Math.min(120, Math.max(1, result.playDuration ?? 10));
}

const QUEUE_STATES_KEY = 'aplQueueStates';
const QUEUE_STATE_MAX_AGE_MS = 60 * 60 * 1000;

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

async function getSavedQueueState(searchQuery) {
  const result = await chrome.storage.local.get(QUEUE_STATES_KEY);
  const map = result[QUEUE_STATES_KEY] || {};
  const key = searchQuery || '__inbox__';
  const saved = map[key];
  if (!saved || !saved.queue || saved.queue.length === 0) return null;
  if (Date.now() - (saved.savedAt || 0) > QUEUE_STATE_MAX_AGE_MS) return null;
  return saved;
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
    hasToken: !!globalState.accessToken && globalState.subscriptionActive,
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

async function loadQueue(tabId, searchQuery = '') {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
  if (progressBroadcastInterval) {
    clearInterval(progressBroadcastInterval);
    progressBroadcastInterval = null;
  }
  if (activeTabId === tabId) {
    activeTabId = null;
  }
  const state = getTabState(tabId);

  globalState.currentSearchQuery = searchQuery || '';
  const saved = await getSavedQueueState(searchQuery);
  if (saved) {
    state.queue = saved.queue;
    state.currentIndex = 0;
    state.shuffleOn = false;
    state.originalQueue = null;
    state.isPlaying = false;
    state.isPaused = false;
    globalState.pausedElapsedSeconds = null;
    prefetchPreload(tabId);
    broadcastState();
    return;
  }

  state.queue = [];
  state.currentIndex = -1;
  state.isPlaying = false;
  state.isPaused = false;
  state.shuffleOn = false;
  state.originalQueue = null;
  globalState.pausedElapsedSeconds = null;
  preloadCache.clear();
  broadcastState();

  globalState.accessToken = await getAccessToken();
  if (!globalState.accessToken) {
    broadcastState();
    return;
  }

  const seenKeys = new Set();
  try {
    await buildAudioQueueStreaming(
      globalState.accessToken,
      searchQuery,
      (attachments) => {
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
      },
      500
    );
    saveQueueState(searchQuery, state);
  } catch (e) {
    console.error('Failed to load queue:', e);
  }
  broadcastState();
}

function getCacheKey(loop) {
  return `${loop.messageId}-${loop.attachmentId}`;
}

function prefetchPreload(tabId) {
  const state = getTabState(tabId);
  if (!globalState.accessToken || !state.queue.length) return;
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
          globalState.accessToken,
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
  const data = await getAttachmentData(
    globalState.accessToken,
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
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PLAY_FROM',
      payload: { base64, mimeType, durationMs, startOffsetMs: elapsedMs },
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
  state.currentIndex = Math.min(state.currentIndex + 1, state.queue.length - 1);
  state.isPaused = false;
  saveQueueState(globalState.currentSearchQuery, state);
  broadcastState();
  if (activeTabId === tabId && (state.isPlaying || state.isPaused)) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    await playCurrent(tabId);
  }
}

async function goPrev(tabId) {
  const state = getTabState(tabId);
  if (state.queue.length === 0) return;
  state.currentIndex = Math.max(state.currentIndex - 1, 0);
  state.isPaused = false;
  saveQueueState(globalState.currentSearchQuery, state);
  broadcastState();
  if (activeTabId === tabId && (state.isPlaying || state.isPaused)) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    await playCurrent(tabId);
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
    tabIdPromise.then((tabId) => sendResponse(getStatePayload(tabId)));
    return true;
  }

  if (msg.type === 'SIGN_OUT') {
    const tokenToRemove = globalState.accessToken;
    globalState.accessToken = null;
    globalState.subscriptionActive = false;
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
    if (tokenToRemove) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${tokenToRemove}`, { method: 'POST' })
        .catch(() => {})
        .finally(() => {
          chrome.identity.removeCachedAuthToken({ token: tokenToRemove }, () => {
            sendResponse({ ok: true });
          });
        });
    } else {
      sendResponse({ ok: true });
    }
    return true;
  }

  if (msg.type === 'SIGN_IN') {
    (async () => {
      try {
        await chrome.identity.clearAllCachedAuthTokens();
      } catch (e) {
        // Ignore - may not exist in older Chrome
      }
      const token = await getAccessToken(true);
      if (!token) {
        sendResponse({ ok: false, error: 'Sign-in failed' });
        return;
      }
      globalState.accessToken = token;
      const sub = await verifySubscription(token);
      if (sub.subscribed) {
        globalState.subscriptionActive = true;
        const tabId = await tabIdPromise;
        if (tabId) loadQueue(tabId);
        broadcastState();
        sendResponse({ ok: true });
      } else if (sub.needsPayment) {
        sendResponse({ ok: false, needsPayment: true, checkoutUrl: sub.checkoutUrl });
      } else {
        sendResponse({ ok: false, error: sub.error || 'Subscription check failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'SIGN_IN_COMPLETE') {
    globalState.accessToken = msg.token;
    globalState.subscriptionActive = true;
    getTabIdFromSender(sender).then((tabId) => {
      if (tabId) loadQueue(tabId);
      broadcastState();
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OPEN_AUTH_TAB') {
    chrome.tabs.create({ url: chrome.runtime.getURL('auth/auth.html') });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'REFRESH_SUBSCRIPTION') {
    (async () => {
      const token = globalState.accessToken;
      if (!token) {
        sendResponse({ ok: true });
        return;
      }
      const sub = await verifySubscription(token);
      if (sub.subscribed) {
        globalState.subscriptionActive = true;
        const tabId = await tabIdPromise;
        if (tabId) loadQueue(tabId);
        broadcastState();
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'LOAD_QUEUE') {
    const searchQuery = msg.searchQuery || '';
    tabIdPromise.then((tabId) => {
      if (tabId) loadQueue(tabId, searchQuery).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
      else sendResponse({ error: 'No Gmail tab' });
    });
    return true;
  }

  if (msg.type === 'SHUFFLE') {
    tabIdPromise.then((tabId) => {
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
      const state = tabId ? getTabState(tabId) : null;
      const loop = state?.queue?.[state.currentIndex];
      if (!loop || !globalState.accessToken) {
        sendResponse({ error: 'No loop to download' });
        return;
      }
      try {
        const { base64, mimeType } = await getAttachmentData(
          globalState.accessToken,
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
    tabIdPromise.then((tabId) => {
      if (!tabId) {
        sendResponse({ error: 'No Gmail tab' });
        return;
      }
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
    tabIdPromise.then((tabId) => {
      if (tabId) {
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
    tabIdPromise.then((tabId) => {
      if (tabId) goNext(tabId).then(() => sendResponse({ ok: true }));
      else sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'PREV') {
    tabIdPromise.then((tabId) => {
      if (tabId) goPrev(tabId).then(() => sendResponse({ ok: true }));
      else sendResponse({ ok: true });
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

chrome.identity.onSignInChanged.addListener((account, signedIn) => {
  if (!signedIn) {
    globalState.accessToken = null;
    globalState.subscriptionActive = false;
    tabStateMap.clear();
    activeTabId = null;
    broadcastState();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStateMap.delete(tabId);
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

loadPlayDuration().then(() => {
  getAccessToken().then(async (token) => {
    globalState.accessToken = token;
    if (token) {
      const sub = await verifySubscription(token);
      globalState.subscriptionActive = !!sub.subscribed;
    }
    broadcastState();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.playDuration) {
    loadPlayDuration().then(broadcastState);
  }
});
