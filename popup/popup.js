/**
 * LoopMail - Popup UI
 * Preview duration + Manage accounts
 */

const signedInAs = document.getElementById('signedInAs');

function updateSignedInDisplay() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (state?.hasToken) {
      chrome.runtime.sendMessage({ type: 'GET_USER_EMAIL' }, (res) => {
        const gmail = res?.gmailEmail || res?.loopmailEmail;
        if (gmail) {
          signedInAs.textContent = 'Gmail: ' + gmail;
          signedInAs.style.display = 'block';
        } else {
          signedInAs.style.display = 'none';
        }
      });
    } else {
      signedInAs.style.display = 'none';
    }
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

document.getElementById('manageAccountsLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('manage/manage.html') });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') updateSignedInDisplay();
});

updateSignedInDisplay();
