// ──── DOM refs ────────────────────────────────────────────────────────────────
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
let voiceActive    = false;  // live gemini session active
let isPanelOpen    = false;  // expanded panel visible
let currentState   = 'idle';
let gemini         = null;
let stopVisualizer = null;
let showingInput   = false;
let transcriptText = '';
let autoHideTimer  = null;  // 20s idle -> edge hide

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

// ──── Set state ────────────────────────────────────────────────────────────────
function setState(state) {
  currentState = state;
  orbWrap.className = `orb-wrap ${state}`;
  panel.dataset.state = state;
  const pathEl = orbIcon.querySelector('path');
  if (pathEl) pathEl.setAttribute('d', ICONS[state] || ICONS.idle);
  statusText.textContent = STATUS_LABELS[state];

  visualizer.classList.toggle('hidden',   state !== 'listening');
  thinkingAnim.classList.toggle('hidden', state !== 'thinking');
  speakingAnim.classList.toggle('hidden', state !== 'speaking');

  pillWaveEl.classList.toggle('visible', isPanelOpen && state === 'listening');
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
    el.style.height = `${Math.max(3, bars[idx] * 0.7)}px`;
  });
}

// ──── API key check (stored by dashboard or legacy localStorage) ─────────────
async function hasApiKey() {
  let key = '';
  try { key = await window.electronAPI?.storeGet('settings', 'apiKey') || ''; } catch {}
  if (!key) key = localStorage.getItem('gemini_api_key') || '';
  return !!key;
}

// Settings button opens the full dashboard (which has the Settings tab)
settingsBtn.addEventListener('click', () => window.electronAPI?.openDashboard());

// Dashboard button
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
      window.electronAPI?.pillAutoHide();
    }
  }, 20000);
}

function cancelAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = null;
  window.electronAPI?.pillShow();
}

// ──── Panel open / close (independent of voice) ───────────────────────────────
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
  if (!voiceActive) window.electronAPI?.resizeCollapsed();
}

// ──── Voice activate (orb click) ──────────────────────────────────────────────
async function activateVoice() {
  cancelAutoHide();
  voiceActive = true;
  transcriptText = '';
  transcriptEl.textContent = '';
  transcriptEl.classList.add('hidden');
  userTextEl.classList.add('hidden');
  errorBox.classList.add('hidden');
  closeBtn.classList.remove('hidden');
  await ensureConnected();
}

// Connect (or reconnect) the live API on demand. Surfaces errors visibly.
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
      onReady: () => { stopVisualizer = gemini.startVisualizer(onVisualizerBars); },
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
  voiceActive = false;
  isPanelOpen = false;
  showingInput = false;
  pillWaveEl.classList.remove('visible');

  if (stopVisualizer) { stopVisualizer(); stopVisualizer = null; }
  if (gemini)         { gemini.disconnect(); gemini = null; }

  panel.classList.add('hidden');
  textInputRow.classList.add('hidden');
  closeBtn.classList.add('hidden');
  expandBtn.classList.remove('open');

  window.electronAPI?.resizeCollapsed();
  setState('idle');

  // After 20s idle, auto-hide pill to edge
  scheduleAutoHide();
}

// ──── Event listeners ──────────────────────────────────────────────────────────
orbWrap.addEventListener('click', async () => {
  if (!voiceActive) {
    await activateVoice();
  } else if (!gemini || !gemini.connected) {
    await ensureConnected();
  }
});

expandBtn.addEventListener('click', () => {
  if (isPanelOpen) closePanel(); else openPanel();
});

closeBtn.addEventListener('click', closeAll);

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

  // If not yet connected, try to connect first
  if (!gemini || !gemini.connected) {
    const ok = await ensureConnected();
    if (!ok) return;
    // Give the setup message a beat to land before we send the first text
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

  // Peek indicator: show glowing line when pill is hidden and user nears top
  window.electronAPI.onPillPeeking?.((isPeeking) => {
    if (peekBar) peekBar.classList.toggle('hidden', !isPeeking);
  });
}

// ──── Click-through: ignore mouse on transparent areas ────────────────────────
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overUI = el && el.id !== 'app' && el !== document.body && el !== document.documentElement;
  window.electronAPI?.setIgnoreMouse(!overUI);
});

// ──── Launch wave (one-time startup animation) ────────────────────────────────
(function initLaunchWave() {
  const launchWave = document.getElementById('launch-wave');
  const launchBars = document.getElementById('launch-bars');
  if (!launchWave || !launchBars) return;

  // Build 80 animated bars
  const BAR_N = 80;
  for (let i = 0; i < BAR_N; i++) {
    const b = document.createElement('div');
    b.className = 'launch-bar';
    const frac = i / BAR_N;
    // Staggered delays create a rolling sine-wave feel
    const delay = (Math.sin(frac * Math.PI * 5) * 0.3 + 0.35).toFixed(3);
    b.style.setProperty('--d', `${delay}s`);
    b.style.animationDelay = `${(frac * 0.4).toFixed(3)}s`;
    launchBars.appendChild(b);
  }

  if (window.electronAPI?.onLaunchWaveStart) {
    window.electronAPI.onLaunchWaveStart(() => {
      launchWave.classList.remove('hidden');
    });
    window.electronAPI.onLaunchWaveEnd(() => {
      launchWave.classList.add('fade-out');
      setTimeout(() => launchWave.classList.add('hidden'), 620);
    });
  }
})();

// ──── Init ────────────────────────────────────────────────────────────────────
setState('idle');
