const manageUrl = chrome.runtime.getURL('manage/manage.html');
window.location.replace(manageUrl);

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.querySelector('.btn');
  if (btn) btn.onclick = (e) => { e.preventDefault(); window.location.replace(manageUrl); };
});
