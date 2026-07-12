// ──── DOM refs ────────────────────────────────────────────────────────────────
const pill          = document.getElementById('pill');
const orbWrap       = document.getElementById('orb-wrap');
const orbIcon       = document.getElementById('orb-icon');
const pillWaveEl    = document.getElementById('pill-wave');
const pillLabelEl   = document.getElementById('pill-label');
const pillStatusEl  = document.getElementById('pill-status');
const expandBtn     = document.getElementById('expand-btn');
const closeBtn      = document.getElementById('close-btn');
const panel         = document.getElementById('panel');
const statusText    = document.getElementById('status-text');
const visualizer    = document.getElementById('visualizer');
const barsEl        = document.getElementById('bars');
const thinkingAnim  = document.getElementById('thinking-anim');
const speakingAnim  = document.getElementById('speaking-anim');
const waveBarsEl    = document.getElementById('wave-bars');
const idleIconEl    = document.getElementById('idle-icon');
const jarvisHintEl  = document.getElementById('jarvis-hint');
const transcriptEl  = document.getElementById('transcript');
const userTextEl    = document.getElementById('user-text');
const textInputRow  = document.getElementById('text-input-row');
const textInput     = document.getElementById('text-input');
const sendBtn       = document.getElementById('send-btn');
const errorBox      = document.getElementById('error-box');
const quickToggle   = document.getElementById('quick-toggle');
const chipRowEl     = document.getElementById('chip-row');
const navToggle     = document.getElementById('nav-toggle');
const navRowEl      = document.getElementById('nav-row');
const keyboardBtn   = document.getElementById('keyboard-btn');
const dashboardBtn  = document.getElementById('dashboard-btn');
const settingsBtn   = document.getElementById('settings-btn');

// ──── Build panel visualizer bars ─────────────────────────────────────────────
const BAR_COUNT = 16;
for (let i = 0; i < BAR_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.height = '5px';
  barsEl.appendChild(b);
}

// ──── Build speaking wave bars ─────────────────────────────────────────────────
const WAVE_COUNT = 18;
const waveColors = ['#34d399','#06b6d4','#22d3ee','#34d399'];
for (let i = 0; i < WAVE_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'wave-bar';
  const frac = i / WAVE_COUNT;
  const h = 4 + Math.sin(frac * Math.PI) * 22;
  b.style.height = `${h}px`;
  b.style.background = waveColors[Math.floor(frac * waveColors.length)];
  b.style.animationDelay = `${(frac * 0.5).toFixed(3)}s`;
  waveBarsEl.appendChild(b);
}

// ──── Build pill wave bars (100 bars -- fills full-width in wave mode) ────────
const PILL_BAR_COUNT = 100;
const pillBarEls = [];
for (let i = 0; i < PILL_BAR_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'pill-wave-bar';
  const frac = i / PILL_BAR_COUNT;
  const delay = (Math.sin(frac * Math.PI * 4) * 0.25 + 0.25).toFixed(3);
  b.style.setProperty('--delay', `${delay}s`);
  b.style.animationDelay = `${delay}s`;
  const h = 4 + Math.abs(Math.sin(frac * Math.PI * 3)) * 20;
  b.style.height = `${h}px`;
  pillWaveEl.appendChild(b);
  pillBarEls.push(b);
}

// ──── State ───────────────────────────────────────────────────────────────────
let currentState   = 'idle';
let gemini         = null;
let stopViz        = null;
let showingInput   = false;
let isPanelOpen    = false;
let isWaveMode     = false;
let transcriptText = '';

// ──── Icon paths per state ─────────────────────────────────────────────────────
const MIC_PATH = 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z';
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

const JARVIS_HINTS = {
  idle:       'TAP ORB TO SPEAK',
  connecting: 'CONNECTING...',
  listening:  'LISTENING...',
  thinking:   'THINKING...',
  speaking:   'SPEAKING',
};

// ──── setState ────────────────────────────────────────────────────────────────
function setState(state) {
  currentState = state;

  orbWrap.className = `orb-wrap ${state}`;

  const pathEl = orbIcon.querySelector('path');
  if (pathEl) pathEl.setAttribute('d', ICONS[state] || ICONS.idle);

  panel.dataset.state = state;

  if (statusText) statusText.textContent = STATUS_LABELS[state];
  if (pillStatusEl) pillStatusEl.textContent = STATUS_LABELS[state];

  const isIdle = state === 'idle' || state === 'connecting';
  visualizer.classList.toggle('hidden',   state !== 'listening');
  thinkingAnim.classList.toggle('hidden', state !== 'thinking');
  speakingAnim.classList.toggle('hidden', state !== 'speaking');
  idleIconEl.classList.toggle('hidden',   !isIdle);

  if (jarvisHintEl) jarvisHintEl.textContent = JARVIS_HINTS[state] || '';

  const voiceActive = state === 'listening' || state === 'speaking';
  pillWaveEl.classList.toggle('visible', voiceActive && !isWaveMode);

  if (!isPanelOpen) {
    if (voiceActive) enterWaveMode();
    else exitWaveMode();
  }
}

// ──── Wave mode ───────────────────────────────────────────────────────────────
function enterWaveMode() {
  if (isWaveMode) return;
  isWaveMode = true;
  pill.classList.add('wave-active');
  pillWaveEl.classList.add('visible');
  window.electronAPI?.resizeWave?.();
}

function exitWaveMode() {
  if (!isWaveMode) return;
  isWaveMode = false;
  pill.classList.remove('wave-active');
  const voiceActive = currentState === 'listening' || currentState === 'speaking';
  pillWaveEl.classList.toggle('visible', voiceActive);
  window.electronAPI?.resizeCollapsed?.();
}

