// ═══════════════════════════════════════════════════════════════════
// AURA DASHBOARD — JS controller
// ═══════════════════════════════════════════════════════════════════
const api = window.electronAPI;

// ──── Tab nav ────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'system') systemTab.kick();
    if (tab === 'chat') chatTab.render();
    if (tab === 'activity') activityTab.render();
    if (tab === 'macros') macrosTab.render();
    if (tab === 'memory') memoryTab.load();
    if (tab === 'settings') settingsTab.load();
    if (tab === 'recall') recallTab.load();
  });
});

// ──── Window controls ────────────────────────────────────────────────
document.getElementById('min-btn').onclick = () => api.minimizeDashboard?.();
document.getElementById('max-btn').onclick = () => api.maximizeDashboard?.();
document.getElementById('close-btn').onclick = () => api.closeDashboard?.();

// ──── Clock ──────────────────────────────────────────────────────────
function tickClock() {
  const d = new Date();
  document.getElementById('clock').textContent =
    d.toTimeString().slice(0, 8);
}
setInterval(tickClock, 1000); tickClock();

// ──── Status pill ────────────────────────────────────────────────────
function setStatus(label, mode) {
  const pill = document.getElementById('status-pill');
  document.getElementById('status-label').textContent = label;
  pill.classList.remove('live', 'error', 'running', 'done');
  if (mode) pill.classList.add(mode);
}
setStatus('READY', 'live');

// ═══════════════════════════════════════════════════════════════════
// CHAT TAB
// ═══════════════════════════════════════════════════════════════════
const chatTab = {
  history: [],
  filter: '',
  async load() {
    this.history = await api.storeGet('history') || [];
    this.render();
  },
  render() {
    const list = document.getElementById('chat-list');
    const q = this.filter.toLowerCase();
    list.innerHTML = '';
    const items = q
      ? this.history.filter(m => m.text?.toLowerCase().includes(q))
      : this.history.slice(-200);
    items.forEach(m => {
      const div = document.createElement('div');
      div.className = `chat-msg ${m.role}`;
      const meta = document.createElement('div');
      meta.className = 'chat-meta';
      meta.textContent = `${m.role} · ${new Date(m.ts).toLocaleTimeString()}`;
      const body = document.createElement('div');
      body.textContent = m.text || '';
      div.appendChild(meta);
      div.appendChild(body);
      list.appendChild(div);
    });
    list.scrollTop = list.scrollHeight;
  },
  async send(text) {
    const userMsg = await api.storePush('history', { role: 'user', text });
    this.history.push(userMsg);
    this.render();
    setStatus('THINKING', '');
    try {
      const reply = await sendToGemini(text);
      const botMsg = await api.storePush('history', { role: 'assistant', text: reply });
      this.history.push(botMsg);
      this.render();
      setStatus('READY', 'live');
    } catch (err) {
      const errMsg = await api.storePush('history', { role: 'assistant', text: `Error: ${err.message}` });
      this.history.push(errMsg);
      this.render();
      setStatus('ERROR', 'error');
    }
  },
};

const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatSearch = document.getElementById('chat-search');
const newChatBtn = document.getElementById('new-chat-btn');

function submitChat() {
  const t = chatInput.value.trim();
  if (!t) return;
  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatTab.send(t);
}
chatSend.onclick = submitChat;
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitChat(); }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(160, chatInput.scrollHeight) + 'px';
});
chatSearch.addEventListener('input', () => { chatTab.filter = chatSearch.value; chatTab.render(); });
newChatBtn.onclick = async () => { await api.storeClear('history'); chatTab.history = []; chatTab.render(); };

