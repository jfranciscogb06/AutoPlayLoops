/**
 * LoopMail - Gmail-integrated player
 * Injects player tab and panel into Gmail UI
 */

let progressInterval = null;
let barProgressInterval = null;
let panelOpen = false;
const BAR_HIDDEN_KEY = 'aplBarHidden';

// Walk up from [role="search"] to find the nearest flex-container ancestor
// that has multiple visible children (the actual header row).
// Returns { row, searchChild } or null.
function parseRgb(str) {
  const m = str && str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
  const [r, g, b, a = 1] = parts;
  return { r, g, b, a };
}

function sampleSearchBarStyle(searchEl) {
  const input = document.querySelector('input[name="q"]')
    || searchEl.querySelector('input')
    || searchEl.querySelector('[contenteditable]');
  if (!input) return null;

  const inputStyle = window.getComputedStyle(input);

  // Find the pill: walk up from input looking for an element with a pill-shape
  // (large border-radius) AND a visible bg. That element is the visual container.
  let bg = null;
  let backdrop = null;
  let node = input;
  for (let i = 0; i < 12 && node && searchEl.contains(node); i++) {
    const cs = window.getComputedStyle(node);
    const br = parseFloat(cs.borderTopLeftRadius) || 0;
    const rgb = parseRgb(cs.backgroundColor);
    const hasPillBg = rgb && rgb.a > 0.05;
    if (br >= 12 && hasPillBg) {
      bg = cs.backgroundColor;
      const bd = cs.backdropFilter || cs.webkitBackdropFilter;
      if (bd && bd !== 'none') backdrop = bd;
      break;
    }
    node = node.parentElement;
  }
  // Fallback: input's own bg if no pill-shaped ancestor was found.
  if (!bg) {
    const rgb = parseRgb(inputStyle.backgroundColor);
    if (rgb && rgb.a > 0.05) bg = inputStyle.backgroundColor;
  }

  let isLight = false;
  const bgRgb = bg ? parseRgb(bg) : null;
  if (bgRgb) {
    const lum = (0.299 * bgRgb.r + 0.587 * bgRgb.g + 0.114 * bgRgb.b) / 255;
    isLight = lum > 0.6;
  }

  return {
    bg,
    backdrop,
    isLight,
    color: inputStyle.color,
    fontWeight: inputStyle.fontWeight,
  };
}

function applyThemeClass(el, isLight) {
  el.classList.toggle('apl-theme-light', isLight);
  el.classList.toggle('apl-theme-dark', !isLight);
}

function findHeaderInsertPoint() {
  const search = document.querySelector('[role="search"]');
  if (!search) return null;
  let el = search.parentElement;
  for (let i = 0; i < 10 && el && el !== document.body; i++) {
    const display = window.getComputedStyle(el).display;
    if (display === 'flex' || display === 'inline-flex') {
      const kids = Array.from(el.children).filter((c) => c.offsetWidth > 10);
      if (kids.length >= 2) {
        const sc = kids.find((k) => k === search || k.contains(search));
        if (sc) return { row: el, searchChild: sc };
      }
    }
    el = el.parentElement;
  }
  return null;
}

function createTab(panel) {
  const tab = document.createElement('div');
  tab.className = 'apl-root apl-tab';
  tab.innerHTML = `
    <div class="apl-bar-signed-out" id="aplBarSignedOut" style="display:flex">
      <button class="apl-bar-btn apl-bar-signin" id="aplBarSignIn">Sign in to LoopMail</button>
      <button class="apl-bar-btn apl-bar-hide" id="aplBarHideSignedOut" title="Hide bar">−</button>
    </div>
    <div class="apl-bar-signed-in" id="aplBarSignedIn" style="display:none">
      <button class="apl-bar-btn apl-bar-prev" id="aplBarPrev" title="Previous">◀</button>
      <button class="apl-bar-btn apl-bar-play" id="aplBarPlay" title="Play"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg></button>
      <button class="apl-bar-btn apl-bar-next" id="aplBarNext" title="Next">▶</button>
      <span class="apl-bar-label" id="aplBarLabel"><span class="apl-bar-label-inner">Loops</span></span>
      <button class="apl-bar-btn apl-bar-shuffle" id="aplBarShuffle" title="Shuffle"><svg class="apl-bar-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg></button>
      <button class="apl-bar-btn apl-bar-download" id="aplBarDownload" title="Download"><svg class="apl-bar-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
      <button class="apl-bar-btn apl-bar-hide" id="aplBarHide" title="Hide bar">−</button>
      <div class="apl-bar-progress"><div class="apl-bar-progress-fill" id="aplBarProgressFill"></div></div>
    </div>
  `;
  return tab;
}

