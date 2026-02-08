/**
 * LoopMail demo - text carousel in the bar
 * Cycles through promo phrases, same controls as Gmail bar
 */
(function () {
  const CYCLE_SECONDS = 4;

  const PHRASES = [
    'Browse loops and samples from your inbox.',
    'Shuffle the queue, skip, grab what you want',
    'All from a bar that lives inside Gmail.',
  ];

  let queue = [...PHRASES];
  let currentIndex = 0;
  let isPlaying = false;
  let shuffleOn = false;
  let cycleTimeout = null;

  const playBtn = document.getElementById('demoPlay');
  const prevBtn = document.getElementById('demoPrev');
  const nextBtn = document.getElementById('demoNext');
  const shuffleBtn = document.getElementById('demoShuffle');
  const downloadBtn = document.getElementById('demoDownload');
  const labelInner = document.querySelector('#demoLabel .apl-bar-label-inner');

  function getCurrent() {
    return queue[currentIndex];
  }

  function updateLabel(text, fade = false) {
    if (!labelInner) return;
    const newText = text || getCurrent() || PHRASES[0];
    if (fade) {
      labelInner.style.opacity = '0';
      setTimeout(() => {
        labelInner.textContent = newText;
        labelInner.offsetHeight;
        labelInner.style.opacity = '1';
      }, 400);
    } else {
      labelInner.textContent = newText;
    }
  }

  function scheduleNext() {
    if (cycleTimeout) clearTimeout(cycleTimeout);
    cycleTimeout = setTimeout(() => {
      cycleTimeout = null;
      goNext(true);
    }, CYCLE_SECONDS * 1000);
  }

  function stopCycling() {
    if (cycleTimeout) {
      clearTimeout(cycleTimeout);
      cycleTimeout = null;
    }
    isPlaying = false;
    playBtn.textContent = '▶';
    playBtn.classList.remove('playing');
  }

  function startCycling() {
    isPlaying = true;
    playBtn.textContent = '⏸';
    playBtn.classList.add('playing');
    updateLabel(getCurrent(), false);
    scheduleNext();
  }

  function goNext(auto = false) {
    currentIndex = (currentIndex + 1) % queue.length;
    updateLabel(getCurrent(), auto);
    if (isPlaying) scheduleNext();
  }

  function goPrev() {
    currentIndex = (currentIndex - 1 + queue.length) % queue.length;
    updateLabel(getCurrent(), false);
    if (isPlaying) scheduleNext();
  }

  function shuffle() {
    if (shuffleOn) {
      shuffleOn = false;
      shuffleBtn.classList.remove('active');
      const current = queue[currentIndex];
      queue = [...PHRASES];
      currentIndex = PHRASES.indexOf(current);
      if (currentIndex < 0) currentIndex = 0;
      updateLabel(getCurrent(), false);
      if (isPlaying) scheduleNext();
    } else {
      if (queue.length < 2) return;
      shuffleOn = true;
      shuffleBtn.classList.add('active');
      const current = queue[currentIndex];
      const rest = queue.filter((_, i) => i !== currentIndex);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      queue = [current, ...rest];
      currentIndex = 0;
      updateLabel(getCurrent(), false);
      if (isPlaying) scheduleNext();
    }
  }

  playBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isPlaying) stopCycling();
    else startCycling();
  });

  prevBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    goPrev();
  });

  nextBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    goNext();
  });

  shuffleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    shuffle();
  });

  downloadBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'Space') {
      e.preventDefault();
      if (isPlaying) stopCycling();
      else startCycling();
    } else if (e.altKey && e.code === 'ArrowLeft') {
      e.preventDefault();
      goPrev();
    } else if (e.altKey && e.code === 'ArrowRight') {
      e.preventDefault();
      goNext();
    }
  });

  updateLabel();
  startCycling();
})();
