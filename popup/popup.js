/**
 * LoopMail - Popup UI
 * Preview duration + account actions (sign in or manage)
 */

const accountActions = document.getElementById('accountActions');
const manageActions = document.getElementById('manageActions');
const signInLink = document.getElementById('signInLink');
const manageAccountLink = document.getElementById('manageAccountLink');

function updateUI(state) {
  const hasToken = state?.hasToken ?? false;

  if (hasToken) {
    accountActions.style.display = 'none';
    manageActions.style.display = 'flex';
  } else {
    accountActions.style.display = 'flex';
    manageActions.style.display = 'none';
  }
}

async function getState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve);
  });
}

chrome.storage.local.get('playDuration', (result) => {
  const select = document.getElementById('durationSelect');
  if (select) select.value = String(result.playDuration ?? 10);
});

document.getElementById('durationSelect')?.addEventListener('change', (e) => {
  const seconds = parseInt(e.target.value, 10);
  chrome.storage.local.set({ playDuration: seconds });
});

signInLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('auth/auth.html') });
});

manageAccountLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('auth/auth.html') });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') {
    updateUI(msg.payload);
  }
});

getState().then(updateUI);
