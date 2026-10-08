import '@fontsource-variable/geist';
import './styles.css';
import { marked } from 'marked';
import { LOGO_SVG } from './logo.js';

const halo = window.halo;
const isMac = halo.platform === 'darwin';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = {
  app: $('#app'), logo: $('#logo'), logo2: $('#logo-2'),
  capture: $('#btn-capture'), listen: $('#btn-listen'),
  askForm: $('#ask-form'), askInput: $('#ask-input'), attach: $('#attach-screen'),
  collapse: $('#btn-collapse'), settingsBtn: $('#btn-settings'), hideBtn: $('#btn-hide'),
  panel: $('#panel'), transcript: $('#transcript'), answer: $('#answer'), status: $('#status'),
  stop: $('#btn-stop'), answerNow: $('#btn-answer-now'), copy: $('#btn-copy'), clear: $('#btn-clear'),
  settings: $('#settings'), closeSettings: $('#btn-close-settings'), hint: $('#settings-hint'), tabs: $('#tabs'),
  model: $('#model'), effort: $('#effort'), autoAnswer: $('#auto-answer'), attachSetting: $('#attach-screen-setting'),
  uploadResume: $('#btn-upload-resume'), resumeStatus: $('#resume-status'), removeResume: $('#btn-remove-resume'),
  job: $('#job'), uploadJob: $('#btn-upload-job'), jobStatus: $('#job-status'), context: $('#context'),
  mic: $('#mic'), whisperModel: $('#whisper-model'), systemAudio: $('#system-audio'), systemAudioLabel: $('#system-audio-label'),
  resetShortcuts: $('#btn-reset-shortcuts'), shortcutError: $('#shortcut-error'),
  apiKey: $('#api-key'), saveKey: $('#btn-save-key'), keyStatus: $('#key-status'), quit: $('#btn-quit'),
};
el.logo.innerHTML = LOGO_SVG;
el.logo2.innerHTML = LOGO_SVG;
marked.setOptions({ gfm: true, breaks: true });

const DEFAULT_CAPTURE_PROMPT = 'Here is my screen. Figure out what I most likely need help with and handle it.';
const HALLUCINATIONS = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+|\[.*\]|\(.*\))$/i;
const ACTION_NAMES = { toggle: 'Show / hide', capture: 'Capture', listen: 'Listen', collapse: 'Collapse' };

let settings = {};
let mode = 'idle';            // 'capture' | 'listen'
let convo = [];               // Anthropic message params for capture mode
let current = null;           // { id, text, mode }
let reqCounter = 0;
let panelOpen = false;        // there is something to show
let collapsed = false;        // user folded the panel down to the bar

// ---------------------------------------------------------------- helpers
const setStatus = (text) => { el.status.textContent = text || ''; };
const show = (node, on = true) => node.classList.toggle('hidden', !on);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtChars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)) + ' chars';

const KEY_GLYPHS = {
  CommandOrControl: isMac ? '⌘' : 'Ctrl', Command: '⌘', Cmd: '⌘', Control: isMac ? '⌃' : 'Ctrl', Ctrl: isMac ? '⌃' : 'Ctrl',
  Alt: isMac ? '⌥' : 'Alt', Option: '⌥', Shift: '⇧', Return: '↩', Enter: '↩', Space: '␣', Escape: 'Esc',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '⌫', Delete: '⌦', Tab: '⇥',
};
const accelLabel = (accel) => (accel || '').split('+').map((p) => KEY_GLYPHS[p] || p).join(isMac ? '' : '+');

function accelFromEvent(e) {
  const mods = [];
  if (e.metaKey) mods.push(isMac ? 'CommandOrControl' : 'Super');
  if (e.ctrlKey) mods.push(isMac ? 'Control' : 'CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const c = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else key = {
    Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Backslash: '\\',
  }[c] || null;
  if (!key) return null;
  if (!mods.some((m) => m !== 'Shift')) return null; // needs ⌘, ⌃ or ⌥
  return [...mods, key].join('+');
}

let renderQueued = false;
function renderAnswer(streaming = false) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const text = current?.text || '';
    el.answer.innerHTML = text ? marked.parse(text) : '<p class="empty">…</p>';
    if (streaming) el.answer.lastElementChild?.classList.add('cursor');
    el.answer.scrollTop = el.answer.scrollHeight;
  });
}
function showError(message) { el.answer.innerHTML = `<p class="error">${escapeHtml(message)}</p>`; }

