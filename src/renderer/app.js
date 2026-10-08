import '@fontsource-variable/geist';
import './styles.css';
import { marked } from 'marked';
import { LOGO_SVG } from './logo.js';

const halo = window.halo;
const isMac = halo.platform === 'darwin';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = {
  app: $('#app'), bar: $('#bar'), logo: $('#logo'), logo2: $('#logo-2'),
  capture: $('#btn-capture'), listen: $('#btn-listen'),
  askForm: $('#ask-form'), askInput: $('#ask-input'),
  collapse: $('#btn-collapse'), settingsBtn: $('#btn-settings'), hideBtn: $('#btn-hide'), preset: $('#preset'), keepFocus: $('#keep-focus'),
  panel: $('#panel'), transcript: $('#transcript'), answer: $('#answer'), status: $('#status'),
  stop: $('#btn-stop'), answerNow: $('#btn-answer-now'), copy: $('#btn-copy'), clear: $('#btn-clear'),
  settings: $('#settings'), closeSettings: $('#btn-close-settings'), hint: $('#settings-hint'), tabs: $('#tabs'),
  model: $('#model'), effort: $('#effort'), autoAnswer: $('#auto-answer'), attachSetting: $('#attach-screen-setting'), noise: $('#noise-suppression'),
  uploadResume: $('#btn-upload-resume'), resumeStatus: $('#resume-status'), removeResume: $('#btn-remove-resume'),
  job: $('#job'), uploadJob: $('#btn-upload-job'), jobStatus: $('#job-status'), context: $('#context'),
  mic: $('#mic'), mic2: $('#mic2'), whisperModel: $('#whisper-model'), systemAudio: $('#system-audio'), systemAudioLabel: $('#system-audio-label'),
  themeMode: $('#theme-mode'), vu: $('#vu'), vuWrap: $('#vu-wrap'), vuSettings: $('#vu-settings'), vuNote: $('#vu-note'),
  resetShortcuts: $('#btn-reset-shortcuts'), shortcutError: $('#shortcut-error'),
  apiKey: $('#api-key'), saveKey: $('#btn-save-key'), keyStatus: $('#key-status'), quit: $('#btn-quit'),
};
el.logo.innerHTML = LOGO_SVG;
el.logo2.innerHTML = LOGO_SVG;
marked.setOptions({ gfm: true, breaks: true });

// Theme: main decides (sampled backdrop or manual); until it does, follow the OS.
const root = document.documentElement;
root.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
let themeTimer = null;
// A theme flip crossfades the whole overlay (gradients cannot transition, so
// swapping tokens in place looks like a glitch).
function setTheme(t) {
  const next = t === 'light' ? 'light' : 'dark';
  if (root.dataset.theme === next) return;
  clearTimeout(themeTimer);
  root.classList.add('theme-switching');
  themeTimer = setTimeout(() => {
    root.dataset.theme = next;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  }, 150);
}
halo.onTheme(setTheme);
// Glass opacity follows the backdrop: the closer the backdrop is to the glass's
// own shade (white page under light glass, black under dark), the more solid.
let glassA = 0.88;
halo.onBackdrop((lum) => {
  const light = root.dataset.theme === 'light';
  const closeness = light ? 1 - lum : lum;
  const a = Math.min(0.95, Math.max(0.8, 0.8 + 0.15 * closeness));
  if (Math.abs(a - glassA) < 0.02) return; // ignore jitter; @property transition smooths the rest
  glassA = a;
  root.style.setProperty('--glass-a', a.toFixed(3));
});

const DEFAULT_CAPTURE_PROMPT = 'Here is my screen. Figure out what I most likely need help with and handle it.';
const FOLLOWUP_CAPTURE_PROMPT = 'Here is my current screen.';
const HALLUCINATIONS = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+|\[.*\]|\(.*\))$/i;
const ACTION_NAMES = { selectArea: 'Select capture area', toggle: 'Show / hide', capture: 'Capture', listen: 'Listen', collapse: 'Collapse', dock: 'Move to corner' };

let settings = {};
let mode = 'idle';            // 'idle' | 'capture' | 'listen'
let convo = [];               // Anthropic message params for capture mode: answered turns only
let current = null;           // { id, text, mode, turn? } — turn is the capture user turn awaiting its answer
let reqCounter = 0;
let panelOpen = false;        // there is something to show
let collapsed = false;        // user folded the panel down to the bar

// ---------------------------------------------------------------- helpers
const setStatus = (text) => { el.status.textContent = text || ''; };
const show = (node, on = true) => (node.classList.contains('panel') ? revealPanel(node, on) : node.classList.toggle('hidden', !on));
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
    const target = el.answer.querySelector('.turn-a.live') || el.answer;
    target.innerHTML = text ? marked.parse(text) : '<p class="empty">…</p>';
    if (streaming) target.lastElementChild?.classList.add('cursor');
    el.answer.scrollTop = el.answer.scrollHeight;
  });
}
function showError(message) { el.answer.innerHTML = `<p class="error">${escapeHtml(message)}</p>`; }