function createPanel() {
  const p = document.createElement('div');
  p.className = 'apl-root apl-panel';
  p.style.display = 'none';
  p.innerHTML = `
    <div class="apl-panel-header">
      <span class="apl-panel-title">LoopMail</span>
      <button class="apl-panel-close" aria-label="Close">×</button>
    </div>
    <div class="apl-panel-body">
      <div class="apl-auth" id="aplAuth">
        <p>Sign in to start</p>
        <button class="apl-btn-signin" id="aplSignIn">Sign in</button>
        <p style="font-size:12px;color:#5f6368;margin-top:8px">Opens in a new tab</p>
      </div>
      <div class="apl-empty" id="aplEmpty" style="display:none">
        <p>No audio loops found in your inbox.</p>
      </div>
      <div class="apl-player" id="aplPlayer" style="display:none">
        <div class="apl-loop-name" id="aplLoopName">—</div>
        <div class="apl-progress-bar"><div class="apl-progress-fill" id="aplProgressFill"></div></div>
        <div class="apl-progress-text" id="aplProgressText">0 / 10s</div>
        <div class="apl-controls">
          <button class="apl-btn apl-btn-prev" id="aplPrev" title="Previous">◀</button>
          <button class="apl-btn apl-btn-play" id="aplPlay" title="Play">▶</button>
          <button class="apl-btn apl-btn-next" id="aplNext" title="Next">▶</button>
          <button class="apl-btn apl-btn-shuffle" id="aplShuffle" title="Shuffle">⇅</button>
        </div>
        <div class="apl-download-row">
          <button class="apl-btn apl-btn-download" id="aplDownload" title="Download">Download</button>
        </div>
        <div class="apl-signout-row" style="text-align:center;margin-top:8px">
          <a href="#" class="apl-settings-link" id="aplSettingsLink">Settings</a>
          <span style="margin:0 8px">·</span>
          <button class="apl-signout" id="aplSignOut">Sign out</button>
        </div>
        <div class="apl-queue-info" id="aplQueueInfo">Loop 0 of 0</div>
      </div>
    </div>
  `;

  p.querySelector('.apl-panel-close').addEventListener('click', closePanel);

  document.addEventListener('click', (e) => {
    if (panelOpen && p.contains && !p.contains(e.target) && !e.target.closest?.('#apl-container')) {
      closePanel();
    }
  });

  function closePanel() {
    panelOpen = false;
    p.style.display = 'none';
  }

  p.querySelector('#aplSignIn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_AUTH_TAB' });
  });

  p.querySelector('#aplPrev').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PREV' });
    setTimeout(() => getState().then(updatePanel), 100);
  });

  p.querySelector('#aplPlay').addEventListener('click', () => {
    getState().then((s) => {
      if (!s || s.queue.length === 0) return;
      chrome.runtime.sendMessage({ type: s.isPlaying ? 'STOP' : 'PLAY' });
      setTimeout(() => getState().then(updatePanel), 100);
    });
  });

  p.querySelector('#aplNext').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'NEXT' });
    setTimeout(() => getState().then(updatePanel), 100);
  });

  p.querySelector('#aplShuffle').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SHUFFLE' });
    setTimeout(() => getState().then(updatePanel), 100);
  });

  p.querySelector('#aplDownload').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD' });
  });

  p.querySelector('#aplSettingsLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  p.querySelector('#aplSignOut').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SIGN_OUT' });
    setTimeout(() => getState().then(updatePanel), 100);
  });

  return p;
}