// ---------------------------------------------------------------- panels
function applyPanel() {
  show(el.panel, panelOpen && !collapsed);
  show(el.collapse, panelOpen);
  el.collapse.classList.toggle('flip', collapsed);
  el.collapse.title = collapsed ? `Expand panel (${accelLabel(settings.shortcuts?.collapse)})` : `Collapse panel (${accelLabel(settings.shortcuts?.collapse)})`;
  if (!collapsed) el.collapse.classList.remove('unread');
}
/** Opens the answer panel. `force` un-collapses (user-initiated); otherwise a collapsed panel just gets an unread dot. */
function openPanel({ force = false } = {}) {
  panelOpen = true;
  if (force) collapsed = false;
  else if (collapsed) el.collapse.classList.add('unread');
  show(el.settings, false);
  applyPanel();
}
function closePanel() { panelOpen = false; collapsed = false; applyPanel(); }
function toggleCollapse() {
  if (!panelOpen) return;
  collapsed = !collapsed;
  applyPanel();
}

function openSettings(tab, hint) {
  show(el.settings);
  show(el.panel, false);
  if (tab) selectTab(tab);
  el.hint.textContent = hint || '';
  show(el.hint, Boolean(hint));
  if (tab === 'account') el.apiKey.focus();
}
function closeSettings() { show(el.settings, false); applyPanel(); }
function selectTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-page').forEach((p) => show(p, p.dataset.page === name));
}

// Keep the native window exactly as tall as the content.
new ResizeObserver(() => halo.resize(el.app.getBoundingClientRect().height)).observe(el.app);

// ---------------------------------------------------------------- Claude
halo.onClaude((ev) => {
  if (!current || ev.id !== current.id) return;
  if (ev.type === 'delta') { current.text += ev.text; renderAnswer(true); return; }
  const finished = current;
  current = null;
  el.logo.classList.remove('thinking');
  el.capture.classList.remove('busy');
  show(el.stop, false);
  if (ev.type === 'done') {
    finished.text = ev.text || finished.text;
    el.answer.innerHTML = finished.text ? marked.parse(finished.text) : '<p class="empty">No answer.</p>';
    if (finished.mode === 'capture') convo.push({ role: 'assistant', content: finished.text });
    const usage = ev.usage ? ` · ${ev.usage.input_tokens + ev.usage.output_tokens} tok` : '';
    setStatus(`${ev.model || settings.model}${usage}${finished.mode === 'listen' ? ' · listening' : ''}`);
    if (collapsed) el.collapse.classList.add('unread');
  } else if (ev.type === 'aborted') {
    if (finished.mode === 'capture') convo.pop();
    el.answer.innerHTML = finished.text ? marked.parse(finished.text) : '<p class="empty">Cancelled.</p>';
  } else {
    if (finished.mode === 'capture') convo.pop();
    showError(ev.message || 'Something went wrong.');
    setStatus('');
  }
});

async function ask(reqMode, messages, { force = true } = {}) {
  if (current) await halo.abort(current.id);
  const id = `r${++reqCounter}`;
  current = { id, text: '', mode: reqMode };
  openPanel({ force });
  el.answer.innerHTML = '<p class="empty">Thinking…</p>';
  el.logo.classList.add('thinking');
  show(el.stop);
  setStatus(reqMode === 'listen' ? 'Suggesting what to say…' : 'Asking Claude…');
  halo.ask({ id, mode: reqMode, messages });
}

function trimOldScreenshots(messages) {
  // Keep images only in the two most recent user turns so history stays small.
  let seen = 0;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'image')) {
      seen++;
      if (seen > 2) {
        out.unshift({ role: 'user', content: m.content.map((b) => (b.type === 'image' ? { type: 'text', text: '[earlier screenshot omitted]' } : b)) });
        continue;
      }
    }
    out.unshift(m);
  }
  return out;
}