// The capture conversation renders as a thread: each question (tagged when it
// carried a screenshot) above its answer, so a follow-up never wipes earlier turns.
function turnHtml(m) {
  if (m.role === 'assistant') return `<div class="turn-a">${marked.parse(m.content)}</div>`;
  const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
  const shot = blocks.some((b) => b.type === 'image' || b.text === '[earlier screenshot omitted]');
  const text = blocks.filter((b) => b.type === 'text' && b.text !== '[earlier screenshot omitted]').map((b) => b.text).join(' ');
  const question = text === DEFAULT_CAPTURE_PROMPT || text === FOLLOWUP_CAPTURE_PROMPT ? '' : text;
  return `<div class="turn-q">${shot ? '<span class="shot-tag">Screen</span>' : ''}<span>${escapeHtml(question || 'What is on my screen?')}</span></div>`;
}
function renderThread(tail = '') {
  el.answer.innerHTML = convo.map(turnHtml).join('') + tail;
  el.answer.scrollTop = el.answer.scrollHeight;
}
/** Settles an unfinished capture: a partial answer is kept with its question, an unanswered question is dropped. */
function settleCapture(req) {
  if (!req.turn || !req.text || req.rev !== captureRevision) return;
  convo = trimOldScreenshots([...convo, req.turn, { role: 'assistant', content: `${req.text}\n\n*(stopped)*` }]);
}

// ---------------------------------------------------------------- pills
// Segmented controls (Talk|Code, the settings tabs) share one raised pill that
// glides to the active button instead of each button lighting up in place.
const PILL_HOSTS = ['#preset', '#tabs'];
function placePills() {
  for (const sel of PILL_HOSTS) {
    const host = document.querySelector(sel);
    const on = host?.querySelector('button.active');
    if (!on || !host.offsetParent) continue; // hidden: measured again when shown
    let pill = host.querySelector('.pill');
    if (!pill) { pill = document.createElement('i'); pill.className = 'pill'; host.prepend(pill); }
    Object.assign(pill.style, { left: `${on.offsetLeft}px`, top: `${on.offsetTop}px`, width: `${on.offsetWidth}px`, height: `${on.offsetHeight}px` });
    // The first placement lands instantly; only moves after that glide.
    if (!pill.classList.contains('settled')) requestAnimationFrame(() => pill.classList.add('settled'));
  }
}
/** Un-hides a node with a short settle-in (opacity + lift, see .entering). */
function settle(node) {
  node.classList.remove('hidden');
  node.classList.add('entering');
  void node.offsetHeight; // commit the start state so the transition runs
  node.classList.remove('entering');
}

// ---------------------------------------------------------------- panels
// Panels settle in and fade out (.entering/.leaving in styles.css) and the next
// window resize animates with them. A panel replacing another swaps instantly
// so the window changes size once instead of bouncing.
const LEAVE_MS = 120;
let animateNextLayout = false;
function revealPanel(node, on) {
  const hidden = node.classList.contains('hidden');
  if (on) {
    clearTimeout(node._leave);
    node.classList.remove('leaving');
    if (!hidden) return;
    $$('.panel.leaving').forEach(finishLeave);
    settle(node);
    placePills();
    animateNextLayout = true;
  } else {
    if (hidden || node.classList.contains('leaving')) return;
    if ($$('.panel:not(.hidden):not(.leaving)').some((p) => p !== node)) { finishLeave(node); return; }
    node.classList.add('leaving');
    node._leave = setTimeout(() => finishLeave(node), LEAVE_MS);
  }
}
function finishLeave(node) {
  clearTimeout(node._leave);
  node.classList.remove('leaving');
  node.classList.add('hidden');
  animateNextLayout = true;
}

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
  $$('.tab-page').forEach((p) => {
    if (p.dataset.page !== name) p.classList.add('hidden');
    else if (p.classList.contains('hidden')) settle(p);
  });
  placePills();
  animateNextLayout = true;
}

// ---------------------------------------------------------------- layout
// The window is sized from the content, never the other way round: as tall as
// #app, and at least as wide as every visible bar control plus a usable input.
const ASK_MIN = { talk: 200, code: 150 };
function neededWidth() {
  const bar = el.bar;
  const cs = getComputedStyle(bar);
  const gap = parseFloat(cs.columnGap) || 0;
  const kids = Array.from(bar.children).filter((k) => getComputedStyle(k).display !== 'none');
  let w = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  for (const k of kids) {
    if (k === el.askForm) w += ASK_MIN[el.app.dataset.preset === 'code' ? 'code' : 'talk'];
    else w += k.getBoundingClientRect().width;
  }
  w += gap * Math.max(0, kids.length - 1);
  const appStyle = getComputedStyle(el.app);
  return Math.ceil(w + parseFloat(appStyle.paddingLeft) + parseFloat(appStyle.paddingRight));
}
let layoutQueued = false;
function requestLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    const animate = animateNextLayout;
    animateNextLayout = false;
    placePills(); // button widths can change with fonts, labels and preset
    halo.resize({ height: el.app.getBoundingClientRect().height, width: neededWidth(), animate });
  });
}
new ResizeObserver(requestLayout).observe(el.app);
new MutationObserver(requestLayout).observe(el.bar, { subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true });
document.fonts?.ready.then(requestLayout);

