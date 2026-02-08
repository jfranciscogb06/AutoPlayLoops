/**
 * LoopMail - Offscreen Document
 * Plays audio for 10 seconds then requests next loop
 */

let audio = null;
let advanceTimeout = null;
let currentBlobUrl = null;
let currentDurationMs = 10000;

function stop() {
  if (advanceTimeout) {
    clearTimeout(advanceTimeout);
    advanceTimeout = null;
  }
  if (audio) {
    audio.pause();
    audio.src = '';
    audio = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

function pause() {
  if (advanceTimeout) {
    clearTimeout(advanceTimeout);
    advanceTimeout = null;
  }
  if (audio) {
    audio.pause();
  }
}

function resume(elapsedMs) {
  if (!audio) return;
  const remainingMs = Math.max(0, currentDurationMs - elapsedMs);
  audio.currentTime = elapsedMs / 1000;
  audio.play().catch((e) => {
    console.error('Audio resume failed:', e);
    chrome.runtime.sendMessage({ type: 'AUDIO_NEXT' });
  });
  advanceTimeout = setTimeout(() => {
    advanceTimeout = null;
    stop();
    chrome.runtime.sendMessage({ type: 'AUDIO_NEXT' });
  }, remainingMs);
}

function playFrom(base64, mimeType, durationMs, startOffsetMs) {
  stop();
  currentDurationMs = durationMs;
  const blobUrl = base64ToBlobUrl(base64, mimeType);
  currentBlobUrl = blobUrl;
  audio = new Audio(blobUrl);
  const remainingMs = Math.max(0, durationMs - startOffsetMs);
  audio.currentTime = startOffsetMs / 1000;
  audio.play().catch((e) => {
    console.error('Audio playFrom failed:', e);
    chrome.runtime.sendMessage({ type: 'AUDIO_NEXT' });
  });
  advanceTimeout = setTimeout(() => {
    advanceTimeout = null;
    stop();
    chrome.runtime.sendMessage({ type: 'AUDIO_NEXT' });
  }, remainingMs);
}

function base64ToBlobUrl(base64, mimeType) {
  const binary = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType || 'audio/mpeg' });
  return URL.createObjectURL(blob);
}

function play(base64, mimeType, loopName, durationMs = 10000) {
  stop();

  currentDurationMs = durationMs;
  const blobUrl = base64ToBlobUrl(base64, mimeType);
  currentBlobUrl = blobUrl;
  audio = new Audio(blobUrl);

  audio.play().catch((e) => {
    console.error('Audio play failed:', e);
    chrome.runtime.sendMessage({ type: 'AUDIO_NEXT' });
  });

  advanceTimeout = setTimeout(() => {
    advanceTimeout = null;
    stop();
    chrome.runtime.sendMessage({ type: 'AUDIO_NEXT' });
  }, durationMs);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_PLAY') {
    const { base64, mimeType, loopName, durationMs } = msg.payload || {};
    if (base64) play(base64, mimeType, loopName, durationMs || 10000);
  } else if (msg.type === 'OFFSCREEN_PAUSE') {
    pause();
  } else if (msg.type === 'OFFSCREEN_RESUME') {
    const { elapsedMs } = msg.payload || {};
    resume(elapsedMs ?? 0);
  } else if (msg.type === 'OFFSCREEN_PLAY_FROM') {
    const { base64, mimeType, durationMs, startOffsetMs } = msg.payload || {};
    if (base64) playFrom(base64, mimeType, durationMs || 10000, startOffsetMs ?? 0);
  } else if (msg.type === 'OFFSCREEN_STOP') {
    stop();
  }
});