async function runCapture(question = '') {
  if (!settings.hasKey) return openSettings('account', 'Paste your Anthropic API key to get started.');
  if (mode === 'listen') await stopListening();
  mode = 'capture';
  openPanel({ force: true });
  show(el.transcript, false);
  show(el.answerNow, false);
  el.capture.classList.add('busy');

  let shot = null;
  const wantShot = el.attach.checked || convo.length === 0;
  if (wantShot) {
    setStatus('Capturing screen…');
    try { shot = await halo.capture(); }
    catch (err) {
      el.capture.classList.remove('busy');
      showError(err.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
      setStatus('');
      if (convo.length === 0 && !question) return;
    }
  }
  const content = [];
  if (shot) content.push({ type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.data } });
  content.push({ type: 'text', text: question || (convo.length ? 'Here is my current screen.' : DEFAULT_CAPTURE_PROMPT) });
  convo.push({ role: 'user', content });
  convo = trimOldScreenshots(convo);
  await ask('capture', convo);
}

// ---------------------------------------------------------------- listening
const audio = {
  ctx: null, node: null, streams: [], worker: null, ready: false,
  chunks: [], chunkSamples: 0, hadSpeech: false, lastSpeech: 0, noise: 0.004, jobs: 0,
  segments: [], answeredChars: 0, pendingAnswer: null,
};
const SR = 16000;

function transcriptText() { return audio.segments.map((s) => s.text).join(' '); }
function renderTranscript() {
  const segs = audio.segments.slice(-6);
  el.transcript.innerHTML = segs.map((s, i) => `<span class="seg${i === segs.length - 1 ? ' latest' : ''}">${escapeHtml(s.text)} </span>`).join('')
    + (audio.jobs > 0 ? '<span class="interim">…</span>' : '');
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function ensureWorker() {
  if (audio.worker) return;
  audio.worker = new Worker('./worker.js', { type: 'module' });
  audio.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      const pct = Math.round(m.progress || 0);
      setStatus(`Downloading speech model… ${pct}%`);
      el.answer.innerHTML = `<p class="empty">First run: fetching the local Whisper model (${escapeHtml(m.file || '')}). This happens once.</p><div class="progress"><i style="width:${pct}%"></i></div>`;
    } else if (m.type === 'ready') {
      audio.ready = true;
      setStatus(`Listening · local Whisper on ${m.device}`);
      if (mode === 'listen') el.answer.innerHTML = '<p class="empty">Listening. Answers appear here as the conversation unfolds.</p>';
    } else if (m.type === 'result') {
      audio.jobs = Math.max(0, audio.jobs - 1);
      const text = (m.text || '').trim();
      if (text && !HALLUCINATIONS.test(text)) {
        audio.segments.push({ text, t: Date.now() });
        if (audio.segments.length > 60) audio.segments.shift();
        scheduleAutoAnswer();
      }
      renderTranscript();
    } else if (m.type === 'error') {
      audio.jobs = Math.max(0, audio.jobs - 1);
      if (!audio.ready) { showError(`Speech model failed to load: ${m.message}`); stopListening(); }
      else console.warn('transcription error', m.message);
    }
  };
}

function onPcm(samples) {
  // Simple energy-based voice activity detection with an adaptive noise floor.
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  const now = performance.now();
  if (rms < audio.noise * 1.5) audio.noise = audio.noise * 0.95 + rms * 0.05; // track silence
  const speaking = rms > Math.max(0.012, audio.noise * 3.5);

  audio.chunks.push(samples);
  audio.chunkSamples += samples.length;
  if (speaking) { audio.hadSpeech = true; audio.lastSpeech = now; }

  const seconds = audio.chunkSamples / SR;
  const silentFor = now - audio.lastSpeech;
  if (audio.hadSpeech && ((silentFor > 700 && seconds >= 1.0) || seconds >= 14)) flushChunk();
  else if (!audio.hadSpeech && seconds > 2) {
    // keep a short pre-roll so the first syllable is not clipped
    while (audio.chunkSamples > SR * 0.4) audio.chunkSamples -= audio.chunks.shift().length;
  }
}

