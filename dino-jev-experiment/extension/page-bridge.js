// Runs in the page's own JS context (manifest "world": "MAIN"), so it can see the page's
// `Runner` global directly -- the same object dino_jev_v3.js's cdp transport reads via CDP
// Runtime.evaluate. An isolated-world content script (content.js) cannot see page globals, so
// it owns the WebSocket instead and relays each command here via window.postMessage, scoped to
// a private channel name so it never collides with the page's own messages.
(function () {
  const CHANNEL = '__jev_dino_bridge__';

  function snapshot() {
    const r = window.Runner && window.Runner.instance_;
    if (!r) return { error: 'no Runner instance' };
    const obs = r.horizon.obstacles.slice(0, 4).map((o) => ({
      xPos: o.xPos, yPos: o.yPos, width: o.width, size: o.size,
      height: o.typeConfig ? o.typeConfig.height : undefined,
      typeName: o.typeConfig ? o.typeConfig.type : undefined,
      collisionBoxes: o.collisionBoxes || null,
    }));
    return {
      crashed: r.crashed, started: r.started, currentSpeed: r.currentSpeed, distanceRan: r.distanceRan,
      scoreStr: r.distanceMeter ? r.distanceMeter.digits.join('') : null,
      tRex: {
        xPos: r.tRex.xPos, yPos: r.tRex.yPos, jumping: r.tRex.jumping, ducking: r.tRex.ducking,
        jumpVelocity: r.tRex.jumpVelocity,
      },
      obstacles: obs,
    };
  }

  function tRexConfig() {
    const r = window.Runner && window.Runner.instance_;
    return r ? r.tRex.config : null;
  }
  function groundY() {
    const r = window.Runner && window.Runner.instance_;
    return r ? r.tRex.yPos : null;
  }

  // Verified reliable during dino-jev-experiment calibration (dino_jev_v2.js probes): calling the
  // Runner's own key handlers directly works and is simpler than dispatching synthetic
  // KeyboardEvents (which would depend on whether this page's listeners are on document/window and
  // whether they trust synthetic `isTrusted: false` events -- untested, so not relied on here).
  function pressSpace() {
    const r = window.Runner.instance_;
    r.onKeyDown({ keyCode: 32, preventDefault() {} });
    r.onKeyUp({ keyCode: 32, preventDefault() {} });
  }
  function setDuck(holdDown) {
    const r = window.Runner.instance_;
    if (holdDown) r.onKeyDown({ keyCode: 40, preventDefault() {} });
    else r.onKeyUp({ keyCode: 40, preventDefault() {} });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.channel !== CHANNEL || ev.data.dir !== 'toPage') return;
    const { id, method, args } = ev.data;
    let result;
    try {
      if (method === 'ready') result = !!(window.Runner && window.Runner.instance_);
      else if (method === 'snapshot') result = snapshot();
      else if (method === 'tRexConfig') result = tRexConfig();
      else if (method === 'groundY') result = groundY();
      else if (method === 'pressSpace') { pressSpace(); result = true; }
      else if (method === 'setDuck') { setDuck(args && args[0]); result = true; }
      else result = { error: 'unknown method ' + method };
    } catch (e) {
      result = { error: String(e) };
    }
    window.postMessage({ channel: CHANNEL, dir: 'toContent', id, result }, '*');
  });
})();