// ---------------------------------------------------------------- Claude
halo.onClaude((ev) => {
  if (!current || ev.id !== current.id) return;
  if (ev.type === 'delta') {
    current.text += ev.text;
    if (!current.started) { current.started = true; el.answer.classList.remove('stale'); }
    renderAnswer(true);
    return;
  }
  const finished = current;
  current = null;
  el.app.classList.remove('thinking');
  el.capture.classList.remove('busy');
  el.answer.classList.remove('stale');
  show(el.stop, false);
  if (finished.keep && !finished.started && ev.type !== 'done') {
    // Nothing new ever arrived: leave the previous answer exactly as it was.
    if (ev.type === 'error') setStatus(ev.message || 'Could not get a new suggestion.');
    if (finished.mode === 'listen' && audio.pendingAfter) { audio.pendingAfter = false; scheduleAutoAnswer(); }
    return;
  }
  if (ev.type === 'done') {
    finished.text = ev.text || finished.text;
    if (finished.turn) {
      // Capture area or margins changed mid-answer: the screenshot may show newly excluded content, so don't keep it.
      if (finished.rev === captureRevision) convo = trimOldScreenshots([...convo, finished.turn, { role: 'assistant', content: finished.text || 'No answer.' }]);
      renderThread(finished.rev === captureRevision ? '' : `${turnHtml(finished.turn)}<div class="turn-a">${marked.parse(finished.text || 'No answer.')}</div>`);
    } else el.answer.innerHTML = finished.text ? marked.parse(finished.text) : '<p class="empty">No answer.</p>';
    const u = ev.usage;
    const cached = u?.cache_read_input_tokens || 0;
    const usage = u ? ` · ${u.input_tokens + cached + (u.cache_creation_input_tokens || 0) + u.output_tokens} tok${cached ? ` (${cached} cached)` : ''}` : '';
    setStatus(`${ev.model || settings.model}${usage}${finished.mode === 'listen' ? ' · listening' : ''}`);
    if (collapsed) el.collapse.classList.add('unread');
    if (finished.mode === 'listen') {
      audio.lastAnswerAt = Date.now();
      if (finished.text) audio.suggestions = [...audio.suggestions, finished.text.slice(0, 1500)].slice(-2);
      if (audio.pendingAfter) { audio.pendingAfter = false; scheduleAutoAnswer(); }
    }
  } else if (ev.type === 'aborted') {
    if (finished.turn) { settleCapture(finished); renderThread(finished.text ? '' : '<p class="empty">Cancelled.</p>'); }
    else el.answer.innerHTML = finished.text ? marked.parse(finished.text) : '<p class="empty">Cancelled.</p>';
  } else {
    // A failed capture leaves the conversation as it was; the question can simply be asked again.
    if (finished.turn) renderThread(`<p class="error">${escapeHtml(ev.message || 'Something went wrong.')}</p>`);
    else showError(ev.message || 'Something went wrong.');
    setStatus('');
  }
});

/**
 * Streams one answer. With `keep`, the answer currently on screen stays visible
 * (dimmed) until the new one starts streaming, so the panel never blanks.
 */