function flushChunk() {
  const merged = new Float32Array(audio.chunkSamples);
  let off = 0;
  for (const c of audio.chunks) { merged.set(c, off); off += c.length; }
  audio.chunks = []; audio.chunkSamples = 0; audio.hadSpeech = false;
  if (!audio.ready || merged.length < SR * 0.6) return;
  audio.jobs++;
  renderTranscript();
  audio.worker.postMessage({ type: 'transcribe', id: `t${Date.now()}`, audio: merged, language: settings.language || 'english' }, [merged.buffer]);
}

function scheduleAutoAnswer() {
  if (!settings.autoAnswer) return;
  clearTimeout(audio.pendingAnswer);
  audio.pendingAnswer = setTimeout(() => {
    const text = transcriptText();
    const fresh = text.slice(audio.answeredChars).trim();
    if (fresh.split(/\s+/).filter(Boolean).length >= 4) askInterview({ force: false });
  }, 900);
}

async function askInterview({ force = true } = {}) {
  const text = transcriptText();
  if (!text.trim()) return;
  audio.answeredChars = text.length;
  const tail = text.slice(-3500);
  await ask('listen', [{ role: 'user', content: `Live transcript (oldest first, most recent last):\n"""\n${tail}\n"""\n\nWhat should I say next?` }], { force });
}

async function startListening() {
  if (!settings.hasKey) return openSettings('account', 'Paste your Anthropic API key to get started.');
  mode = 'listen';
  openPanel({ force: true });
  show(el.transcript);
  show(el.answerNow);
  el.listen.classList.add('active');
  el.logo.classList.add('listening');
  el.answer.innerHTML = '<p class="empty">Starting microphone…</p>';
  setStatus('Requesting microphone…');
  try {
    const ok = await halo.requestMic();
    if (!ok) throw new Error('Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.');
    ensureWorker();
    audio.ready = false;
    audio.worker.postMessage({ type: 'load', model: settings.whisperModel });

    audio.ctx = new AudioContext({ sampleRate: SR });
    await audio.ctx.audioWorklet.addModule('./pcm-worklet.js');
    audio.node = new AudioWorkletNode(audio.ctx, 'pcm-capture', { numberOfOutputs: 1 });
    audio.node.port.onmessage = (e) => onPcm(e.data);
    const mute = audio.ctx.createGain(); mute.gain.value = 0;
    audio.node.connect(mute).connect(audio.ctx.destination);

    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.micId ? { exact: settings.micId } : undefined,
        echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1,
      },
    });
    audio.streams.push(mic);
    audio.ctx.createMediaStreamSource(mic).connect(audio.node);

    if (settings.systemAudio) {
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        sys.getVideoTracks().forEach((t) => t.stop());
        if (sys.getAudioTracks().length) {
          audio.streams.push(sys);
          audio.ctx.createMediaStreamSource(new MediaStream(sys.getAudioTracks())).connect(audio.node);
        }
      } catch (err) { console.warn('system audio unavailable', err); }
    }
    audio.lastSpeech = performance.now();
    setStatus('Loading speech model…');
  } catch (err) {
    showError(err.message);
    await stopListening(true);
  }
}

async function stopListening(keepPanel = false) {
  clearTimeout(audio.pendingAnswer);
  for (const s of audio.streams) s.getTracks().forEach((t) => t.stop());
  audio.streams = [];
  audio.node?.disconnect();
  audio.node = null;
  if (audio.ctx) { try { await audio.ctx.close(); } catch { /* ignore */ } audio.ctx = null; }
  audio.chunks = []; audio.chunkSamples = 0; audio.hadSpeech = false;
  el.listen.classList.remove('active');
  el.logo.classList.remove('listening');
  show(el.answerNow, false);
  if (mode === 'listen') { mode = 'idle'; if (!keepPanel) setStatus('Stopped listening'); }
}

async function toggleListening() {
  if (mode === 'listen') { if (current?.mode === 'listen') await halo.abort(current.id); await stopListening(); }
  else await startListening();
}

