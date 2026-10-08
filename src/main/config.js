// Settings live in one JSON file in the user's app-data folder. The API key is
// encrypted with the OS keychain (Electron safeStorage) before it touches disk.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SHORTCUTS = {
  toggle: 'CommandOrControl+Shift+H',   // H for Halo: show / hide
  capture: 'CommandOrControl+Shift+C',  // C for Capture
  listen: 'CommandOrControl+Shift+L',   // L for Listen
  collapse: 'CommandOrControl+Shift+M', // M for Minimize the panel to the bar
  dock: 'CommandOrControl+Shift+D',     // D for Dock: cycle the overlay between screen corners
};
const DEFAULTS = {
  model: 'claude-opus-5-5',
  effort: 'medium',
  context: '',          // free-form notes about the user
  resume: null,         // { name, text }
  job: '',              // job description text
  micId: '',            // your voice
  mic2Id: '',           // optional second input (loopback device carrying the call audio)
  systemAudio: false,
  noiseSuppression: true, // browser-side noise suppression, echo cancellation and auto gain on every input
  themeMode: 'auto',    // 'auto' samples the backdrop | 'dark' | 'light'
  autoAnswer: true,
  whisperModel: 'onnx-community/whisper-base',
  language: 'english',
  attachScreen: true,
  preset: 'talk',       // 'talk' (video / in-person conversation) | 'code' (live coding)
  positions: {},        // per preset: { x, y, displayId } where the user last dragged it
  keepFocus: true,      // never take keyboard focus from the app you are in, except while typing
  shortcuts: { ...DEFAULT_SHORTCUTS },
};
const PUBLIC_KEYS = Object.keys(DEFAULTS);

let cache = null;
const file = () => path.join(app.getPath('userData'), 'halo.json');

function load() {
  if (cache) return cache;
  try {
    const stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { ...DEFAULTS, ...stored, shortcuts: { ...DEFAULT_SHORTCUTS, ...(stored.shortcuts || {}) } };
  } catch { cache = { ...DEFAULTS, shortcuts: { ...DEFAULT_SHORTCUTS } }; }
  return cache;
}
function persist() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function getApiKey() {
  const c = load();
  if (!c.apiKeyEnc) return process.env.ANTHROPIC_API_KEY || '';
  try {
    if (c.apiKeyEnc.startsWith('plain:')) return Buffer.from(c.apiKeyEnc.slice(6), 'base64').toString('utf8');
    return safeStorage.decryptString(Buffer.from(c.apiKeyEnc, 'base64'));
  } catch { return ''; }
}
function setApiKey(key) {
  const c = load();
  key = (key || '').trim();
  if (!key) delete c.apiKeyEnc;
  else if (safeStorage.isEncryptionAvailable()) c.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
  else c.apiKeyEnc = 'plain:' + Buffer.from(key, 'utf8').toString('base64');
  persist();
}

function getPublic() {
  const c = load();
  const key = getApiKey();
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = c[k];
  out.hasKey = Boolean(key);
  out.keyHint = key ? '••••' + key.slice(-4) : '';
  out.keyFromEnv = Boolean(!c.apiKeyEnc && process.env.ANTHROPIC_API_KEY);
  out.defaultShortcuts = { ...DEFAULT_SHORTCUTS };
  return out;
}
function update(patch) {
  const c = load();
  if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) setApiKey(patch.apiKey);
  for (const k of PUBLIC_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    c[k] = k === 'shortcuts' ? { ...DEFAULT_SHORTCUTS, ...(patch.shortcuts || {}) } : patch[k];
  }
  persist();
  return getPublic();
}

module.exports = { load, getApiKey, getPublic, update, DEFAULTS, DEFAULT_SHORTCUTS };