async function ask(reqMode, messages, { force = true, keep = false, turn = null } = {}) {
  if (current) await halo.abort(current.id);
  const id = `r${++reqCounter}`;
  current = { id, text: '', mode: reqMode, keep: keep && el.answer.textContent.trim().length > 0, started: false, turn, rev: captureRevision };
  openPanel({ force });
  if (turn) renderThread(`${turnHtml(turn)}<div class="turn-a live"><div class="skeleton"><i></i><i></i><i></i><small>Reading your screen</small></div></div>`);
  else if (current.keep) el.answer.classList.add('stale');
  else el.answer.innerHTML = `<div class="skeleton"><i></i><i></i><i></i><small>${reqMode === 'listen' ? 'Drafting what to say' : 'Reading your screen'}</small></div>`;
  el.app.classList.add('thinking');
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

let previewResolve = null;
let selectingArea = false;
let captureRevision = 0;
function finishPreview(send) {
  if (!previewResolve) return;
  const resolve = previewResolve;
  previewResolve = null;
  show($('#capture-preview'), false);
  $('#capture-preview-image').removeAttribute('src');
  resolve(send);
}
$('#send-capture').addEventListener('click', () => finishPreview(true));
$('#cancel-capture').addEventListener('click', () => finishPreview(false));
function previewScreenshot(shot) {
  $('#capture-preview-image').src = `data:${shot.mediaType};base64,${shot.data}`;
  show($('#capture-preview'));
  el.answer.innerHTML = '';
  setStatus('Review screenshot before sending');
  return new Promise(resolve => { previewResolve = resolve; });
}
/**
 * Asks about the screen. `screen: true` (the Capture button and hotkey) always
 * attaches a fresh screenshot; a typed follow-up follows the attachScreen setting.
 */
async function runCapture(question = '', { screen = false } = {}) {
  if (previewResolve || selectingArea) return;
  if (!settings.hasKey) return openSettings('account', 'Paste your Anthropic API key to get started.');
  if (mode === 'listen') await stopListening();
  if (current?.turn) {
    // A new capture supersedes one still streaming: keep what it said so far, then stop it.
    const prev = current;
    current = null;
    settleCapture(prev);
    await halo.abort(prev.id);
    el.app.classList.remove('thinking');
    show(el.stop, false);
    renderThread();
  }
  mode = 'capture';
  openPanel({ force: true });
  show(el.transcript, false);
  show(el.answerNow, false);
  el.capture.classList.add('busy');

  const revision = captureRevision;
  let shot = null;
  const wantShot = screen || settings.attachScreen !== false || convo.length === 0;
  if (wantShot) {
    setStatus('Capturing screen…');
    try { shot = await halo.capture(); }
    catch (err) {
      el.capture.classList.remove('busy');
      showError(err.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
      setStatus('');
      return; // Never reuse a previous image if the selected display / crop failed.
    }
  }
  if (revision !== captureRevision) {
    el.capture.classList.remove('busy');
    setStatus('Capture area changed; capture again');
    return;
  }
  if (shot && settings.previewCapture && !await previewScreenshot(shot)) {
    el.capture.classList.remove('busy');
    setStatus('Capture cancelled');
    return;
  }
  if (revision !== captureRevision) {
    el.capture.classList.remove('busy');
    return;
  }
  const content = [];
  if (shot) content.push({ type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.data } });
  content.push({ type: 'text', text: question || (convo.length ? FOLLOWUP_CAPTURE_PROMPT : DEFAULT_CAPTURE_PROMPT) });
  // The turn joins `convo` only once answered, so a cancelled or failed request never leaves a dangling question.
  const turn = { role: 'user', content };
  await ask('capture', trimOldScreenshots([...convo, turn]), { turn });
}

// ---------------------------------------------------------------- listening
// Each input is its own channel with its own voice detection and chunking, so a
// segment knows who spoke: 'you' (microphone) or 'them' (second input carrying
// the call audio). With one input the speaker is unknown and nothing is labelled.
const audio = {
  ctx: null, channels: [], streams: [], worker: null, ready: false, reconnecting: false, jobs: 0,
  segments: [], answeredIndex: 0, pendingAnswer: null, pendingAfter: false, lastAnswerAt: 0,
  suggestions: [], // the last two finished suggestions, so Claude can build on them instead of repeating
};
const SR = 16000;
const SPEAKER_NAME = { you: 'You', them: 'Interviewer' };

function makeChannel(speaker) {
  return { speaker, node: null, chunks: [], chunkSamples: 0, hadSpeech: false, lastSpeech: performance.now(), noise: 0.004 };
}
const labelled = () => audio.channels.some((c) => c.speaker === 'them');
function segmentLine(seg) { return seg.speaker && labelled() ? `${SPEAKER_NAME[seg.speaker]}: ${seg.text}` : seg.text; }
function transcriptText(segments = audio.segments) { return segments.map(segmentLine).join(labelled() ? '\n' : ' '); }
/** Text since the last answer. With labelled speakers, only the interviewer's words count for question detection. */
function freshText() {
  const fresh = audio.segments.slice(audio.answeredIndex);
  return (labelled() ? fresh.filter((s) => s.speaker === 'them') : fresh).map((s) => s.text).join(' ').trim();
}
function renderTranscript() {
  const segs = audio.segments.slice(-6);
  const tagged = labelled();
  el.transcript.innerHTML = segs.map((s, i) => {
    const who = tagged && s.speaker && (i === 0 || segs[i - 1].speaker !== s.speaker) ? `<span class="who">${SPEAKER_NAME[s.speaker]}</span>` : '';
    return `<span class="seg ${s.speaker || ''}${i === segs.length - 1 ? ' latest' : ''}">${who}${escapeHtml(s.text)} </span>`;
  }).join('') + (audio.jobs > 0 ? '<span class="interim">…</span>' : '');
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function ensureWorker() {
  if (audio.worker) return;
  audio.worker = new Worker('./worker.js', { type: 'module' });
  audio.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      if (mode !== 'listen' || audio.ready) return;
      renderDownload(m);
    } else if (m.type === 'ready') {
      audio.ready = true;
      audio.download = null;
      if (mode !== 'listen') return;
      setStatus(audio.inputNotice || `Listening · local Whisper on ${m.device}`);
      el.answer.innerHTML = '<p class="empty">Listening. Answers appear here as the conversation unfolds.</p>';
    } else if (m.type === 'result') {
      audio.jobs = Math.max(0, audio.jobs - 1);
      const text = (m.text || '').trim();
      if (text && !HALLUCINATIONS.test(text)) {
        audio.segments.push({ text, speaker: m.speaker || null, t: Date.now() });
        if (audio.segments.length > 60) { audio.segments.shift(); audio.answeredIndex = Math.max(0, audio.answeredIndex - 1); }
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

// transformers.js reports progress per file and the files download in parallel,
// so a single file's percentage jumps around. Aggregate bytes across all files.
function renderDownload(m) {
  const d = audio.download || (audio.download = { files: new Map(), started: Date.now() });
  if (m.file) {
    const prev = d.files.get(m.file) || { loaded: 0, total: 0 };
    if (m.status === 'done') prev.loaded = prev.total || prev.loaded;
    else {
      if (Number.isFinite(m.total) && m.total > 0) prev.total = m.total;
      if (Number.isFinite(m.loaded)) prev.loaded = m.loaded;
      else if (Number.isFinite(m.progress) && prev.total) prev.loaded = (m.progress / 100) * prev.total;
    }
    d.files.set(m.file, prev);
  }
  let loaded = 0, total = 0;
  for (const f of d.files.values()) { loaded += f.loaded; total += f.total; }
  const pct = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
  const mb = (n) => (n / 1048576).toFixed(0);
  const sizeText = total ? ` · ${mb(loaded)} / ${mb(total)} MB` : '';
  setStatus(`Downloading speech model ${pct}%${sizeText}`);
  let bar = el.answer.querySelector('.progress > i');
  if (!bar) {
    el.answer.innerHTML = `<p class="empty">First run only: fetching the local Whisper model so transcription never leaves this Mac.</p><div class="progress"><i></i></div><p class="empty download-note"></p>`;
    bar = el.answer.querySelector('.progress > i');
  }
  bar.style.width = `${pct}%`;
  el.answer.querySelector('.download-note').textContent = total ? `${d.files.size} file${d.files.size === 1 ? '' : 's'}${sizeText.slice(3)}` : 'Starting…';
}

function onPcm(ch, samples) {
  // Simple energy-based voice activity detection with an adaptive noise floor, per channel.
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  const now = performance.now();
  if (rms < ch.noise * 1.5) ch.noise = ch.noise * 0.95 + rms * 0.05; // track silence
  const speaking = rms > Math.max(0.012, ch.noise * 3.5);
  updateVu(rms);

  ch.chunks.push(samples);
  ch.chunkSamples += samples.length;
  if (speaking) { ch.hadSpeech = true; ch.lastSpeech = now; }

  const seconds = ch.chunkSamples / SR;
  const silentFor = now - ch.lastSpeech;
  if (ch.hadSpeech && ((silentFor > 700 && seconds >= 1.0) || seconds >= 14)) flushChunk(ch);
  else if (!ch.hadSpeech && seconds > 2) {
    // keep a short pre-roll so the first syllable is not clipped
    while (ch.chunkSamples > SR * 0.4) ch.chunkSamples -= ch.chunks.shift().length;
  }
}

function flushChunk(ch) {
  const merged = new Float32Array(ch.chunkSamples);
  let off = 0;
  for (const c of ch.chunks) { merged.set(c, off); off += c.length; }
  ch.chunks = []; ch.chunkSamples = 0; ch.hadSpeech = false;
  if (!audio.ready || merged.length < SR * 0.6) return;
  audio.jobs++;
  renderTranscript();
  audio.worker.postMessage({ type: 'transcribe', id: `t${Date.now()}`, speaker: ch.speaker, audio: merged, language: settings.language || 'english' }, [merged.buffer]);
}

// A question opener must start a sentence (after an optional lead-in like "so" or
// "great"), so "I would describe the tradeoffs" in the candidate's own answer does not count.
const QUESTION_OPENERS = /^\W*(?:(?:so|and|okay|ok|great|alright|right|cool|yeah|um|uh|well|now),?\s+){0,2}(what|what's|why|how|when|where|which|who|tell me|talk me|walk me|describe|explain|can you|could you|would you|do you|did you|have you|are you|is there|give me|share)\b/i;
function looksLikeQuestion(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 5) return false;
  if (/\?/.test(text)) return true;
  // No question mark: look at the last two sentences only, so the candidate
  // reading an earlier answer aloud does not re-trigger.
  const sentences = text.split(/(?<=[.!?])\s+/).slice(-2);
  return words >= 6 && sentences.some((sentence) => QUESTION_OPENERS.test(sentence));
}

// Auto-suggest fires only when the new speech looks like a question, after a
// real pause, and never interrupts an answer that is still streaming. Plain
// continued talking extends the transcript and leaves the answer on screen.
function scheduleAutoAnswer() {
  if (!autoSuggestOn()) return;
  clearTimeout(audio.pendingAnswer);
  audio.pendingAnswer = setTimeout(() => {
    if (mode !== 'listen') return;
    if (!looksLikeQuestion(freshText())) return;
    if (current) { audio.pendingAfter = true; return; } // let the current answer finish first
    if (Date.now() - (audio.lastAnswerAt || 0) < 3000) { audio.pendingAfter = true; setTimeout(scheduleAutoAnswer, 1500); return; }
    askInterview({ force: false, keep: true });
  }, 1400);
}

/** One listen-mode user turn: earlier suggestions, the transcript tail, then the request. */
function interviewMessages(request) {
  const prev = audio.suggestions.length
    ? `<previous_suggestions>\n${audio.suggestions.map((s) => `<suggestion>\n${s}\n</suggestion>`).join('\n')}\n</previous_suggestions>\n\n`
    : '';
  const note = labelled() ? ' Lines are labelled by speaker.' : '';
  const tail = transcriptText().slice(-3500);
  return [{ role: 'user', content: `${prev}Live transcript (oldest first, most recent last).${note}\n"""\n${tail}\n"""\n\n${request}` }];
}

async function askInterview({ force = true, keep = true } = {}) {
  if (!transcriptText().trim()) return;
  audio.answeredIndex = audio.segments.length;
  await ask('listen', interviewMessages('What should I say next?'), { force, keep });
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

    await connectInputs();

    if (settings.systemAudio) {
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        sys.getVideoTracks().forEach((t) => t.stop());
        if (sys.getAudioTracks().length) attachStream(new MediaStream(sys.getAudioTracks()), 'system audio', 'them');
      } catch (err) { console.warn('system audio unavailable', err); }
    }
    show(el.vuWrap);
    el.vuNote.textContent = 'Live. Speak: the bar should move.';
    if (!audio.ready && !audio.download) setStatus('Loading speech model…');
    else if (audio.inputNotice) setStatus(audio.inputNotice);
  } catch (err) {
    showError(err.message);
    await stopListening(true);
  }
}

// ---- input devices -------------------------------------------------------
// Microphones are shared between apps on macOS, so Zoom holding the mic is not
// a conflict. What does go wrong: the chosen device is unplugged or renamed,
// another app has it exclusively (Windows), or a loopback device is selected
// as the only input and the candidate's own voice vanishes. Each case falls
// back to the system default and says so.
async function openInput(deviceId, label) {
  // Chromium's own cleanup: noise suppression, echo cancellation and automatic
  // gain. Its echo canceller only references audio Halo itself plays (nothing),
  // so it never strips the interviewer's voice coming out of your speakers.
  const filters = settings.noiseSuppression !== false;
  const constraints = (exact) => ({
    audio: {
      deviceId: exact && deviceId ? { exact: deviceId } : undefined,
      echoCancellation: filters, noiseSuppression: filters, autoGainControl: filters, channelCount: 1,
    },
  });
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(constraints(true)), fallback: false };
  } catch (err) {
    if (!deviceId) throw friendlyMicError(err, label);
    console.warn(`${label} unavailable (${err.name}), falling back to default`, err);
    try { return { stream: await navigator.mediaDevices.getUserMedia(constraints(false)), fallback: true, reason: err.name }; }
    catch (err2) { throw friendlyMicError(err2, label); }
  }
}
function friendlyMicError(err, label) {
  const map = {
    NotAllowedError: 'Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.',
    NotFoundError: `${label} was not found. Plug it in or choose another input in Settings → Audio.`,
    NotReadableError: `${label} is busy in another app that holds it exclusively. Close that app or pick another input.`,
    OverconstrainedError: `${label} is no longer available. Pick another input in Settings → Audio.`,
  };
  return new Error(map[err.name] || `Could not open ${label}: ${err.message}`);
}
function attachStream(stream, label, speaker) {
  const ch = makeChannel(speaker);
  ch.node = new AudioWorkletNode(audio.ctx, 'pcm-capture', { numberOfOutputs: 1 });
  ch.node.port.onmessage = (e) => onPcm(ch, e.data);
  const mute = audio.ctx.createGain(); mute.gain.value = 0; // keeps the worklet scheduled without playing anything
  ch.node.connect(mute).connect(audio.ctx.destination);
  audio.ctx.createMediaStreamSource(stream).connect(ch.node);
  audio.channels.push(ch);
  audio.streams.push(stream);
  for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => onInputLost(label));
}
function detachAll() {
  for (const s of audio.streams) s.getTracks().forEach((t) => t.stop());
  for (const ch of audio.channels) ch.node?.disconnect();
  audio.streams = [];
  audio.channels = [];
}
async function connectInputs() {
  audio.inputNotice = '';
  const primary = await openInput(settings.micId, 'Your microphone');
  attachStream(primary.stream, 'microphone', 'you');
  if (primary.fallback) audio.inputNotice = 'Chosen microphone unavailable, using the system default.';
  if (settings.mic2Id && settings.mic2Id !== settings.micId) {
    try {
      const second = await openInput(settings.mic2Id, 'Second input');
      if (second.fallback) audio.inputNotice = 'Second input unavailable; listening to your microphone only.';
      else attachStream(second.stream, 'second input', 'them');
      if (second.fallback) second.stream.getTracks().forEach((t) => t.stop());
    } catch (err) { audio.inputNotice = err.message; }
  }
  if (audio.inputNotice && audio.ready) setStatus(audio.inputNotice);
}
async function onInputLost(label) {
  if (mode !== 'listen' || audio.reconnecting) return;
  audio.reconnecting = true;
  setStatus(`${label} disconnected, reconnecting…`);
  try {
    detachAll();
    await new Promise((r) => setTimeout(r, 600)); // let the OS settle after a hot-unplug
    if (mode !== 'listen') return;
    await connectInputs();
    if (!audio.inputNotice) setStatus('Reconnected · listening');
  } catch (err) {
    showError(err.message);
    await stopListening(true);
  } finally { audio.reconnecting = false; }
}
navigator.mediaDevices.addEventListener('devicechange', () => populateMics());