function setProgress(seconds, duration = 10) {
  const fill = document.getElementById('aplProgressFill');
  const text = document.getElementById('aplProgressText');
  if (!fill || !text) return;
  const pct = Math.min(100, (seconds / duration) * 100);
  fill.style.width = pct + '%';
  text.textContent = `${Math.floor(seconds)} / ${duration}s`;
}

function updatePanel(state) {
  const auth = document.getElementById('aplAuth');
  const empty = document.getElementById('aplEmpty');
  const player = document.getElementById('aplPlayer');
  const tab = document.querySelector('.apl-tab');
  if (!auth || !empty || !player || !tab) return;

  if (!state || !state.hasToken) {
    auth.style.display = 'block';
    empty.style.display = 'none';
    player.style.display = 'none';
    return;
  }

  auth.style.display = 'none';

  if (state.queue.length === 0) {
    empty.style.display = 'block';
    player.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  player.style.display = 'block';

  const loopName = document.getElementById('aplLoopName');
  const queueInfo = document.getElementById('aplQueueInfo');
  const playBtn = document.getElementById('aplPlay');
  const shuffleBtn = document.getElementById('aplShuffle');

  if (loopName) loopName.textContent = state.currentLoop?.filename || state.currentLoop?.subject || '—';
  if (queueInfo) queueInfo.textContent = `Loop ${state.currentIndex + 1} of ${state.queue.length}`;
  if (playBtn) {
    playBtn.innerHTML = state.isPlaying
  ? '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
  : '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>';
    playBtn.classList.toggle('playing', state.isPlaying);
  }
  if (shuffleBtn) shuffleBtn.classList.toggle('active', state.shuffleOn);

  const duration = state.playDuration ?? 10;
  if (state.isPlaying) {
    setProgress(state.elapsedSeconds || 0, duration);
    if (progressInterval) clearInterval(progressInterval);
    let elapsed = Math.floor(state.elapsedSeconds || 0);
    progressInterval = setInterval(() => {
      elapsed++;
      setProgress(elapsed, duration);
      if (elapsed >= duration) clearInterval(progressInterval);
    }, 1000);
  } else {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = null;
    setProgress(state.isPaused ? (state.elapsedSeconds || 0) : 0, duration);
  }
}

function getState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve);
  });
}

function findHelpButton() {
  const selectors = [
    '[aria-label*="Help"]',
    '[aria-label*="help"]',
    '[data-tooltip*="Help"]',
    '[data-tooltip*="help"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.offsetParent !== null) return el;
  }
  return null;
}

function shortenSearchBar() {
  const style = document.createElement('style');
  style.id = 'apl-search-bar-style';
  style.textContent = `
    [role="search"] { max-width: 260px !important; }
    [role="search"] input { max-width: 100% !important; }
    input[aria-label*="Search"], input[placeholder*="Search"] { max-width: 260px !important; }
  `;
  if (!document.getElementById('apl-search-bar-style')) {
    document.head.appendChild(style);
  }
}

