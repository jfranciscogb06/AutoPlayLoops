(function () {
  // ── Modal ──
  var modal = document.getElementById('onboardModal');
  var closeBtn = document.getElementById('onboardClose');

  function openModal(e) {
    e.preventDefault();
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  document.querySelectorAll('.cta-header, .cta-primary, .cta-secondary, #demoDownload')
    .forEach(function (el) { el.addEventListener('click', openModal); });

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (modal) modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });

  // ── Demo bar tooltip walkthrough ──
  var TIPS = [
    { id: 'demoPlay',     text: 'Play and pause your loop queue' },
    { id: 'demoNext',     text: 'Skip to the next loop in your queue' },
    { id: 'demoShuffle',  text: 'Shuffle your queue — works just like Spotify' },
    { id: 'demoDownload', text: 'One-click save — grab anything that hits' },
  ];

  var tooltip    = document.getElementById('demoTooltip');
  var tipText    = document.getElementById('demoTooltipText');
  var tipCount   = document.getElementById('demoTooltipCount');
  var tipNextBtn = document.getElementById('demoTooltipNext');
  var tipClose   = document.getElementById('demoTooltipClose');
  var tipIndex   = 0;

  function positionTooltip() {
    if (!tooltip) return;
    var target = document.getElementById(TIPS[tipIndex].id);
    if (!target) return;
    var tr = target.getBoundingClientRect();
    var tt = tooltip.getBoundingClientRect();
    tooltip.style.left = (tr.left + tr.width / 2) + 'px';
    tooltip.style.top  = Math.max(8, tr.top - tt.height - 14) + 'px';
  }

  function showTip(index) {
    if (!tooltip || index >= TIPS.length) { hideTips(); return; }
    tipIndex = index;
    tipText.textContent  = TIPS[index].text;
    tipCount.textContent = (index + 1) + ' / ' + TIPS.length;
    tipNextBtn.textContent = index < TIPS.length - 1 ? 'Next →' : 'Done';

    TIPS.forEach(function (t) {
      var el = document.getElementById(t.id);
      if (el) el.classList.remove('tip-active');
    });
    var active = document.getElementById(TIPS[index].id);
    if (active) active.classList.add('tip-active');

    tooltip.hidden = false;
    requestAnimationFrame(function () { requestAnimationFrame(positionTooltip); });
  }

  function hideTips() {
    if (tooltip) tooltip.hidden = true;
    TIPS.forEach(function (t) {
      var el = document.getElementById(t.id);
      if (el) el.classList.remove('tip-active');
    });
  }

  if (tipNextBtn) tipNextBtn.addEventListener('click', function () {
    tipIndex < TIPS.length - 1 ? showTip(tipIndex + 1) : hideTips();
  });

  if (tipClose) tipClose.addEventListener('click', hideTips);

  window.addEventListener('resize', function () {
    if (tooltip && !tooltip.hidden) positionTooltip();
  });

  setTimeout(function () { showTip(0); }, 1500);
})();