// ──── Panel open / close ──────────────────────────────────────────────────────
function openPanel() {
  if (isPanelOpen) return;
  isPanelOpen = true;

  if (isWaveMode) {
    isWaveMode = false;
    pill.classList.remove('wave-active');
  }

  panel.classList.remove('hidden');
  void panel.offsetWidth;
  expandBtn.classList.add('open');
  closeBtn.classList.remove('hidden');
  window.electronAPI?.resizeExpanded?.();
}

function closePanel() {
  if (!isPanelOpen) return;
  isPanelOpen = false;

  panel.classList.add('hidden');
  expandBtn.classList.remove('open');
  closeBtn.classList.add('hidden');
  showingInput = false;
  textInputRow.classList.add('hidden');

  const voiceActive = currentState === 'listening' || currentState === 'speaking';
  if (voiceActive) enterWaveMode();
  else window.electronAPI?.resizeCollapsed?.();
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

// ──── Visualizer update ───────────────────────────────────────────────────────
function onVisualizerBars(bars) {
  const barEls = barsEl.querySelectorAll('.bar');
  bars.forEach((h, i) => { if (barEls[i]) barEls[i].style.height = `${h}px`; });

  pillBarEls.forEach((el, i) => {
    const idx = Math.floor((i / PILL_BAR_COUNT) * bars.length);
    el.style.height = `${Math.max(3, (bars[idx] || 0) * 0.85)}px`;
  });
}

// ──── API key check ────────────────────────────────────────────────────────────
async function hasApiKey() {
  let key = '';
  try { key = await window.electronAPI?.storeGet('settings', 'apiKey') || ''; } catch {}
  if (!key) key = localStorage.getItem('gemini_api_key') || '';
  return !!key;
}

// ──── Ensure connected ────────────────────────────────────────────────────────
async function ensureConnected() {
  if (gemini && gemini.connected) return true;

  if (!(await hasApiKey())) {
    showError('No Gemini API key -- open Dashboard > Settings.');
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
      onReady:       () => { stopViz = gemini.startVisualizer(onVisualizerBars); },
    });
  }

  try {
    await gemini.connect();
    return true;
  } catch (err) {
    setState('idle');
    if (err?.message === 'NO_API_KEY') {
      showError('No API key -- open Dashboard > Settings.');
      setTimeout(() => window.electronAPI?.openDashboard(), 600);
    } else {
      showError(err?.message || 'Failed to connect to Gemini.');
    }
    return false;
  }
}

function disconnectVoice() {
  if (stopViz) { stopViz(); stopViz = null; }
  if (gemini)  { gemini.disconnect(); gemini = null; }
  transcriptText = '';
  transcriptEl.textContent = '';
  transcriptEl.classList.add('hidden');
  userTextEl.classList.add('hidden');
  errorBox.classList.add('hidden');
  setState('idle');
}

// ──── Orb click: toggle voice ─────────────────────────────────────────────────
orbWrap.addEventListener('click', async () => {
  if (gemini && gemini.connected) {
    disconnectVoice();
  } else {
    await ensureConnected();
  }
});

// ──── Expand / collapse panel ─────────────────────────────────────────────────
expandBtn.addEventListener('click', () => {
  if (isPanelOpen) closePanel();
  else openPanel();
});

closeBtn.addEventListener('click', closePanel);

// ──── Collapsible sections ────────────────────────────────────────────────────
quickToggle.addEventListener('click', () => {
  const nowOpen = chipRowEl.classList.contains('hidden');
  chipRowEl.classList.toggle('hidden', !nowOpen);
  quickToggle.classList.toggle('open', nowOpen);
});

navToggle.addEventListener('click', () => {
  const nowOpen = navRowEl.classList.contains('hidden');
  navRowEl.classList.toggle('hidden', !nowOpen);
  navToggle.classList.toggle('open', nowOpen);
});

// ──── Text input ──────────────────────────────────────────────────────────────
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
    showError('Still connecting -- try again in a moment.');
    return;
  }

  gemini.sendText(txt);
  textInput.value = '';
  showingInput = false;
  textInputRow.classList.add('hidden');
}

// ──── Quick action chips ──────────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(btn => {
  btn.addEventListener('click', async () => {
    const a = btn.dataset.quick;
    const api = window.electronAPI;
    try {
      if (a === 'play_pause')     await api.mediaControl('play_pause');
      else if (a === 'next')      await api.mediaControl('next');
      else if (a === 'agent')     api.openAgent();
      else if (a === 'ask')       api.openAsk();
      else if (a === 'lock')      await api.lockScreen();
      else if (a === 'clipboard') {
        const r = await api.readClipboard();
        appendTranscript(`Clipboard: ${(r.output || '').slice(0, 200)}\n`);
      }
      btn.style.background = 'rgba(52,211,153,0.28)';
      setTimeout(() => { btn.style.background = ''; }, 280);
    } catch (e) { showError(e.message); }
  });
});

// ──── Dashboard / Settings ────────────────────────────────────────────────────
dashboardBtn?.addEventListener('click', () => window.electronAPI?.openDashboard());
settingsBtn?.addEventListener('click',  () => window.electronAPI?.openDashboard());

// ──── Electron IPC ────────────────────────────────────────────────────────────
if (window.electronAPI) {
  window.electronAPI.onActivate(() => {
    if (!isPanelOpen) openPanel();
    ensureConnected();
  });
  window.electronAPI.onDeactivate(() => {
    disconnectVoice();
    closePanel();
  });
}

// ──── Click-through: ignore mouse on transparent areas ────────────────────────
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overUI = el && el.id !== 'app' && el !== document.body && el !== document.documentElement;
  window.electronAPI?.setIgnoreMouse(!overUI);
});

// ──── Init ────────────────────────────────────────────────────────────────────
setState('idle');