// Direct REST call to Gemini 3 Flash for text-only chat
async function sendToGemini(text) {
  const apiKey = await api.storeGet('settings', 'apiKey');
  if (!apiKey) throw new Error('No API key set. Open Settings and add one.');
  const memory = await api.storeGet('memory') || {};
  const sysParts = ['You are Aura, a powerful Windows desktop AI assistant. Be concise and direct.'];
  if (memory.name) sysParts.push(`User's name: ${memory.name}`);
  if (memory.notes?.length) sysParts.push(`Notes about the user:\n${memory.notes.join('\n')}`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sysParts.join('\n\n') }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
}

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY TAB
// ═══════════════════════════════════════════════════════════════════
const activityTab = {
  list: [],
  filter: 'all',
  async load() {
    this.list = await api.storeGet('activity') || [];
    this.render();
  },
  render() {
    const feed = document.getElementById('activity-feed');
    feed.innerHTML = '';
    const items = this.filter === 'all'
      ? this.list.slice().reverse()
      : this.list.filter(a => a.kind === this.filter).reverse();
    if (!items.length) {
      feed.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-mute); font-family:var(--mono); font-size:11px;">No activity yet.</div>';
      return;
    }
    items.forEach(a => {
      const row = document.createElement('div');
      row.className = 'act-row';
      const t = document.createElement('div'); t.className = 'act-time';
      t.textContent = new Date(a.ts).toLocaleTimeString();
      const k = document.createElement('div'); k.className = `act-kind ${a.kind}`;
      k.textContent = a.kind;
      const s = document.createElement('div'); s.className = 'act-summary';
      s.textContent = a.summary || '';
      row.append(t, k, s);
      feed.appendChild(row);
    });
  },
};
document.getElementById('activity-filter').onchange = (e) => {
  activityTab.filter = e.target.value;
  activityTab.render();
};
document.getElementById('activity-clear').onclick = async () => {
  if (!confirm('Clear all activity?')) return;
  await api.storeClear('activity');
  activityTab.list = [];
  activityTab.render();
};

// ═══════════════════════════════════════════════════════════════════
// SYSTEM TAB
// ═══════════════════════════════════════════════════════════════════
const systemTab = {
  cpuHistory: new Array(60).fill(0),
  timer: null,
  kick() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 2200);
  },
  stop() { clearInterval(this.timer); this.timer = null; },
  async tick() {
    // CPU
    const cpu = await api.runPowerShell(`(Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples.CookedValue`);
    const cpuPct = Math.round(parseFloat(cpu.output) || 0);
    this.cpuHistory.shift();
    this.cpuHistory.push(cpuPct);
    this.drawCpu();
    document.getElementById('cpu-val').textContent = `${cpuPct}%`;
    document.getElementById('mini-cpu').textContent = `${cpuPct}%`;
    const hudCpu = document.getElementById('hud-cpu-v');
    if (hudCpu) hudCpu.textContent = `${cpuPct}%`;

    // RAM
    const memInfo = await api.getSystemInfo('memory');
    const mMatch = memInfo.output?.match(/([\d.]+)GB used \/ ([\d.]+)GB total \((\d+)%/);
    if (mMatch) {
      const pct = +mMatch[3];
      document.getElementById('ram-val').textContent = `${pct}%`;
      document.getElementById('ram-sub').textContent = `${mMatch[1]} / ${mMatch[2]} GB`;
      document.getElementById('ram-ring').style.strokeDashoffset = (264 - (264 * pct / 100)).toFixed(0);
      document.getElementById('mini-ram').textContent = `${pct}%`;
      const hudRam = document.getElementById('hud-ram-v');
      if (hudRam) hudRam.textContent = `${pct}%`;
    }

    // Disk
    const disk = await api.getSystemInfo('disk');
    const dl = document.getElementById('disk-list');
    dl.innerHTML = '';
    (disk.output || '').split('\n').slice(2).forEach(line => {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 3) return;
      const [name, used, free] = [cols[0], parseFloat(cols[1]), parseFloat(cols[2])];
      if (isNaN(used) || isNaN(free)) return;
      const total = used + free;
      const pct = total > 0 ? (used / total) * 100 : 0;
      const row = document.createElement('div');
      row.className = 'disk-row';
      row.innerHTML = `<div style="color:var(--cyan)">${name}:</div>
        <div class="bar-wrap"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div style="color:var(--text-dim)">${used.toFixed(0)}/${total.toFixed(0)}G</div>`;
      dl.appendChild(row);
    });

    // Battery
    const bat = await api.getSystemInfo('battery');
    const bMatch = bat.output?.match(/Battery: (\d+)% - (\w+)/);
    if (bMatch) {
      document.getElementById('battery-val').textContent = `${bMatch[1]}%`;
      document.getElementById('battery-sub').textContent = bMatch[2];
    } else {
      document.getElementById('battery-val').textContent = '—';
      document.getElementById('battery-sub').textContent = 'desktop';
    }

    // WiFi
    const wifi = await api.getSystemInfo('wifi');
    const wMatch = wifi.output?.match(/Connected to: (.+) \((\w+)\)/);
    if (wMatch) {
      document.getElementById('wifi-val').textContent = wMatch[1].trim().slice(0, 14);
      document.getElementById('wifi-sub').textContent = wMatch[2];
      document.getElementById('mini-net').textContent = wMatch[2].slice(0, 4);
    }

    // Processes
    const procs = await api.getSystemInfo('processes');
    const pl = document.getElementById('proc-list');
    pl.innerHTML = '';
    (procs.output || '').split('\n').slice(2, 7).forEach(line => {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 3) return;
      const row = document.createElement('div');
      row.className = 'proc-row';
      row.innerHTML = `<div style="color:var(--text)">${cols[0]}</div>
        <div style="color:var(--cyan); text-align:right">${cols[1]}s</div>
        <div style="color:var(--purple); text-align:right">${cols[2]}M</div>`;
      pl.appendChild(row);
    });
  },
  drawCpu() {
    const canvas = document.getElementById('cpu-graph');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Grid
    ctx.strokeStyle = 'rgba(0,217,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // Line
    const step = w / (this.cpuHistory.length - 1);
    ctx.strokeStyle = '#00d9ff';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#00d9ff';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    this.cpuHistory.forEach((v, i) => {
      const x = i * step;
      const y = h - (v / 100) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Fill
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0,217,255,0.32)');
    grad.addColorStop(1, 'rgba(0,217,255,0)');
    ctx.fillStyle = grad;
    ctx.fill();
  },
};

