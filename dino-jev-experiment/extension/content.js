// Isolated-world content script: owns the WebSocket connection to dino_jev_v3.js's local
// --transport ext server (ws://127.0.0.1:8765/, port fixed to match EXT_WS_PORT there). Content
// scripts run in their own JS realm separate from the page's, not subject to the page's CSP the
// way a "world":"MAIN" script's own network calls would be, so the WebSocket lives here. Each
// command from Node is relayed to page-bridge.js (which has the actual `Runner` access) via
// window.postMessage, and the reply is sent back over the WebSocket.
(function () {
  const CHANNEL = '__jev_dino_bridge__';
  const PORT = 8765; // must match dino_jev_v3.js's EXT_WS_PORT

  let ws = null;
  let reqId = 0;
  const pending = new Map();

  function callPage(method, args) {
    return new Promise((resolve) => {
      const id = ++reqId;
      pending.set(id, resolve);
      window.postMessage({ channel: CHANNEL, dir: 'toPage', id, method, args: args || [] }, '*');
    });
  }
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.channel !== CHANNEL || ev.data.dir !== 'toContent') return;
    const { id, result } = ev.data;
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve(result); }
  });

  function connect() {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    } catch (e) {
      console.error('[jev-dino-ext] failed to open WebSocket:', e);
      setTimeout(connect, 3000);
      return;
    }
    ws.addEventListener('open', () => {
      console.log('[jev-dino-ext] connected to node driver on port', PORT);
      ws.send(JSON.stringify({ type: 'hello', url: location.href }));
    });
    ws.addEventListener('message', async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const result = await callPage(msg.method, msg.args);
      ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
    });
    ws.addEventListener('close', () => {
      console.log('[jev-dino-ext] disconnected, retrying in 2s');
      setTimeout(connect, 2000);
    });
    ws.addEventListener('error', () => {});
  }

  connect();
})();