let vuPeak = 0;
function updateVu(rms) {
  // ~ -40 dBFS .. 0 dBFS mapped onto the bar, with a quick decay so speech reads as motion
  const db = 20 * Math.log10(Math.max(rms, 1e-5));
  const level = Math.max(0, Math.min(1, (db + 40) / 40));
  vuPeak = Math.max(level, vuPeak * 0.85);
  const w = `${Math.round(vuPeak * 100)}%`;
  el.vu.style.width = w;
  el.vuSettings.style.width = w;
}

async function stopListening(keepPanel = false) {
  clearTimeout(audio.pendingAnswer);
  detachAll();
  if (audio.ctx) { try { await audio.ctx.close(); } catch { /* ignore */ } audio.ctx = null; }
  el.listen.classList.remove('active');
  el.logo.classList.remove('listening');
  show(el.answerNow, false);
  show(el.vuWrap, false);
  el.vu.style.width = '0'; el.vuSettings.style.width = '0';
  el.vuNote.textContent = 'Press Listen to see live levels here.';
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
function applyPreset() {
  const preset = settings.preset === 'code' ? 'code' : 'talk';
  $$('#preset button').forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
  placePills();
  el.app.dataset.preset = preset;
  el.askInput.placeholder = preset === 'code' ? 'Ask about the problem on screen…' : 'Ask about your screen…';
  requestLayout();
}
const autoSuggestOn = () => Boolean(settings.autoAnswer) && settings.preset !== 'code';

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
  el.themeMode.value = settings.themeMode || 'auto';
  el.autoAnswer.checked = Boolean(settings.autoAnswer);
  el.systemAudio.checked = Boolean(settings.systemAudio);
  el.attachSetting.checked = settings.attachScreen !== false;
  updateCaptureAreaUI();
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const key = `capture${edge[0].toUpperCase()}${edge.slice(1)}`;
    $(`#capture-${edge}`).value = settings[key] ?? (edge === 'top' ? 120 : 0);
  }
  el.noise.checked = settings.noiseSuppression !== false;
  el.keepFocus.checked = settings.keepFocus !== false;
  applyPreset();
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
    const opts = inputs.map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || 'Microphone')}</option>`).join('');
    el.mic.innerHTML = '<option value="">System default</option>' + opts;
    el.mic2.innerHTML = '<option value="">None</option>' + opts;
    el.mic.value = inputs.some((d) => d.deviceId === settings.micId) ? settings.micId : '';
    el.mic2.value = inputs.some((d) => d.deviceId === settings.mic2Id) ? settings.mic2Id : '';
  } catch { /* labels appear after mic permission */ }
}
async function save(patch) {
  settings = await halo.saveSettings(patch);
  if (patch.shortcuts) { applyShortcutLabels(); showShortcutErrors(settings.shortcutErrors); }
}

for (const [node, key, prop] of [
  [el.model, 'model', 'value'], [el.effort, 'effort', 'value'], [el.whisperModel, 'whisperModel', 'value'],
  [el.mic, 'micId', 'value'], [el.mic2, 'mic2Id', 'value'], [el.autoAnswer, 'autoAnswer', 'checked'], [el.systemAudio, 'systemAudio', 'checked'],
  [el.themeMode, 'themeMode', 'value'], [el.keepFocus, 'keepFocus', 'checked'],
]) node.addEventListener('change', () => save({ [key]: node[prop] }));
el.preset.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-preset]');
  if (!b || b.dataset.preset === settings.preset) return;
  settings = await halo.setPreset(b.dataset.preset);
  applyPreset();
  setStatus(settings.preset === 'code' ? 'Code: docked aside, answers code-first, auto-suggest off' : 'Talk: top of screen, spoken answers, auto-suggest on');
});
// Typing is the one thing that needs keyboard focus; hand it back when done.
el.askInput.addEventListener('mousedown', () => { if (settings.keepFocus !== false) halo.focusInput(); });
el.askInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); el.askInput.blur(); halo.releaseFocus(); } });
// Changing inputs while listening re-opens them so the change is immediate.
for (const node of [el.mic, el.mic2]) node.addEventListener('change', () => { if (mode === 'listen') onInputLost('input'); });
el.mic2.addEventListener('change', () => { if (el.mic2.value && el.mic2.value === el.mic.value) { el.mic2.value = ''; save({ mic2Id: '' }); } });
el.attachSetting.addEventListener('change', () => save({ attachScreen: el.attachSetting.checked }));
function updateCaptureAreaUI() {
  const area = settings.captureArea;
  $('#capture-area-status').textContent = area
    ? `Saved area: ${area.width} × ${area.height} at (${area.x}, ${area.y}). Captures reuse this display and area.`
    : 'No saved area. Captures use the margin crop on the display under your cursor.';
  $('#clear-capture-area').disabled = !area;
  $('#preview-capture').checked = Boolean(settings.previewCapture);
}
async function selectArea() {
  if (selectingArea) return;
  finishPreview(false);
  selectingArea = true;
  captureRevision++;
  try {
    settings = await halo.selectCaptureArea();
    convo = [];
    updateCaptureAreaUI();
  } catch (err) { showError(err.message); }
  finally { selectingArea = false; }
}
$('#select-capture-area').addEventListener('click', selectArea);
$('#clear-capture-area').addEventListener('click', async () => {
  captureRevision++;
  finishPreview(false);
  await save({ captureArea: null });
  convo = [];
  updateCaptureAreaUI();
});
$('#preview-capture').addEventListener('change', () => save({ previewCapture: $('#preview-capture').checked }));
for (const edge of ['top', 'bottom', 'left', 'right']) {
  const input = $(`#capture-${edge}`);
  input.addEventListener('mousedown', () => { if (settings.keepFocus !== false) halo.focusInput(); });
  input.addEventListener('blur', () => halo.releaseFocus());
  input.addEventListener('change', async () => {
    if (!input.reportValidity() || input.value === '') return;
    const key = `capture${edge[0].toUpperCase()}${edge.slice(1)}`;
    captureRevision++;
    finishPreview(false);
    await save({ [key]: input.valueAsNumber });
    // A follow-up must not reuse images containing newly excluded areas.
    convo = [];
  });
}
el.noise.addEventListener('change', () => { save({ noiseSuppression: el.noise.checked }); if (mode === 'listen') onInputLost('input'); });
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
  input.addEventListener('mousedown', () => { if (settings.keepFocus !== false) halo.focusInput(); });
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
for (const node of [el.apiKey, el.context, el.job]) node.addEventListener('mousedown', () => { if (settings.keepFocus !== false) halo.focusInput(); });
el.saveKey.addEventListener('click', saveKey);
el.apiKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey(); } });
for (const node of [el.mic, el.mic2]) node.addEventListener('focus', async () => { try { await halo.requestMic(); await populateMics(); } catch { /* ignore */ } });