function inject() {
  if (document.getElementById('apl-container')) return;
  // Don't commit until Gmail's search bar is present — otherwise we'd
  // incorrectly fall back to the bottom bar on a timing race.
  if (!document.querySelector('[role="search"]')) return;

  const container = document.createElement('div');
  container.id = 'apl-container';

  const panel = createPanel();
  const tab = createTab(panel);

  const showBtn = document.createElement('button');
  showBtn.id = 'apl-show-btn';
  showBtn.className = 'apl-show-btn';
  showBtn.title = 'Show LoopMail bar';
  showBtn.textContent = 'LM';
  showBtn.style.display = 'none';

  container.appendChild(tab);
  document.body.appendChild(panel);
  document.body.appendChild(showBtn);


  function applySearchTheme(searchChild) {
    const sampled = sampleSearchBarStyle(searchChild);
    if (!sampled) return;
    if (sampled.bg) {
      tab.style.setProperty('--apl-tab-bg', sampled.bg);
      showBtn.style.setProperty('--apl-tab-bg', sampled.bg);
    }
    if (sampled.color) {
      tab.style.setProperty('--apl-tab-ink', sampled.color);
      showBtn.style.setProperty('--apl-tab-ink', sampled.color);
    }
    if (sampled.fontWeight) {
      tab.style.setProperty('--apl-tab-weight', sampled.fontWeight);
    }
    if (sampled.backdrop) {
      tab.style.setProperty('backdrop-filter', sampled.backdrop);
      tab.style.setProperty('-webkit-backdrop-filter', sampled.backdrop);
      showBtn.style.setProperty('backdrop-filter', sampled.backdrop);
      showBtn.style.setProperty('-webkit-backdrop-filter', sampled.backdrop);
    }
    applyThemeClass(tab, sampled.isLight);
    applyThemeClass(showBtn, sampled.isLight);
  }

  function applyPosition() {
    const pt = findHeaderInsertPoint();
    if (!pt) return; // not ready yet — retry loop will try again
    try {
      container.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'flex-shrink:0',
        'min-width:0',
        'width:380px',
        'box-sizing:border-box',
        'margin:0 4px',
      ].join(';');
      pt.row.insertBefore(container, pt.searchChild.nextSibling || null);
      showBtn.style.cssText = 'display:none;flex-shrink:0;margin:0 2px;';
      pt.row.insertBefore(showBtn, container);
      applySearchTheme(pt.searchChild);
      // Gmail themes load async — re-sample after DOM settles.
      setTimeout(() => applySearchTheme(pt.searchChild), 800);
      setTimeout(() => applySearchTheme(pt.searchChild), 2500);
    } catch (e) {
      // injection failed — container not placed, retry loop will try again
    }
  }

  function setBarVisible(visible) {
    container.style.display = visible ? 'inline-flex' : 'none';
    showBtn.style.display = visible ? 'none' : 'block';
    if (!visible) {
      panelOpen = false;
      panel.style.display = 'none';
    }
  }

  chrome.storage.local.get(BAR_HIDDEN_KEY, (result) => {
    const hidden = !!result[BAR_HIDDEN_KEY];
    setBarVisible(!hidden);
  });

  applyPosition();

  chrome.runtime.sendMessage({ type: 'CLEAR_TAB_FOR_RELOAD' }, () => {
    getState().then((s) => {
      updateBar(tab, s);
      if (panelOpen) updatePanel(s);
      if (s?.hasToken && !searchPollInterval) {
        refreshQueueWithSearch();
        startSearchPolling();
      }
      if (s?.hasToken) setTimeout(startWalkthrough, 800);
    });
  });

  chrome.runtime.sendMessage({ type: 'REFRESH_SUBSCRIPTION' }).catch(() => {});

  const hideHandler = (e) => {
    e.stopPropagation();
    setBarVisible(false);
    chrome.storage.local.set({ [BAR_HIDDEN_KEY]: true });
  };
  tab.querySelector('#aplBarHide')?.addEventListener('click', hideHandler);
  tab.querySelector('#aplBarHideSignedOut')?.addEventListener('click', hideHandler);

  showBtn.addEventListener('click', () => {
    setBarVisible(true);
    chrome.storage.local.set({ [BAR_HIDDEN_KEY]: false });
  });

  setTimeout(() => {
    getState().then((s) => {
      updateBar(tab, s);
      if (s?.hasToken && !searchPollInterval) {
        refreshQueueWithSearch();
        startSearchPolling();
      }
    });
  }, 2500);

  window.addEventListener('hashchange', () => {
    resetProgressBar();
    const current = getSearchHash();
    if (normalizeSearchForCompare(current) !== normalizeSearchForCompare(lastSearchHash)) {
      lastSearchHash = current;
      lastLoadedThreadIds = null;
      refreshQueueWithSearch();
    }
  });

  document.addEventListener('scroll', scheduleVisibleSampleUpdate, { passive: true, capture: true });
  window.addEventListener('scroll', scheduleVisibleSampleUpdate, { passive: true });
  window.addEventListener('resize', scheduleVisibleSampleUpdate);

  let scrollRefreshTimeout = null;
  const onScrollForQueue = () => {
    if (scrollRefreshTimeout) clearTimeout(scrollRefreshTimeout);
    scrollRefreshTimeout = setTimeout(() => {
      scrollRefreshTimeout = null;
      if (isThreadView()) return;
      const visible = getVisibleIds();
      const ids = visible?.threadIds ?? visible?.messageIds;
      if (!ids || ids.length === 0) return;
      const changed = !lastLoadedThreadIds || ids.length !== lastLoadedThreadIds.length ||
        ids.some((id, i) => id !== lastLoadedThreadIds[i]);
      if (changed) refreshQueueWithSearch();
    }, 2000);
  };
  document.addEventListener('scroll', onScrollForQueue, { passive: true, capture: true });

  tab.querySelector('#aplBarPrev')?.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'PREV' });
    setTimeout(() => getState().then((s) => { updateBar(tab, s); updatePanel(s); }), 100);
  });
  tab.querySelector('#aplBarPlay')?.addEventListener('click', (e) => {
    e.stopPropagation();
    getState().then((s) => {
      if (!s?.hasToken) { chrome.runtime.sendMessage({ type: 'OPEN_AUTH_TAB' }); return; }
      if (s.queue.length === 0) return;
      chrome.runtime.sendMessage({ type: s.isPlaying ? 'STOP' : 'PLAY' });
      setTimeout(() => getState().then((st) => { updateBar(tab, st); updatePanel(st); }), 100);
    });
  });
  tab.querySelector('#aplBarNext')?.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'NEXT' });
    setTimeout(() => getState().then((s) => { updateBar(tab, s); updatePanel(s); }), 100);
  });
  tab.querySelector('#aplBarShuffle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'SHUFFLE' });
    setTimeout(() => getState().then((s) => { updateBar(tab, s); updatePanel(s); }), 100);
  });
  tab.querySelector('#aplBarDownload')?.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'DOWNLOAD' });
  });
  tab.querySelector('#aplBarSignIn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'OPEN_AUTH_TAB' });
  });
}

