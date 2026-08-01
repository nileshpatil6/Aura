// ──── DOM refs ────────────────────────────────────────────────────────────────
const pillEl          = document.getElementById('pill');
const peekBar         = document.getElementById('peek-bar');
const closeBtn        = document.getElementById('close-btn');
const orbWrap         = document.getElementById('orb-wrap');
const orbIcon         = document.getElementById('orb-icon');
const pillWaveEl      = document.getElementById('pill-wave');
const panel           = document.getElementById('panel');
const statusText      = document.getElementById('status-text');
const visualizer      = document.getElementById('visualizer');
const barsEl          = document.getElementById('bars');
const thinkingAnim    = document.getElementById('thinking-anim');
const speakingAnim    = document.getElementById('speaking-anim');
const waveBarsEl      = document.getElementById('wave-bars');
const transcriptEl    = document.getElementById('transcript');
const userTextEl      = document.getElementById('user-text');
const textInputRow    = document.getElementById('text-input-row');
const textInput       = document.getElementById('text-input');
const sendBtn         = document.getElementById('send-btn');
const errorBox        = document.getElementById('error-box');
const keyboardBtn     = document.getElementById('keyboard-btn');
const settingsBtn     = document.getElementById('settings-btn');
const expandBtn       = document.getElementById('expand-btn');

// ──── Build panel visualizer bars ─────────────────────────────────────────────
const BAR_COUNT = 22;
for (let i = 0; i < BAR_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.height = '5px';
  barsEl.appendChild(b);
}

// ──── Build pill mini waveform bars (8 compact bars) ──────────────────────────
const PILL_BAR_COUNT = 8;
const pillBarEls = [];
for (let i = 0; i < PILL_BAR_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'pill-wave-bar';
  b.style.height = '3px';
  pillWaveEl.appendChild(b);
  pillBarEls.push(b);
}

// ──── Build speaking wave bars ─────────────────────────────────────────────────
const WAVE_COUNT = 24;
const waveColors = ['#8a5230','#d98a4f','#ffb066','#d98a4f'];
for (let i = 0; i < WAVE_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'wave-bar';
  const frac = i / WAVE_COUNT;
  const h = 4 + Math.sin(frac * Math.PI) * 28;
  b.style.height = `${h}px`;
  b.style.background = waveColors[Math.floor(frac * waveColors.length)];
  b.style.animationDelay = `${(frac * 0.55).toFixed(3)}s`;
  waveBarsEl.appendChild(b);
}

// ──── State ───────────────────────────────────────────────────────────────────
let voiceActive    = false;
let isPanelOpen    = false;
let currentState   = 'idle';
let isMuted        = false;
let gemini         = null;
let stopVisualizer = null;
let showingInput   = false;
let transcriptText = '';
let autoHideTimer  = null;
let isEdgeHidden   = false;

// ──── Icon paths per state ─────────────────────────────────────────────────────
const MIC_PATH = 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z';
const MIC_MUTED_PATH = 'M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z';
const ICONS = {
  idle:       MIC_PATH,
  connecting: MIC_PATH,
  listening:  MIC_PATH,
  thinking:   'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z',
  speaking:   'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77z',
};

const STATUS_LABELS = {
  idle:       'IDLE',
  connecting: 'CONNECTING',
  listening:  'LISTENING',
  thinking:   'THINKING',
  speaking:   'SPEAKING',
};

// ──── Set state ────────────────────────────────────────────────────────────────
function setState(state) {
  if (currentState === state) return;
  currentState = state;
  orbWrap.className = `orb-wrap ${state}${isMuted ? ' muted' : ''}`;
  panel.dataset.state = state;
  window.electronAPI?.sendPillState?.(state);
  const pathEl = orbIcon.querySelector('path');
  if (pathEl) pathEl.setAttribute('d', isMuted ? MIC_MUTED_PATH : (ICONS[state] || ICONS.idle));
  statusText.textContent = STATUS_LABELS[state];

  visualizer.classList.toggle('hidden',   state !== 'listening');
  thinkingAnim.classList.toggle('hidden', state !== 'thinking');
  speakingAnim.classList.toggle('hidden', state !== 'speaking');

  // Show pill wave bars when listening or speaking (regardless of panel state)
  const isWave = state === 'listening' || state === 'speaking';
  pillWaveEl.classList.toggle('visible', isWave);
  syncPillSize(); // ResizeObserver also catches this, but call explicitly for zero-lag response
}