// ---------------------------------------------------------------- wiring
el.tabs.addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) selectTab(t.dataset.tab); });
el.capture.addEventListener('click', () => runCapture(el.askInput.value.trim(), { screen: true }).then(() => { el.askInput.value = ''; }));
el.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = el.askInput.value.trim();
  el.askInput.value = '';
  el.askInput.blur();
  if (settings.keepFocus !== false) halo.releaseFocus();
  if (mode === 'listen' && q) {
    // In interview mode a typed question is answered with the transcript as context.
    ask('listen', interviewMessages(`The candidate asks you directly: ${q}`), { keep: true });
  } else runCapture(q);
});
el.listen.addEventListener('click', toggleListening);
el.answerNow.addEventListener('click', () => askInterview());
el.stop.addEventListener('click', () => current && halo.abort(current.id));
el.collapse.addEventListener('click', toggleCollapse);
el.copy.addEventListener('click', async () => {
  const text = ([...el.answer.querySelectorAll('.turn-a')].pop() || el.answer).innerText.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const old = el.copy.textContent; el.copy.textContent = 'Copied'; setTimeout(() => { el.copy.textContent = old; }, 1200);
});
el.clear.addEventListener('click', async () => {
  finishPreview(false);
  const req = current;
  current = null; // ignore its late 'aborted' event, which would otherwise settle a turn back into the cleared conversation
  if (req) await halo.abort(req.id);
  el.app.classList.remove('thinking');
  show(el.stop, false);
  convo = [];
  audio.segments = []; audio.answeredIndex = 0; audio.suggestions = []; audio.pendingAfter = false; clearTimeout(audio.pendingAnswer);
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
  if (e.key === 'Escape' && previewResolve) { finishPreview(false); return; }
  if (e.key === 'Escape' && !e.target.classList.contains('recorder')) {
    if (!el.settings.classList.contains('hidden')) closeSettings();
    else halo.hide();
  }
});
halo.onDocked((spot) => setStatus(`Moved to ${spot.replace('-', ' ')}`));
halo.onHotkey(({ action }) => {
  if (action === 'selectArea') selectArea();
  else if (action === 'capture') runCapture(el.askInput.value.trim(), { screen: true });
  else if (action === 'listen') toggleListening();
  else if (action === 'collapse') toggleCollapse();
  else if (action === 'settings') openSettings();
});

loadSettings().then(() => {
  if (!settings.hasKey) openSettings('account', 'Welcome. Paste your Anthropic API key to start. It is stored encrypted on this Mac and only ever sent to Anthropic.');
});