// ═══════════════════════════════════════════════════════════════════
// MACROS TAB
// ═══════════════════════════════════════════════════════════════════
const macrosTab = {
  list: [],
  async load() {
    this.list = await api.storeGet('automations') || [];
    if (this.list.length === 0) {
      // Seed with sample macros
      const samples = [
        { name: 'Morning routine', desc: 'Open mail, Slack, calendar', goal: 'Open Outlook, Slack, and Google Calendar' },
        { name: 'Focus mode', desc: 'Close distractions, open VS Code', goal: 'Close Discord and Slack, open VS Code' },
        { name: 'Take a break', desc: 'Lock screen', goal: 'Lock the Windows screen' },
      ];
      for (const s of samples) await api.storePush('automations', s);
      this.list = await api.storeGet('automations');
    }
    this.render();
  },
  render() {
    const grid = document.getElementById('macro-grid');
    grid.innerHTML = '';
    this.list.forEach(m => {
      const card = document.createElement('div');
      card.className = 'macro-card';
      const name = document.createElement('div'); name.className = 'macro-name'; name.textContent = m.name;
      const desc = document.createElement('div'); desc.className = 'macro-desc'; desc.textContent = m.desc || m.goal;
      const actions = document.createElement('div'); actions.className = 'macro-actions';
      actions.innerHTML = `
        <button class="btn-primary run" data-id="${m.id}">Run</button>
        <button class="btn-ghost edit" data-id="${m.id}">Edit</button>
        <button class="btn-ghost del" data-id="${m.id}" style="color:var(--red);border-color:rgba(255,59,107,0.3)">×</button>`;
      card.append(name, desc, actions);
      grid.appendChild(card);
    });
    grid.querySelectorAll('.run').forEach(b => b.onclick = (e) => this.run(e.target.dataset.id));
    grid.querySelectorAll('.edit').forEach(b => b.onclick = (e) => this.edit(e.target.dataset.id));
    grid.querySelectorAll('.del').forEach(b => b.onclick = (e) => this.del(e.target.dataset.id));
  },
  async run(id) {
    const m = this.list.find(x => x.id === id);
    if (!m) return;
    await api.storePush('activity', { kind: 'command', summary: `Run macro: ${m.name}` });
    // Open Agent Console with the macro's goal pre-filled — actual autonomous execution
    api.openAgentWithGoal(m.goal);
  },
  edit(id) {
    const m = this.list.find(x => x.id === id);
    if (!m) return;
    const name = prompt('Macro name:', m.name); if (name == null) return;
    const goal = prompt('Goal (plain English):', m.goal); if (goal == null) return;
    const desc = prompt('Short description:', m.desc || ''); if (desc == null) return;
    Object.assign(m, { name, goal, desc });
    api.storeSet('automations', this.list).then(() => this.render());
  },
  async del(id) {
    if (!confirm('Delete this macro?')) return;
    await api.storeRemove('automations', id);
    this.list = await api.storeGet('automations') || [];
    this.render();
  },
};
document.getElementById('macro-new').onclick = async () => {
  const name = prompt('Macro name:'); if (!name) return;
  const goal = prompt('Goal (plain English):'); if (!goal) return;
  const desc = prompt('Short description:', '') || '';
  await api.storePush('automations', { name, goal, desc });
  macrosTab.list = await api.storeGet('automations');
  macrosTab.render();
};