// ──── Helpers ─────────────────────────────────────────────────────────────────
function appendTranscript(text) {
  transcriptText += text;
  transcriptEl.textContent = transcriptText;
  transcriptEl.classList.remove('hidden');
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setUserText(text) {
  userTextEl.textContent = `You: "${text}"`;
  userTextEl.classList.remove('hidden');
}

function showError(msg) {
  errorBox.textContent = '⚠  ' + msg;
  errorBox.classList.remove('hidden');
}

// ──── Pill sizing ─────────────────────────────────────────────────────────────
// The window's actual pixel size is whatever the pill's real content measures
// out to — never a hardcoded guess. Report it to main on every layout change
// so the OS window always matches the DOM exactly (fixes clipping for good).
let pillSizeRaf = null;
function syncPillSize() {
  if (isPanelOpen) return; // expanded panel has its own fixed window size
  if (pillSizeRaf) cancelAnimationFrame(pillSizeRaf);
  pillSizeRaf = requestAnimationFrame(() => {
    pillSizeRaf = requestAnimationFrame(() => {
      const rect = pillEl.getBoundingClientRect();
      window.electronAPI?.resizePill?.(rect.width, rect.height);
    });
  });
}
new ResizeObserver(() => syncPillSize()).observe(pillEl);

// ──── Visualizer update ───────────────────────────────────────────────────────
function onVisualizerBars(bars) {
  const barEls = barsEl.querySelectorAll('.bar');
  bars.forEach((h, i) => { if (barEls[i]) barEls[i].style.height = `${h}px`; });

  pillBarEls.forEach((el, i) => {
    const idx = Math.floor((i / PILL_BAR_COUNT) * bars.length);
    el.style.height = `${Math.max(3, bars[idx] * 0.75)}px`;
  });
}

// ──── API key check ───────────────────────────────────────────────────────────
async function hasApiKey() {
  let key = '';
  try { key = await window.electronAPI?.storeGet('settings', 'apiKey') || ''; } catch {}
  if (!key) key = localStorage.getItem('gemini_api_key') || '';
  return !!key;
}

settingsBtn.addEventListener('click', () => window.electronAPI?.openDashboard());

const dashboardBtn = document.getElementById('dashboard-btn');
dashboardBtn?.addEventListener('click', () => window.electronAPI?.openDashboard());

// Quick-action chips
document.querySelectorAll('.chip').forEach(btn => {
  btn.addEventListener('click', async () => {
    const a = btn.dataset.quick;
    const api = window.electronAPI;
    try {
      if (a === 'play_pause') await api.mediaControl('play_pause');
      else if (a === 'next')  await api.mediaControl('next');
      else if (a === 'mute')  await api.mediaControl('mute');
      else if (a === 'agent') api.openAgent();
      else if (a === 'ask')   api.openAsk();
      else if (a === 'clipboard') {
        const r = await api.readClipboard();
        appendTranscript(`Clipboard: ${(r.output || '').slice(0, 200)}\n`);
      }
      else if (a === 'minimize') await api.minimizeAll();
      else if (a === 'lock')     await api.lockScreen();
      btn.style.background = 'rgba(52, 211, 153, 0.35)';
      setTimeout(() => { btn.style.background = ''; }, 280);
    } catch (e) {
      showError(e.message);
    }
  });
});

// ──── Auto-hide helpers ───────────────────────────────────────────────────────
function scheduleAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = setTimeout(() => {
    if (!voiceActive && !isPanelOpen) {
      isEdgeHidden = true;
      peekBar.classList.remove('hidden');
      window.electronAPI?.pillAutoHide();
    }
  }, 20000);
}

function cancelAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = null;
  if (isEdgeHidden) {
    isEdgeHidden = false;
    peekBar.classList.add('hidden');
    window.electronAPI?.pillShow();
  }
}

// ──── Panel open / close ──────────────────────────────────────────────────────
function openPanel() {
  cancelAutoHide();
  isPanelOpen = true;
  panel.classList.remove('hidden');
  void panel.offsetWidth;
  panel.style.animation = 'none';
  void panel.offsetWidth;
  panel.style.animation = '';
  expandBtn.classList.add('open');
  window.electronAPI?.resizeExpanded();
}

function closePanel() {
  isPanelOpen = false;
  panel.classList.add('hidden');
  expandBtn.classList.remove('open');
  showingInput = false;
  textInputRow.classList.add('hidden');
  syncPillSize(); // panel hidden doesn't change #pill itself — ResizeObserver won't fire, so call explicitly
}