function resetProgressBar() {
  const t = document.querySelector('.apl-tab');
  if (t) {
    const pf = t.querySelector('#aplBarProgressFill');
    if (pf) pf.style.width = '0%';
  }
  if (barProgressInterval) {
    clearInterval(barProgressInterval);
    barProgressInterval = null;
  }
}

function getSearchQueryFromHash() {
  const hash = window.location.hash || '';
  const match = hash.match(/#search\/(.+?)(?:\/|$)/);
  if (!match) return '';
  const raw = match[1];
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
  } catch {
    return '';
  }
}

function getSearchHash() {
  const hash = window.location.hash || '';
  const match = hash.match(/#search\/(.+?)(?:\/|$)/);
  if (!match) return '';
  return match[1];
}

function normalizeSearchForCompare(hash) {
  if (!hash) return '';
  try {
    return decodeURIComponent(hash.replace(/\+/g, ' ')).trim();
  } catch {
    return hash;
  }
}

/** True when viewing a single email thread (e.g. #inbox/FMfcg... or #search/query/FMfcg...) */
function isThreadView() {
  const hash = window.location.hash || '';
  return /\/[A-Za-z0-9_-]{12,}$/.test(hash);
}

const EMAIL_LIST_TOP = 140;

/** Get visible thread IDs from Gmail DOM (rows on screen), top to bottom. Returns { threadIds, messageIds } - use whichever is available. */
function getVisibleIds() {
  const viewportTop = EMAIL_LIST_TOP;
  const viewportBottom = window.innerHeight;
  const threadFound = [];
  const messageFound = [];
  const seenThread = new Set();
  const seenMessage = new Set();

  const threadRows = document.querySelectorAll('[role="main"] [data-legacy-thread-id], [data-legacy-thread-id]');
  for (const el of threadRows) {
    const id = el.getAttribute('data-legacy-thread-id');
    if (!id || seenThread.has(id)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < viewportTop || rect.top > viewportBottom) continue;
    if (rect.width < 50 || rect.height < 20) continue;
    seenThread.add(id);
    threadFound.push({ top: rect.top, id });
  }

  const messageRows = document.querySelectorAll('[role="main"] [data-legacy-message-id], [data-legacy-message-id]');
  for (const el of messageRows) {
    const id = el.getAttribute('data-legacy-message-id');
    if (!id || seenMessage.has(id)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < viewportTop || rect.top > viewportBottom) continue;
    if (rect.width < 50 || rect.height < 20) continue;
    seenMessage.add(id);
    messageFound.push({ top: rect.top, id });
  }

  if (threadFound.length > 0) {
    threadFound.sort((a, b) => a.top - b.top);
    return { threadIds: threadFound.map((f) => f.id), messageIds: null };
  }
  if (messageFound.length > 0) {
    messageFound.sort((a, b) => a.top - b.top);
    return { threadIds: null, messageIds: messageFound.map((f) => f.id) };
  }
  return null;
}

function getVisibleThreadIds() {
  const result = getVisibleIds();
  return result?.threadIds ?? null;
}

let refreshQueueTimeout = null;
const REFRESH_DEBOUNCE_MS = 400;

function refreshQueueWithSearch() {
  if (refreshQueueTimeout) clearTimeout(refreshQueueTimeout);
  refreshQueueTimeout = setTimeout(() => {
    refreshQueueTimeout = null;
    const searchQuery = getSearchQueryFromHash();
    const visible = getVisibleIds();
    const visibleThreadIds = visible?.threadIds ?? null;
    const visibleMessageIds = visible?.messageIds ?? null;
    if (visibleThreadIds || visibleMessageIds) lastLoadedThreadIds = visibleThreadIds || visibleMessageIds;
    chrome.runtime.sendMessage({ type: 'LOAD_QUEUE', searchQuery, visibleThreadIds, visibleMessageIds }, () => {
      getState().then((s) => {
        const t = document.querySelector('.apl-tab');
        if (t) {
          resetProgressBar();
          updateBar(t, s);
        }
        if (panelOpen) updatePanel(s);
      });
    });
  }, REFRESH_DEBOUNCE_MS);
}

let lastSearchHash = null;
let searchPollInterval = null;
let lastLoadedThreadIds = null;

function startSearchPolling() {
  if (searchPollInterval) return;
  lastSearchHash = getSearchHash();
  searchPollInterval = setInterval(() => {
    const current = getSearchHash();
    if (normalizeSearchForCompare(current) !== normalizeSearchForCompare(lastSearchHash)) {
      lastSearchHash = current;
      refreshQueueWithSearch();
    }
  }, 2000);
}

/** Matches Gmail sample tags: "[All The Way] 11...", "(guitar,synth) fa...", "92. DROP-OUT..." */
const SAMPLE_TAG_RE = /^\[[^\]]{2,}|^[!]?\([^)]{2,}|^\d+\.\s+.+/;

/** Subject-line fragments to skip - often match (paren) but aren't sample tags */
const SUBJECT_NOISE = /^\([^)]+\)\s*(new|inbox|loops?)\s*$/i;