// ---------------------------------------------------------------- settings
function applyShortcutLabels() {
  const s = settings.shortcuts || {};
  $$('[data-shortcut]').forEach((k) => { k.textContent = accelLabel(s[k.dataset.shortcut]); });
  $$('.recorder').forEach((r) => { r.value = accelLabel(s[r.dataset.action]); r.classList.remove('bad'); });
  el.capture.title = `Capture the screen and ask Claude (${accelLabel(s.capture)})`;
  el.listen.title = `Interview mode: listen, transcribe, suggest answers (${accelLabel(s.listen)})`;
  el.hideBtn.title = `Hide (Esc). Bring back with ${accelLabel(s.toggle)}`;
  applyPanel();
}
function applyProfileLabels() {
  const r = settings.resume;
  el.resumeStatus.textContent = r ? `${r.name} · ${fmtChars(r.text.length)}` : 'No resume yet.';
  show(el.removeResume, Boolean(r));
}
function showShortcutErrors(errors = {}) {
  const names = Object.keys(errors);
  $$('.recorder').forEach((r) => r.classList.toggle('bad', names.includes(r.dataset.action)));
  el.shortcutError.textContent = names.length
    ? `${names.map((a) => `${ACTION_NAMES[a]} (${accelLabel(errors[a])})`).join(', ')} could not be registered. Another app owns that combination; pick a different one.`
    : '';
  show(el.shortcutError, names.length > 0);
}

