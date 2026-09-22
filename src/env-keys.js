// Resolves the TypeSafe Jev API key without adding a dependency.
// MUST NOT require('electron') (scripts/ run this under plain node).
// MUST NEVER log, return in errors, or send to a renderer the key value.
// Contract: docs/jev-uia/CONTRACT.md section "env-keys.js".

const fs = require('fs');
const path = require('path');

/**
 * Minimal .env parser. Lines `KEY=VALUE`; ignores blanks and `#` comments;
 * trims key and value; strips one pair of matching surrounding quotes;
 * strips trailing \r; tolerates a missing trailing newline and a UTF-8 BOM.
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseDotEnv(text) {
  const result = {};
  if (!text) return result;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM

  for (let line of text.split('\n')) {
    line = line.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) continue;

    if (value.length >= 2) {
      const first = value[0], last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    result[key] = value; // later duplicate keys win (plain overwrite)
  }
  return result;
}

// One read per absolute .env path per process; keyed by path so main.js's
// fixed searchDirs and short-lived scripts both benefit without staleness
// concerns (a long-running main process just keeps the first read forever,
// matching the contract's "cache the .env file read once per process").
const dotEnvCache = new Map();

function loadDotEnvCached(filePath) {
  if (dotEnvCache.has(filePath)) return dotEnvCache.get(filePath);
  let parsed = null;
  try {
    parsed = parseDotEnv(fs.readFileSync(filePath, 'utf8'));
  } catch {
    parsed = null;
  }
  dotEnvCache.set(filePath, parsed);
  return parsed;
}

/**
 * Precedence: settingsKey (non-empty) > process.env.TYPESAFE_API_KEY >
 * .env TYPESAFE_API_KEY > .env `jev`. First existing .env in searchDirs wins.
 * @param {{ settingsKey?: string, searchDirs: string[] }} opts
 * @returns {{ key: string|null, source: 'settings'|'process.env'|'.env'|null }}
 */
function resolveJevKey({ settingsKey, searchDirs }) {
  if (settingsKey && settingsKey.trim()) {
    return { key: settingsKey.trim(), source: 'settings' };
  }

  const procKey = process.env.TYPESAFE_API_KEY;
  if (procKey && procKey.trim()) {
    return { key: procKey.trim(), source: 'process.env' };
  }

  let parsed = null;
  for (const dir of searchDirs || []) {
    if (!dir) continue;
    const candidate = loadDotEnvCached(path.join(dir, '.env'));
    if (candidate) { parsed = candidate; break; } // first EXISTING .env wins
  }
  if (!parsed) return { key: null, source: null };

  const tsKey = parsed.TYPESAFE_API_KEY;
  if (tsKey && tsKey.trim()) return { key: tsKey.trim(), source: '.env' };

  const jevKey = parsed.jev;
  if (jevKey && jevKey.trim()) return { key: jevKey.trim(), source: '.env' };

  return { key: null, source: null };
}

module.exports = { parseDotEnv, resolveJevKey };