function getFirstVisibleSampleTag() {
  const viewportTop = EMAIL_LIST_TOP;
  const viewportBottom = window.innerHeight;
  const found = [];
  const seen = new Set();

  function addIfValid(el, text) {
    const t = (text || el.textContent || '').trim();
    if (!t || t.length > 80 || t.length < 3) return;
    if (!SAMPLE_TAG_RE.test(t)) return;
    if (SUBJECT_NOISE.test(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    const rect = el.getBoundingClientRect();
    if (rect.bottom < viewportTop || rect.top > viewportBottom) return;
    if (rect.width < 10 || rect.height < 5) return;
    found.push({ top: rect.top, text: t });
  }

  const byClass = document.querySelectorAll('[class*="bqe"], [class*="bq4"], [class*="y2"], [class*="ajy"], [class*="aLE"], span[style*="border"], span[style*="padding"]');
  for (const el of byClass) {
    addIfValid(el, el.textContent);
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.textContent || '').trim();
    if (!text || !SAMPLE_TAG_RE.test(text) || text.length > 80 || text.length < 3) continue;
    if (SUBJECT_NOISE.test(text)) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest?.('.apl-root')) continue;
    addIfValid(parent, text);
  }

  if (found.length === 0) return null;
  found.sort((a, b) => a.top - b.top);
  return found[0].text;
}

function getVisibleSampleLabel(state) {
  const loop = state?.currentLoop ?? (state?.queue?.[state?.currentIndex]);
  if (state?.isPlaying || state?.isPaused || (loop && state?.currentIndex >= 0)) {
    return loop?.filename || loop?.subject || 'Loops';
  }
  const visible = getFirstVisibleSampleTag();
  if (visible) return visible;
  return loop?.filename || loop?.subject || 'Loops';
}

