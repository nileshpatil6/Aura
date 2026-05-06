// ──── DOM refs ────────────────────────────────────────────────────────────────
const pill          = document.getElementById('pill');
const pillLabel     = document.getElementById('pill-label');
const closeBtn      = document.getElementById('close-btn');
const orbEl         = document.getElementById('orb');
const panel         = document.getElementById('panel');
const statusText    = document.getElementById('status-text');
const visualizer    = document.getElementById('visualizer');
const barsEl        = document.getElementById('bars');
const thinkingAnim  = document.getElementById('thinking-anim');
const speakingAnim  = document.getElementById('speaking-anim');
const transcriptEl  = document.getElementById('transcript');
const userTextEl    = document.getElementById('user-text');
const textInputRow  = document.getElementById('text-input-row');
const textInput     = document.getElementById('text-input');
const sendBtn       = document.getElementById('send-btn');
const errorBox      = document.getElementById('error-box');
const keyboardBtn   = document.getElementById('keyboard-btn');

// Build waveform bars
const BAR_COUNT = 20;
for (let i = 0; i < BAR_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.height = '6px';
  barsEl.appendChild(b);
}

// Build speaking wave bars
const WAVE_COUNT = 22;
const waveBarsEl = document.getElementById('wave-bars');
for (let i = 0; i < WAVE_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'wave-bar';
  const h = 4 + Math.sin((i / WAVE_COUNT) * Math.PI) * 22;
  b.style.height = `${h}px`;
  b.style.animationDelay = `${(i * 0.028).toFixed(3)}s`;
  waveBarsEl.appendChild(b);
}

// ──── state ──────────────────────────────────────────────────────────────────
let isOpen = false;
let currentState = 'idle';
let gemini = null;
let stopVisualizer = null;
let showingTextInput = false;
let transcriptText = '';

// ──── state machine ───────────────────────────────────────────────────────────
function setState(state) {
  currentState = state;
  orbEl.className = `orb ${state}`;

  const labels = {
    idle: 'Ctrl+Space',
    listening: 'Listening...',
    thinking: 'Thinking...',
    speaking: 'Speaking...',
  };
  pillLabel.textContent = isOpen ? '' : labels[state] || state;
  statusText.textContent = labels[state] || state;

  // Show/hide animations
  visualizer.classList.toggle('hidden', state !== 'listening');
  thinkingAnim.classList.toggle('hidden', state !== 'thinking');
  speakingAnim.classList.toggle('hidden', state !== 'speaking');

  // Orb icon update
  const icons = {
    listening: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z',
    speaking: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    thinking: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z',
    idle: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z',
  };
  const pathEl = orbEl.querySelector('.orb-icon path');
  if (pathEl && icons[state]) pathEl.setAttribute('d', icons[state]);
}

function setTranscript(text) {
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
  errorBox.textContent = '⚠️ ' + msg;
  errorBox.classList.remove('hidden');
}

// ──── open / close ────────────────────────────────────────────────────────────
async function openAssistant() {
  isOpen = true;
  transcriptText = '';
  transcriptEl.textContent = '';
  transcriptEl.classList.add('hidden');
  userTextEl.classList.add('hidden');
  errorBox.classList.add('hidden');

  pillLabel.textContent = '';
  closeBtn.classList.remove('hidden');
  panel.classList.remove('hidden');
  window.electronAPI?.resizeExpanded();

  gemini = new GeminiLive({
    onStateChange: setState,
    onTranscript: setTranscript,
    onUserText: setUserText,
    onError: showError,
  });

  setState('listening');

  try {
    await gemini.connect();

    // Start mic visualizer after a short delay to let recording boot up
    setTimeout(() => {
      if (gemini && gemini.stream) {
        stopVisualizer = gemini.startVisualizer((bars) => {
          const barEls = barsEl.querySelectorAll('.bar');
          bars.forEach((h, i) => {
            if (barEls[i]) barEls[i].style.height = `${h}px`;
          });
        });
      }
    }, 1200);
  } catch (e) {
    showError(e.message || 'Failed to connect to Gemini.');
  }
}

function closeAssistant() {
  isOpen = false;
  showingTextInput = false;

  if (stopVisualizer) { stopVisualizer(); stopVisualizer = null; }
  if (gemini) { gemini.disconnect(); gemini = null; }

  panel.classList.add('hidden');
  textInputRow.classList.add('hidden');
  closeBtn.classList.add('hidden');
  pillLabel.textContent = 'Ctrl+Space';
  window.electronAPI?.resizeCollapsed();
  setState('idle');
}

// ──── event listeners ─────────────────────────────────────────────────────────
orbEl.addEventListener('click', () => {
  if (!isOpen) openAssistant();
});

closeBtn.addEventListener('click', closeAssistant);

keyboardBtn.addEventListener('click', () => {
  showingTextInput = !showingTextInput;
  textInputRow.classList.toggle('hidden', !showingTextInput);
  if (showingTextInput) setTimeout(() => textInput.focus(), 50);
});

sendBtn.addEventListener('click', submitText);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitText();
});

function submitText() {
  const txt = textInput.value.trim();
  if (!txt || !gemini) return;
  gemini.sendText(txt);
  textInput.value = '';
  showingTextInput = false;
  textInputRow.classList.add('hidden');
}

// ──── Electron IPC ────────────────────────────────────────────────────────────
if (window.electronAPI) {
  window.electronAPI.onActivate(() => {
    if (!isOpen) openAssistant();
  });
  window.electronAPI.onDeactivate(() => {
    if (isOpen) closeAssistant();
  });
}

// ──── init ────────────────────────────────────────────────────────────────────
setState('idle');
