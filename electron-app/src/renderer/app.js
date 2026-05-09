// ──── DOM refs ────────────────────────────────────────────────────────────────
const closeBtn      = document.getElementById('close-btn');
const orbWrap       = document.getElementById('orb-wrap');
const orbIcon       = document.getElementById('orb-icon');
const pillWaveEl    = document.getElementById('pill-wave');
const panel         = document.getElementById('panel');
const statusText    = document.getElementById('status-text');
const visualizer    = document.getElementById('visualizer');
const barsEl        = document.getElementById('bars');
const thinkingAnim  = document.getElementById('thinking-anim');
const speakingAnim  = document.getElementById('speaking-anim');
const waveBarsEl    = document.getElementById('wave-bars');
const transcriptEl  = document.getElementById('transcript');
const userTextEl    = document.getElementById('user-text');
const textInputRow  = document.getElementById('text-input-row');
const textInput     = document.getElementById('text-input');
const sendBtn       = document.getElementById('send-btn');
const errorBox      = document.getElementById('error-box');
const keyboardBtn   = document.getElementById('keyboard-btn');

// ──── Build panel visualizer bars ─────────────────────────────────────────────
const BAR_COUNT = 22;
for (let i = 0; i < BAR_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.height = '5px';
  barsEl.appendChild(b);
}

// ──── Build pill mini waveform bars ───────────────────────────────────────────
const PILL_BAR_COUNT = 12;
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
const waveColors = ['#34d399','#06b6d4','#22d3ee','#34d399'];
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
let isOpen         = false;
let currentState   = 'idle';
let gemini         = null;
let stopVisualizer = null;
let showingInput   = false;
let transcriptText = '';

// ──── Icon paths per state ─────────────────────────────────────────────────────
const ICONS = {
  idle:      'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z',
  listening: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z',
  thinking:  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z',
  speaking:  'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
};

const STATUS_LABELS = {
  idle:      '',
  listening: 'Listening…',
  thinking:  'Thinking…',
  speaking:  'Speaking…',
};

// ──── Set state ────────────────────────────────────────────────────────────────
function setState(state) {
  currentState = state;
  orbWrap.className = `orb-wrap ${state}`;
  const pathEl = orbIcon.querySelector('path');
  if (pathEl) pathEl.setAttribute('d', ICONS[state] || ICONS.idle);
  statusText.textContent = STATUS_LABELS[state];

  // Panel sub-sections
  visualizer.classList.toggle('hidden',   state !== 'listening');
  thinkingAnim.classList.toggle('hidden', state !== 'thinking');
  speakingAnim.classList.toggle('hidden', state !== 'speaking');

  // Pill mini waveform: visible when open and listening
  pillWaveEl.classList.toggle('visible', isOpen && state === 'listening');
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

// ──── Visualizer update (shared for panel bars + pill mini bars) ───────────────
function onVisualizerBars(bars) {
  // Panel bars (full 20 bars)
  const barEls = barsEl.querySelectorAll('.bar');
  bars.forEach((h, i) => { if (barEls[i]) barEls[i].style.height = `${h}px`; });

  // Pill mini bars (downsample to PILL_BAR_COUNT)
  pillBarEls.forEach((el, i) => {
    const idx = Math.floor((i / PILL_BAR_COUNT) * bars.length);
    el.style.height = `${Math.max(3, bars[idx] * 0.7)}px`;
  });
}

// ──── Open / Close ────────────────────────────────────────────────────────────
async function openAssistant() {
  isOpen = true;
  transcriptText = '';
  transcriptEl.textContent = '';
  transcriptEl.classList.add('hidden');
  userTextEl.classList.add('hidden');
  errorBox.classList.add('hidden');
  closeBtn.classList.remove('hidden');

  panel.classList.remove('hidden');
  void panel.offsetWidth;
  panel.style.animation = 'none';
  void panel.offsetWidth;
  panel.style.animation = '';

  window.electronAPI?.resizeExpanded();

  gemini = new GeminiLive({
    onStateChange: setState,
    onTranscript:  appendTranscript,
    onUserText:    setUserText,
    onError:       showError,
    onReady: () => {
      // Stream is live - start visualizer immediately
      stopVisualizer = gemini.startVisualizer(onVisualizerBars);
    },
  });

  setState('listening');

  try {
    await gemini.connect();
  } catch (err) {
    showError(err?.message || 'Failed to connect to Gemini.');
  }
}

function closeAssistant() {
  isOpen = false;
  showingInput = false;
  pillWaveEl.classList.remove('visible');

  if (stopVisualizer) { stopVisualizer(); stopVisualizer = null; }
  if (gemini)         { gemini.disconnect(); gemini = null; }

  panel.classList.add('hidden');
  textInputRow.classList.add('hidden');
  closeBtn.classList.add('hidden');

  window.electronAPI?.resizeCollapsed();
  setState('idle');
}

// ──── Event listeners ──────────────────────────────────────────────────────────
orbWrap.addEventListener('click', () => { if (!isOpen) openAssistant(); });
closeBtn.addEventListener('click', closeAssistant);

keyboardBtn.addEventListener('click', () => {
  showingInput = !showingInput;
  textInputRow.classList.toggle('hidden', !showingInput);
  if (showingInput) setTimeout(() => textInput.focus(), 40);
});

sendBtn.addEventListener('click', submitText);
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitText(); });

function submitText() {
  const txt = textInput.value.trim();
  if (!txt || !gemini) return;
  gemini.sendText(txt);
  textInput.value = '';
  showingInput = false;
  textInputRow.classList.add('hidden');
}

// ──── Electron IPC ────────────────────────────────────────────────────────────
if (window.electronAPI) {
  window.electronAPI.onActivate(() => { if (!isOpen) openAssistant(); });
  window.electronAPI.onDeactivate(() => { if (isOpen) closeAssistant(); });
}

// ──── Init ────────────────────────────────────────────────────────────────────
setState('idle');