let visibleSampleRaf = null;
function scheduleVisibleSampleUpdate() {
  if (visibleSampleRaf) return;
  visibleSampleRaf = requestAnimationFrame(() => {
    visibleSampleRaf = null;
    getState().then((state) => {
      const label = document.querySelector('#aplBarLabel');
      if (!label || !state?.hasToken) return;
      const inner = label.querySelector('.apl-bar-label-inner');
      const name = getVisibleSampleLabel(state);
      if (inner) inner.textContent = name;
      label.title = name;
    });
  });
}

function updateBar(tab, state) {
  if (!tab) return;
  const signedOut = tab.querySelector('#aplBarSignedOut');
  const signedIn = tab.querySelector('#aplBarSignedIn');
  if (signedOut) signedOut.style.display = state?.hasToken ? 'none' : 'flex';
  if (signedIn) signedIn.style.display = state?.hasToken ? 'flex' : 'none';

  if (!state?.hasToken) return;

  const playBtn = tab.querySelector('#aplBarPlay');
  const label = tab.querySelector('#aplBarLabel');
  const shuffleBtn = tab.querySelector('#aplBarShuffle');
  const progressFill = tab.querySelector('#aplBarProgressFill');
  if (playBtn) {
    playBtn.textContent = state?.isPlaying ? '⏸' : '▶';
  }
  if (shuffleBtn) shuffleBtn.classList.toggle('active', state?.shuffleOn);
  if (progressFill) {
    const duration = state?.playDuration ?? 10;
    const elapsed = state?.elapsedSeconds ?? 0;
    const pct = Math.min(100, (elapsed / duration) * 100);
    progressFill.style.width = pct + '%';
    if (barProgressInterval) clearInterval(barProgressInterval);
    if (state?.isPlaying && duration > 0) {
      const startTime = Date.now() - elapsed * 1000;
      barProgressInterval = setInterval(() => {
        const now = (Date.now() - startTime) / 1000;
        const newPct = Math.min(100, (now / duration) * 100);
        progressFill.style.width = newPct + '%';
        if (newPct >= 100) clearInterval(barProgressInterval);
      }, 100);
    } else {
      barProgressInterval = null;
    }
  }
  if (label) {
    const inner = label.querySelector('.apl-bar-label-inner');
    const name = getVisibleSampleLabel(state);
    if (inner) inner.textContent = name;
    label.title = name;
  }
}

function showRefreshPrompt() {
  if (document.getElementById('apl-refresh-prompt')) return;
  const banner = document.createElement('div');
  banner.id = 'apl-refresh-prompt';
  banner.className = 'apl-refresh-prompt';
  banner.innerHTML = `
    <span class="apl-refresh-prompt-text">Signed in! Refresh this page to load LoopMail.</span>
    <button class="apl-refresh-prompt-btn" type="button">Refresh</button>
    <button class="apl-refresh-prompt-dismiss" type="button" aria-label="Dismiss">×</button>
  `;
  const btn = banner.querySelector('.apl-refresh-prompt-btn');
  const dismiss = banner.querySelector('.apl-refresh-prompt-dismiss');
  btn.addEventListener('click', () => location.reload());
  dismiss.addEventListener('click', () => banner.remove());
  document.body.appendChild(banner);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') {
    const tab = document.querySelector('.apl-tab');
    if (tab) updateBar(tab, msg.payload);
    if (panelOpen) updatePanel(msg.payload);
    if (msg.payload?.hasToken && !searchPollInterval) {
      refreshQueueWithSearch();
      startSearchPolling();
      setTimeout(startWalkthrough, 800);
    }
  } else if (msg.type === 'SHOW_REFRESH_PROMPT') {
    showRefreshPrompt();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    getState().then((s) => {
      const t = document.querySelector('.apl-tab');
      if (t) updateBar(t, s);
      if (panelOpen) updatePanel(s);
      if (s?.hasToken && !searchPollInterval) {
        refreshQueueWithSearch();
        startSearchPolling();
      }
    });
  }
});

