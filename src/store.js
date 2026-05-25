// Persistent state for Aura. Uses electron-store under the hood.
// Buckets: settings (api key, hotkey, voice...), history (chats), automations (saved macros),
// memory (user facts), activity (action log).

const Store = require('electron-store');

const store = new Store({
  name: 'aura',
  defaults: {
    settings: {
      apiKey: '',
      voice: 'Aoede',
      hotkey: 'Alt+Space',
      autoStart: false,
      theme: 'jarvis',
      verboseLogging: true,
      pushToTalk: false,
    },
    history: [],        // [{ id, ts, role, text }]
    automations: [],    // [{ id, name, steps: [{ kind, ... }] }]
    memory: {           // free-form facts about the user
      name: '',
      notes: [],
    },
    activity: [],       // [{ id, ts, kind, summary }]
  },
});

function get(bucket, key) {
  if (key === undefined) return store.get(bucket);
  return store.get(`${bucket}.${key}`);
}

function set(bucket, key, value) {
  if (value === undefined) {
    store.set(bucket, key);
  } else {
    store.set(`${bucket}.${key}`, value);
  }
}

function push(bucket, item, maxLen = 500) {
  const arr = store.get(bucket) || [];
  arr.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), ...item });
  if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
  store.set(bucket, arr);
  return arr[arr.length - 1];
}

function remove(bucket, id) {
  const arr = store.get(bucket) || [];
  store.set(bucket, arr.filter(x => x.id !== id));
}

function clear(bucket) {
  store.set(bucket, []);
}

module.exports = { get, set, push, remove, clear, store };