async function loadSettings() {
  settings = await halo.getSettings();
  el.model.value = settings.model;
  el.effort.value = settings.effort;
  el.context.value = settings.context || '';
  el.job.value = settings.job || '';
  el.whisperModel.value = settings.whisperModel;
  el.autoAnswer.checked = Boolean(settings.autoAnswer);
  el.systemAudio.checked = Boolean(settings.systemAudio);
  el.attach.checked = settings.attachScreen !== false;
  el.attachSetting.checked = settings.attachScreen !== false;
  el.keyStatus.textContent = settings.hasKey
    ? (settings.keyFromEnv ? `Using ANTHROPIC_API_KEY from your environment (${settings.keyHint}).` : `Saved (${settings.keyHint}), encrypted with your keychain.`)
    : 'No key yet.';
  if (!isMac) el.systemAudioLabel.title = 'Captures what you hear (loopback).';
  else el.systemAudioLabel.title = 'Electron only supports direct system-audio capture on Windows. On macOS pick a loopback input device (e.g. BlackHole) above instead.';
  applyShortcutLabels();
  applyProfileLabels();
  await populateMics();
}
async function populateMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    el.mic.innerHTML = '<option value="">System default</option>' + inputs.map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || 'Microphone')}</option>`).join('');
    el.mic.value = settings.micId || '';
  } catch { /* labels appear after mic permission */ }
}
async function save(patch) {
  settings = await halo.saveSettings(patch);
  if (patch.shortcuts) { applyShortcutLabels(); showShortcutErrors(settings.shortcutErrors); }
}

for (const [node, key, prop] of [
  [el.model, 'model', 'value'], [el.effort, 'effort', 'value'], [el.whisperModel, 'whisperModel', 'value'],
  [el.mic, 'micId', 'value'], [el.autoAnswer, 'autoAnswer', 'checked'], [el.systemAudio, 'systemAudio', 'checked'],
]) node.addEventListener('change', () => save({ [key]: node[prop] }));
el.attach.addEventListener('change', () => { el.attachSetting.checked = el.attach.checked; save({ attachScreen: el.attach.checked }); });
el.attachSetting.addEventListener('change', () => { el.attach.checked = el.attachSetting.checked; save({ attachScreen: el.attach.checked }); });
const debounced = (fn, ms = 400) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
el.context.addEventListener('input', debounced(() => save({ context: el.context.value })));
el.job.addEventListener('input', debounced(() => { save({ job: el.job.value }); el.jobStatus.textContent = ''; }));

// Profile documents
async function importDoc(target) {
  const btn = target === 'resume' ? el.uploadResume : el.uploadJob;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Reading…';
  try {
    const doc = await halo.importDocument();
    if (!doc) return;
    if (target === 'resume') { await save({ resume: doc }); applyProfileLabels(); }
    else { el.job.value = doc.text; await save({ job: doc.text }); el.jobStatus.textContent = `Loaded ${doc.name} · ${fmtChars(doc.text.length)}`; }
  } catch (err) {
    const msg = err.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    if (target === 'resume') el.resumeStatus.textContent = msg; else el.jobStatus.textContent = msg;
  } finally { btn.disabled = false; btn.textContent = label; }
}
el.uploadResume.addEventListener('click', () => importDoc('resume'));
el.uploadJob.addEventListener('click', () => importDoc('job'));
el.removeResume.addEventListener('click', async () => { await save({ resume: null }); applyProfileLabels(); });

// Shortcut recorder
$$('.recorder').forEach((input) => {
  input.addEventListener('focus', () => { input.value = 'Press keys…'; });
  input.addEventListener('blur', () => { input.value = accelLabel(settings.shortcuts?.[input.dataset.action]); });
  input.addEventListener('keydown', async (e) => {
    e.preventDefault();
    if (e.key === 'Escape') { input.blur(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') return; // reserved for the reset button
    const accel = accelFromEvent(e);
    if (!accel) return;
    const action = input.dataset.action;
    const taken = Object.entries(settings.shortcuts || {}).find(([a, v]) => a !== action && v === accel);
    if (taken) { input.value = `Used by ${ACTION_NAMES[taken[0]]}`; input.classList.add('bad'); return; }
    await save({ shortcuts: { ...settings.shortcuts, [action]: accel } });
    input.blur();
  });
});
el.resetShortcuts.addEventListener('click', () => save({ shortcuts: { ...settings.defaultShortcuts } }));

// API key
async function saveKey() {
  const key = el.apiKey.value.trim();
  if (!key) return;
  await save({ apiKey: key });
  el.apiKey.value = '';
  el.keyStatus.textContent = `Saved (${settings.keyHint}), encrypted with your keychain.`;
  show(el.hint, false);
  await populateMics();
}
el.saveKey.addEventListener('click', saveKey);
el.apiKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey(); } });
el.mic.addEventListener('focus', async () => { try { await halo.requestMic(); await populateMics(); } catch { /* ignore */ } });

// ---------------------------------------------------------------- wiring
el.tabs.addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) selectTab(t.dataset.tab); });
el.capture.addEventListener('click', () => runCapture(el.askInput.value.trim()).then(() => { el.askInput.value = ''; }));
el.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = el.askInput.value.trim();
  el.askInput.value = '';
  if (mode === 'listen' && q) {
    // In interview mode a typed question is answered with the transcript as context.
    const tail = transcriptText().slice(-3500);
    ask('listen', [{ role: 'user', content: `Live transcript so far:\n"""\n${tail}\n"""\n\nThe candidate asks you directly: ${q}` }]);
  } else runCapture(q);
});
el.listen.addEventListener('click', toggleListening);
el.answerNow.addEventListener('click', () => askInterview());
el.stop.addEventListener('click', () => current && halo.abort(current.id));
el.collapse.addEventListener('click', toggleCollapse);
el.copy.addEventListener('click', async () => {
  const text = el.answer.innerText.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const old = el.copy.textContent; el.copy.textContent = 'Copied'; setTimeout(() => { el.copy.textContent = old; }, 1200);
});
el.clear.addEventListener('click', async () => {
  if (current) await halo.abort(current.id);
  convo = [];
  audio.segments = []; audio.answeredChars = 0;
  renderTranscript();
  if (mode === 'listen') el.answer.innerHTML = '<p class="empty">Transcript cleared. Still listening.</p>';
  else { el.answer.innerHTML = ''; mode = 'idle'; closePanel(); }
  setStatus('');
});
el.settingsBtn.addEventListener('click', () => (el.settings.classList.contains('hidden') ? openSettings() : closeSettings()));
el.closeSettings.addEventListener('click', closeSettings);
el.hideBtn.addEventListener('click', () => halo.hide());
el.quit.addEventListener('click', () => halo.quit());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a && /^https?:/i.test(a.href)) { e.preventDefault(); halo.openExternal(a.href); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.target.classList.contains('recorder')) {
    if (!el.settings.classList.contains('hidden')) closeSettings();
    else halo.hide();
  }
});
halo.onHotkey(({ action }) => {
  if (action === 'capture') runCapture(el.askInput.value.trim());
  else if (action === 'listen') toggleListening();
  else if (action === 'collapse') toggleCollapse();
  else if (action === 'settings') openSettings();
});

loadSettings().then(() => {
  if (!settings.hasKey) openSettings('account', 'Welcome. Paste your Anthropic API key to start. It is stored encrypted on this Mac and only ever sent to Anthropic.');
});