// ──── Voice activate ──────────────────────────────────────────────────────────
async function activateVoice() {
  cancelAutoHide();
  voiceActive = true;
  isMuted     = false;
  transcriptText = '';
  transcriptEl.textContent = '';
  transcriptEl.classList.add('hidden');
  userTextEl.classList.add('hidden');
  errorBox.classList.add('hidden');
  closeBtn.classList.remove('hidden');
  await ensureConnected();
}

async function ensureConnected() {
  if (gemini && gemini.connected) return true;

  if (!(await hasApiKey())) {
    voiceActive = false;
    closeBtn.classList.add('hidden');
    showError('No Gemini API key set — opening dashboard.');
    setState('idle');
    setTimeout(() => window.electronAPI?.openDashboard(), 600);
    return false;
  }

  setState('connecting');
  errorBox.classList.add('hidden');

  if (!gemini) {
    gemini = new GeminiLive({
      onStateChange: setState,
      onTranscript:  appendTranscript,
      onUserText:    setUserText,
      onError:       (msg) => { showError(msg); setState('idle'); },
      onReady: () => { if (gemini) stopVisualizer = gemini.startVisualizer(onVisualizerBars); },
    });
  }

  try {
    await gemini.connect();
    return true;
  } catch (err) {
    voiceActive = false;
    closeBtn.classList.add('hidden');
    setState('idle');
    if (err?.message === 'NO_API_KEY') {
      showError('No API key — opening dashboard.');
      setTimeout(() => window.electronAPI?.openDashboard(), 600);
    } else {
      showError(err?.message || 'Failed to connect to Gemini.');
    }
    return false;
  }
}

function closeAll() {
  voiceActive    = false;
  isPanelOpen    = false;
  isMuted        = false;
  showingInput   = false;
  pillWaveEl.classList.remove('visible');

  if (stopVisualizer) { stopVisualizer(); stopVisualizer = null; }
  if (gemini)         { gemini.disconnect(); gemini = null; }

  panel.classList.add('hidden');
  textInputRow.classList.add('hidden');
  closeBtn.classList.add('hidden');
  expandBtn.classList.remove('open');

  setState('idle'); // also syncs pill size back down via syncPillSize()
  scheduleAutoHide();
}

// ──── Event listeners ──────────────────────────────────────────────────────────
orbWrap.addEventListener('click', async () => {
  if (!voiceActive) {
    await activateVoice();
  } else if (gemini && gemini.connected) {
    // Toggle mute/unmute
    isMuted = !isMuted;
    if (isMuted) gemini.mute(); else gemini.unmute();
    // Update orb class and icon
    orbWrap.className = `orb-wrap ${currentState}${isMuted ? ' muted' : ''}`;
    const pathEl = orbIcon.querySelector('path');
    if (pathEl) pathEl.setAttribute('d', isMuted ? MIC_MUTED_PATH : (ICONS[currentState] || ICONS.idle));
  } else {
    await ensureConnected();
  }
});

expandBtn.addEventListener('click', () => {
  if (isPanelOpen) closePanel(); else openPanel();
});

closeBtn.addEventListener('click', closeAll);

peekBar.addEventListener('click', () => cancelAutoHide());

keyboardBtn.addEventListener('click', () => {
  showingInput = !showingInput;
  textInputRow.classList.toggle('hidden', !showingInput);
  if (showingInput) setTimeout(() => textInput.focus(), 40);
});

sendBtn.addEventListener('click', submitText);
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitText(); });

async function submitText() {
  const txt = textInput.value.trim();
  if (!txt) return;
  if (!gemini || !gemini.connected) {
    const ok = await ensureConnected();
    if (!ok) return;
    await new Promise(r => setTimeout(r, 600));
  }
  if (!gemini || !gemini.connected) {
    showError('Still connecting — try again in a moment.');
    return;
  }
  gemini.sendText(txt);
  textInput.value = '';
  showingInput = false;
  textInputRow.classList.add('hidden');
}

// ──── Electron IPC ────────────────────────────────────────────────────────────
if (window.electronAPI) {
  window.electronAPI.onActivate(() => { if (!voiceActive) activateVoice(); });
  window.electronAPI.onDeactivate(() => { if (voiceActive) closeAll(); });
  window.electronAPI.onPillPeeking?.(() => {});
}

// ──── Click-through: ignore mouse on transparent areas ────────────────────────
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overUI = el && el.id !== 'app' && el !== document.body && el !== document.documentElement;
  window.electronAPI?.setIgnoreMouse(!overUI);
});

// ──── Init ────────────────────────────────────────────────────────────────────
syncPillSize(); // setState('idle') below is a no-op (already the initial state) so size it directly
scheduleAutoHide();