// ═══════════════════════════════════════════════════════════════════
// MEMORY TAB
// ═══════════════════════════════════════════════════════════════════
const memoryTab = {
  async load() {
    const mem = await api.storeGet('memory') || {};
    document.getElementById('mem-name').value = mem.name || '';
    document.getElementById('mem-notes').value = (mem.notes || []).join('\n');
  },
};
document.getElementById('mem-save').onclick = async () => {
  const name = document.getElementById('mem-name').value.trim();
  const notes = document.getElementById('mem-notes').value.split('\n').filter(Boolean);
  await api.storeSet('memory', { name, notes });
  flashSave();
};

// ═══════════════════════════════════════════════════════════════════
// SETTINGS TAB
// ═══════════════════════════════════════════════════════════════════
const settingsTab = {
  async load() {
    const s = await api.storeGet('settings') || {};
    document.getElementById('set-api-key').value = s.apiKey || '';
    document.getElementById('set-voice').value = s.voice || 'Aoede';
    document.getElementById('set-hotkey').value = s.hotkey || 'Alt+Space';
    document.getElementById('set-verbose').checked = !!s.verboseLogging;
    document.getElementById('set-autostart').checked = !!s.autoStart;
    document.getElementById('set-ptt').checked = !!s.pushToTalk;
  },
};
document.getElementById('toggle-key').onclick = () => {
  const el = document.getElementById('set-api-key');
  el.type = el.type === 'password' ? 'text' : 'password';
};
document.getElementById('set-save').onclick = async () => {
  const s = {
    apiKey: document.getElementById('set-api-key').value.trim(),
    voice: document.getElementById('set-voice').value,
    hotkey: document.getElementById('set-hotkey').value,
    verboseLogging: document.getElementById('set-verbose').checked,
    autoStart: document.getElementById('set-autostart').checked,
    pushToTalk: document.getElementById('set-ptt').checked,
  };
  await api.storeSet('settings', s);
  flashSave();
};
document.getElementById('reset-history').onclick = async () => {
  if (!confirm('Clear all conversation history?')) return;
  await api.storeClear('history');
  chatTab.history = [];
  chatTab.render();
};
document.getElementById('reset-activity').onclick = async () => {
  if (!confirm('Clear all activity?')) return;
  await api.storeClear('activity');
  activityTab.list = [];
  activityTab.render();
};
document.getElementById('reset-all').onclick = async () => {
  if (!confirm('This will reset EVERYTHING including your API key. Are you sure?')) return;
  await api.storeClear('history');
  await api.storeClear('activity');
  await api.storeClear('automations');
  await api.storeSet('memory', { name: '', notes: [] });
  await api.storeSet('settings', { apiKey: '', voice: 'Aoede', hotkey: 'Alt+Space' });
  location.reload();
};

function flashSave() {
  const s = document.getElementById('save-status');
  s.textContent = '✓ Saved';
  s.classList.add('show');
  setTimeout(() => s.classList.remove('show'), 1800);
}