function tryInject() {
  if (document.getElementById('apl-container')) return true;
  if (!document.body) return false;
  inject();
  // Return true only if injection actually committed (container now in DOM)
  return !!document.getElementById('apl-container');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => tryInject(), 500);
    setTimeout(() => tryInject(), 2000);
    setTimeout(() => tryInject(), 5000);
  });
} else {
  tryInject();
  setTimeout(() => tryInject(), 2000);
  setTimeout(() => tryInject(), 5000);
}

let retries = 0;
const retryInterval = setInterval(() => {
  retries++;
  if (tryInject() || retries > 30) clearInterval(retryInterval);
}, 1500);

// ── First-time walkthrough ──
const WALKTHROUGH_DONE_KEY = 'walkthroughDone';
const WALKTHROUGH_TIPS = [
  { id: 'aplBarPlay',     text: 'Hit play to start cycling through your loops' },
  { id: 'aplBarNext',     text: 'Skip to the next loop in your queue' },
  { id: 'aplBarShuffle',  text: 'Shuffle your queue for a random order' },
  { id: 'aplBarDownload', text: 'One-click save — grab anything that hits' },
];

let wtTooltip = null;
let wtIndex = 0;
let walkthroughAttempted = false;

function positionWtTooltip() {
  if (!wtTooltip) return;
  const target = document.getElementById(WALKTHROUGH_TIPS[wtIndex].id);
  if (!target) return;
  const tr = target.getBoundingClientRect();
  const tt = wtTooltip.getBoundingClientRect();
  wtTooltip.style.left = (tr.left + tr.width / 2) + 'px';
  wtTooltip.style.top = (tr.bottom + 12) + 'px';
}

function showWtTip(index) {
  if (!wtTooltip || index >= WALKTHROUGH_TIPS.length) { finishWalkthrough(); return; }
  wtIndex = index;
  WALKTHROUGH_TIPS.forEach((t) => document.getElementById(t.id)?.classList.remove('apl-wt-active'));
  document.getElementById(WALKTHROUGH_TIPS[index].id)?.classList.add('apl-wt-active');
  wtTooltip.querySelector('.apl-wt-text').textContent = WALKTHROUGH_TIPS[index].text;
  wtTooltip.querySelector('.apl-wt-count').textContent = (index + 1) + ' / ' + WALKTHROUGH_TIPS.length;
  wtTooltip.querySelector('.apl-wt-next').textContent = index < WALKTHROUGH_TIPS.length - 1 ? 'Next →' : 'Done';
  wtTooltip.style.display = 'block';
  requestAnimationFrame(() => requestAnimationFrame(positionWtTooltip));
}

function finishWalkthrough() {
  if (wtTooltip) { wtTooltip.remove(); wtTooltip = null; }
  WALKTHROUGH_TIPS.forEach((t) => document.getElementById(t.id)?.classList.remove('apl-wt-active'));
  chrome.storage.local.set({ [WALKTHROUGH_DONE_KEY]: true });
}

function startWalkthrough() {
  if (walkthroughAttempted) return;
  walkthroughAttempted = true;
  chrome.storage.local.get(WALKTHROUGH_DONE_KEY, (result) => {
    if (result[WALKTHROUGH_DONE_KEY]) return;
    wtTooltip = document.createElement('div');
    wtTooltip.className = 'apl-root apl-walkthrough-tooltip';
    wtTooltip.innerHTML = `
      <button class="apl-wt-close" aria-label="Dismiss">✕</button>
      <p class="apl-wt-text"></p>
      <div class="apl-wt-footer">
        <span class="apl-wt-count"></span>
        <button class="apl-wt-next">Next →</button>
      </div>
    `;
    document.body.appendChild(wtTooltip);
    wtTooltip.querySelector('.apl-wt-next').addEventListener('click', () => {
      wtIndex < WALKTHROUGH_TIPS.length - 1 ? showWtTip(wtIndex + 1) : finishWalkthrough();
    });
    wtTooltip.querySelector('.apl-wt-close').addEventListener('click', finishWalkthrough);
    window.addEventListener('resize', () => { if (wtTooltip) positionWtTooltip(); });
    showWtTip(0);
  });
}