// ═══════════════════════════════════════════════════════════════════
// RECALL TAB (Photographic Memory)
// ═══════════════════════════════════════════════════════════════════
const recallTab = {
  results: [],
  async load() {
    // Read settings + status
    const settings = await api.storeGet('settings') || {};
    const status = await api.visionStatus();
    document.getElementById('vision-toggle').checked = status.enabled;
    if (!status.enabled && settings.visionMemoryEnabled) {
      // Reflect pref but actually off
    }
    this.results = await api.visionSearch('');
    this.render();
  },
  renderToken: 0,
  async render() {
    const grid = document.getElementById('recall-grid');
    const stats = document.getElementById('recall-stats');
    grid.innerHTML = '';
    if (!this.results.length) {
      stats.textContent = 'No memories yet. Toggle ON above to start capturing.';
      return;
    }
    stats.textContent = `${this.results.length} memories · oldest ${new Date(this.results[this.results.length-1].ts).toLocaleString()}`;
    const myToken = ++this.renderToken;
    // Create placeholders synchronously to preserve order
    const cards = this.results.map(e => {
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; cursor:pointer; transition:all 0.2s;';
      card.onmouseenter = () => card.style.borderColor = 'var(--border-bright)';
      card.onmouseleave = () => card.style.borderColor = 'var(--border)';
      card.innerHTML = `
        <div class="rec-thumb" style="height:130px; background:rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; color:rgba(150,170,200,0.4); font-family:var(--mono); font-size:10px;">loading…</div>
        <div style="padding:10px 12px;">
          <div style="font-family:var(--mono); font-size:10px; color:var(--cyan); margin-bottom:4px;">${new Date(e.ts).toLocaleString()}</div>
          <div style="font-size:11px; color:var(--text-dim); line-height:1.5; max-height:46px; overflow:hidden;">${escapeHtml((e.text || 'No description').slice(0, 140))}</div>
        </div>`;
      grid.appendChild(card);
      return { card, e };
    });
    // Lazy-load images one at a time so we don't flood IPC
    for (const { card, e } of cards) {
      if (myToken !== this.renderToken) return; // newer render started, bail
      const b64 = await api.visionImage(e.path);
      if (myToken !== this.renderToken) return;
      const thumb = card.querySelector('.rec-thumb');
      if (b64) {
        thumb.outerHTML = `<img src="data:image/jpeg;base64,${b64}" style="width:100%; display:block;" />`;
      }
      card.onclick = () => showRecallDetail(e, b64);
    }
  },
};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showRecallDetail(e, b64) {
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:9999; display:flex; align-items:center; justify-content:center; padding:40px; cursor:pointer; backdrop-filter:blur(10px);';
  const card = document.createElement('div');
  card.style.cssText = 'max-width:1000px; max-height:90vh; background:var(--panel-solid); border:1px solid var(--border-bright); border-radius:16px; overflow:hidden; cursor:default;';
  card.onclick = (ev) => ev.stopPropagation();
  const head = document.createElement('div');
  head.style.cssText = 'padding:14px 20px; border-bottom:1px solid var(--border); font-family:var(--mono); font-size:12px; color:var(--cyan);';
  head.textContent = new Date(e.ts).toLocaleString();
  card.appendChild(head);
  if (b64) {
    const img = document.createElement('img');
    img.src = `data:image/jpeg;base64,${b64}`;
    img.style.cssText = 'max-width:100%; max-height:65vh; display:block; margin:0 auto;';
    card.appendChild(img);
  }
  const desc = document.createElement('div');
  desc.style.cssText = 'padding:16px 20px; color:var(--text); font-size:13px; line-height:1.7; user-select:text; white-space:pre-wrap;';
  desc.textContent = e.text || 'No OCR text';
  card.appendChild(desc);
  m.appendChild(card);
  m.onclick = () => m.remove();
  document.body.appendChild(m);
}

const recallSearch = document.getElementById('recall-search');
recallSearch?.addEventListener('input', async () => {
  recallTab.results = await api.visionSearch(recallSearch.value);
  recallTab.render();
});

const visionToggle = document.getElementById('vision-toggle');
visionToggle?.addEventListener('change', async () => {
  if (visionToggle.checked) {
    await api.visionStart(90);
    await api.storeSet('settings', 'visionMemoryEnabled', true);
  } else {
    await api.visionStop();
    await api.storeSet('settings', 'visionMemoryEnabled', false);
  }
});

document.getElementById('open-agent-btn')?.addEventListener('click', () => api.openAgent());

// ═══════════════════════════════════════════════════════════════════
// VOICE ARENA — 3D orb + real audio
// ═══════════════════════════════════════════════════════════════════
(function initVoiceArena() {
  const orbCanvas  = document.getElementById('orb-canvas');
  const waveCanvas = document.getElementById('wave-canvas');
  const stateLabel = document.getElementById('dash-voice-state');
  const stateSub   = document.getElementById('dash-voice-sub');
  const startBtn   = document.getElementById('dash-start-btn');
  const stopBtn    = document.getElementById('dash-stop-btn');
  const arena      = document.getElementById('voice-arena');
  if (!orbCanvas || !waveCanvas) return;

  const oc  = orbCanvas.getContext('2d');
  const wc  = waveCanvas.getContext('2d');

  let analyser   = null;
  let freqData   = null;
  let audioCtx   = null;
  let micStream  = null;
  let rafId      = null;
  let voiceOn    = false;
  let orbT       = 0; // time for idle animation
  const PALETTE  = { cyan: '#00d9ff', purple: '#a855f7', green: '#00ff9d', red: '#ff3b6b' };

  // Populate voice name
  api.storeGet('settings').then(s => {
    const el = document.getElementById('hud-voice-name');
    if (el && s && s.voice) el.textContent = s.voice;
  }).catch(() => {});

  // ── 3D sphere renderer ──────────────────────────────────────────
  function drawOrb(freqArr) {
    const W = orbCanvas.width, H = orbCanvas.height;
    const cx = W / 2, cy = H / 2;
    const R  = 110;
    oc.clearRect(0, 0, W, H);

    // Ambient outer glow
    const outerGlow = oc.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.8);
    outerGlow.addColorStop(0, 'rgba(0,217,255,0.08)');
    outerGlow.addColorStop(0.5, 'rgba(168,85,247,0.05)');
    outerGlow.addColorStop(1, 'transparent');
    oc.fillStyle = outerGlow;
    oc.beginPath();
    oc.arc(cx, cy, R * 1.8, 0, Math.PI * 2);
    oc.fill();

    // Dark core fill
    const coreGrd = oc.createRadialGradient(cx - R * 0.25, cy - R * 0.25, 0, cx, cy, R);
    coreGrd.addColorStop(0, 'rgba(0,30,50,0.95)');
    coreGrd.addColorStop(0.6, 'rgba(0,10,20,0.98)');
    coreGrd.addColorStop(1, 'rgba(0,5,12,1)');
    oc.fillStyle = coreGrd;
    oc.beginPath();
    oc.arc(cx, cy, R, 0, Math.PI * 2);
    oc.fill();

    // Latitude rings (perspective-flattened ellipses) driven by audio
    const RINGS = 14;
    for (let r = 0; r < RINGS; r++) {
      const phi = (r / (RINGS - 1)) * Math.PI;
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      const ry = cy + R * cosP * 0.88; // 0.88 = perspective tilt
      const rx = R * sinP;

      // Map ring to a frequency band
      const bandIdx = freqArr
        ? Math.floor((r / RINGS) * freqArr.length * 0.7)
        : -1;
      const amp = freqArr ? (freqArr[bandIdx] || 0) / 255 : 0;

      // Idle wobble when no audio
      const idleAmp = voiceOn ? 0 : (Math.sin(orbT * 1.2 + r * 0.5) * 0.5 + 0.5) * 0.15;
      const totalAmp = amp + idleAmp;

      const distort = totalAmp * 18 * sinP;

      const alpha = 0.12 + totalAmp * 0.55;
      const lw    = 0.7 + totalAmp * 2;

      // Hue shift: blue -> cyan -> green when active
      const hue = voiceOn ? 160 + totalAmp * 60 : 190 + r * 4;
      oc.beginPath();
      oc.ellipse(cx, ry, rx + distort, (rx * 0.28) + distort * 0.12, 0, 0, Math.PI * 2);
      oc.strokeStyle = `hsla(${hue}, 95%, 60%, ${alpha})`;
      oc.lineWidth = lw;
      oc.stroke();
    }

    // Longitude arcs
    const LONGS = 10;
    for (let l = 0; l < LONGS; l++) {
      const angle  = (l / LONGS) * Math.PI * 2 + orbT * 0.08;
      const cosA   = Math.cos(angle);
      const sinA   = Math.sin(angle);
      const bandIdx = freqArr
        ? Math.floor((l / LONGS) * freqArr.length * 0.4)
        : -1;
      const amp    = freqArr ? (freqArr[bandIdx] || 0) / 255 : 0;
      const idleA  = voiceOn ? 0 : (Math.sin(orbT + l) * 0.5 + 0.5) * 0.12;
      const total  = amp + idleA;

      const STEPS = 48;
      oc.beginPath();
      for (let s = 0; s <= STEPS; s++) {
        const phi = (s / STEPS) * Math.PI;
        const x   = cx + cosA * R * Math.sin(phi) * (1 + total * 0.12);
        const y   = cy + R * Math.cos(phi) * 0.88;
        s === 0 ? oc.moveTo(x, y) : oc.lineTo(x, y);
      }
      oc.strokeStyle = `rgba(168,85,247,${0.08 + total * 0.35})`;
      oc.lineWidth   = 0.6 + total * 1.6;
      oc.stroke();
    }

    // Inner core glow
    const coreLight = oc.createRadialGradient(cx - R * 0.2, cy - R * 0.22, 0, cx, cy, R * 0.75);
    const coreAlpha = voiceOn ? 0.28 : 0.16 + Math.sin(orbT) * 0.06;
    coreLight.addColorStop(0,   `rgba(255,255,255,${coreAlpha * 1.2})`);
    coreLight.addColorStop(0.3, `rgba(0,217,255,${coreAlpha})`);
    coreLight.addColorStop(1,   'transparent');
    oc.fillStyle = coreLight;
    oc.beginPath();
    oc.arc(cx, cy, R, 0, Math.PI * 2);
    oc.fill();

    // Rim glow
    const rimGrd = oc.createRadialGradient(cx, cy, R * 0.82, cx, cy, R);
    const rimColor = voiceOn ? '0,255,157' : '0,217,255';
    rimGrd.addColorStop(0, 'transparent');
    rimGrd.addColorStop(1, `rgba(${rimColor},0.45)`);
    oc.fillStyle = rimGrd;
    oc.beginPath();
    oc.arc(cx, cy, R, 0, Math.PI * 2);
    oc.fill();

    // Specular highlight
    const spec = oc.createRadialGradient(cx - R * 0.28, cy - R * 0.28, 0, cx - R * 0.15, cy - R * 0.15, R * 0.38);
    spec.addColorStop(0, 'rgba(255,255,255,0.22)');
    spec.addColorStop(1, 'transparent');
    oc.fillStyle = spec;
    oc.beginPath();
    oc.arc(cx, cy, R, 0, Math.PI * 2);
    oc.fill();

    orbT += 0.025;
  }

  // ── Waveform renderer ────────────────────────────────────────────
  function drawWave(freqArr) {
    const W = waveCanvas.width, H = waveCanvas.height;
    wc.clearRect(0, 0, W, H);
    if (!freqArr) {
      // Flat idle line
      wc.strokeStyle = 'rgba(0,217,255,0.15)';
      wc.lineWidth = 1;
      wc.beginPath();
      wc.moveTo(0, H / 2);
      wc.lineTo(W, H / 2);
      wc.stroke();
      return;
    }
    const barW  = W / freqArr.length;
    const mid   = H / 2;
    for (let i = 0; i < freqArr.length; i++) {
      const v   = freqArr[i] / 255;
      const bH  = Math.max(1, v * H * 0.92);
      const x   = i * barW;
      // Cyan -> purple gradient based on position + intensity
      const hue = 180 + (i / freqArr.length) * 90;
      const sat = 80 + v * 20;
      wc.fillStyle = `hsla(${hue},${sat}%,65%,${0.5 + v * 0.5})`;
      // Mirror: bar goes both up and down from center
      wc.fillRect(x, mid - bH / 2, Math.max(1, barW - 1), bH);
    }
  }

  // ── Main render loop ─────────────────────────────────────────────
  function renderLoop() {
    let freq = null;
    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      freq = freqData;
    }
    drawOrb(freq);
    drawWave(freq);
    rafId = requestAnimationFrame(renderLoop);
  }

  // ── Start voice ──────────────────────────────────────────────────
  startBtn.addEventListener('click', async () => {
    if (voiceOn) return;
    try {
      // Open mic for visualization
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStream = stream;
      audioCtx  = new AudioContext();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser  = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;
      freqData  = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);

      voiceOn = true;
      startBtn.disabled = true;
      stopBtn.disabled  = false;
      stateLabel.textContent = 'LISTENING';
      stateSub.textContent   = 'voice active — speak now';

      // Trigger pill voice
      api.dashVoiceStart?.();
    } catch (err) {
      stateLabel.textContent = 'MIC ERROR';
      stateSub.textContent   = err.message || 'microphone access denied';
    }
  });

  // ── Stop voice ───────────────────────────────────────────────────
  stopBtn.addEventListener('click', () => {
    if (!voiceOn) return;
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx)  { audioCtx.close(); audioCtx = null; }
    analyser = null; freqData = null;
    voiceOn  = false;
    startBtn.disabled = false;
    stopBtn.disabled  = true;
    stateLabel.textContent = 'STANDBY';
    stateSub.textContent   = 'ready for voice interaction';
    api.dashVoiceStop?.();
  });

  // Start render loop immediately (shows idle 3D sphere)
  renderLoop();
})();

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════
(async function boot() {
  await chatTab.load();
  await activityTab.load();
  systemTab.kick();
})();
