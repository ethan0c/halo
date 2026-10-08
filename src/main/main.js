const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage,
  protocol, net, systemPreferences, session, shell, desktopCapturer, dialog, nativeTheme,
} = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const config = require('./config');
const { streamAnswer, describeError } = require('./claude');
const { captureScreen } = require('./capture');
const { selectCaptureArea } = require('./selection');
const { extractText } = require('./documents');
const { luminanceOfBitmap, nextTheme } = require('./backdrop');

const DIST = path.join(__dirname, '..', '..', 'dist');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const WIDTHS = { talk: 660, code: 560 }; // Code docks to a side and should cover less of the editor
const DOCK_SPOTS = ['top-center', 'top-right', 'bottom-right', 'bottom-left', 'top-left'];
const PRESET_DOCK = { talk: 'top-center', code: 'top-right' };
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 820;
const VISIBLE_TO_CAPTURE = Boolean(process.env.HALO_VISIBLE);
const SMOKE = Boolean(process.env.HALO_SMOKE); // headless self-check used by `npm run smoke`

if (SMOKE) {
  app.setPath('userData', path.join(require('node:os').tmpdir(), 'halo-smoke-' + process.pid));
  // Keep the self-check off every macOS privacy prompt: fake media devices
  // instead of the real mic, an in-memory keychain instead of the login one.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-mock-keychain');
}
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) showWindow(); });

// app:// is a privileged origin: fetch, Cache API, WebGPU and workers all work,
// unlike file://. That is what lets the Whisper model cache locally.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let tray = null;
const inflight = new Map(); // request id -> AbortController

// ---------------------------------------------------------------- placement
const currentPreset = () => (config.load().preset === 'code' ? 'code' : 'talk');
let contentWidth = 0; // what the renderer says the bar needs; the preset width is only a floor
const currentWidth = () => Math.max(WIDTHS[currentPreset()], contentWidth);

/** Pixel position for a dock spot on a display, for the window's current size. */
function spotPosition(spot, display, width, height) {
  const a = display.workArea, m = 10;
  const xs = { left: a.x + m, center: Math.round(a.x + (a.width - width) / 2), right: a.x + a.width - width - m };
  const ys = { top: a.y + m, bottom: a.y + a.height - height - m };
  const [v, h] = spot.split('-');
  return { x: xs[h], y: ys[v] };
}

/** Where the window should go for the active preset: the user's last drag if that display is still here, else the preset's dock. */
function homePosition(height) {
  const preset = currentPreset();
  const saved = config.load().positions?.[preset];
  const width = WIDTHS[preset];
  if (saved) {
    const display = screen.getAllDisplays().find((d) => String(d.id) === String(saved.displayId));
    if (display) {
      const a = display.workArea;
      return { x: Math.min(Math.max(saved.x, a.x), a.x + a.width - width), y: Math.min(Math.max(saved.y, a.y), a.y + a.height - height) };
    }
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return spotPosition(PRESET_DOCK[preset], display, width, height);
}

let placing = false;
function placeWindow(pos) {
  if (!win) return;
  placing = true;
  const b = win.getBounds();
  win.setBounds({ x: pos.x, y: pos.y, width: currentWidth(), height: b.height }, false);
  setTimeout(() => { placing = false; }, 300);
}

let saveMoveTimer = null;
function rememberPosition() {
  if (!win || placing) return;
  clearTimeout(saveMoveTimer);
  saveMoveTimer = setTimeout(() => {
    if (!win) return;
    const b = win.getBounds();
    const display = screen.getDisplayMatching(b);
    const positions = { ...(config.load().positions || {}), [currentPreset()]: { x: b.x, y: b.y, displayId: String(display.id) } };
    config.update({ positions });
  }, 400);
}

let dockIndex = 0;
function cycleDock() {
  if (!win) return;
  dockIndex = (dockIndex + 1) % DOCK_SPOTS.length;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  placeWindow(spotPosition(DOCK_SPOTS[dockIndex], display, currentWidth(), b.height));
  const positions = { ...(config.load().positions || {}) };
  delete positions[currentPreset()]; // docking replaces a remembered drag
  config.update({ positions });
  win.webContents.send('docked', DOCK_SPOTS[dockIndex]);
}

// ----------------------------------------------------------- focus hygiene
// A proctoring tool or a video call can only see one thing about Halo: whether
// your browser or editor lost focus. So the window is non-activating. Clicking
// its buttons never steals focus; only typing in the question box does, and
// focus is handed straight back when you are done.
function keepFocusEnabled() { return config.load().keepFocus !== false; }
function applyFocusPolicy() { if (win) win.setFocusable(!keepFocusEnabled()); }
function grabFocusForTyping() {
  if (!win) return;
  win.setFocusable(true);
  win.show();
  win.focus();
}
function releaseFocus() {
  if (!win || !keepFocusEnabled()) return;
  win.setFocusable(false);
  if (process.platform === 'darwin') {
    // Deactivating the app returns focus to whatever was active before, then
    // the window comes back without taking focus with it.
    app.hide();
    win.showInactive();
  } else win.blur();
}
function showWindow({ focus = false } = {}) {
  if (!win) return createWindow();
  if (focus && !keepFocusEnabled()) { win.show(); win.focus(); } else win.showInactive();
}

// ------------------------------------------------------------------ window
function createWindow() {
  const width = currentWidth();
  const home = homePosition(MIN_HEIGHT);
  win = new BrowserWindow({
    width,
    height: MIN_HEIGHT,
    x: home.x,
    y: home.y,
    frame: false,
    transparent: true,
    roundedCorners: true,
    hasShadow: false,   // macOS builds its shadow from the alpha mask and draws a jagged outline on transparent windows; the CSS shadow does the job
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: !keepFocusEnabled(),
    show: false,
    title: 'Halo',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // The headline trick: NSWindowSharingNone. Screen recordings, Zoom, Meet,
  // Teams and QuickTime all see straight through this window.
  win.setContentProtection(!VISIBLE_TO_CAPTURE);
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (process.platform === 'darwin') win.setHiddenInMissionControl(true);

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (SMOKE) {
    win.webContents.on('console-message', (ev) => console.log(`[renderer:${ev.level}] ${ev.message}`));
    win.webContents.on('did-fail-load', (_e, code, desc) => { console.error('SMOKE FAIL load', code, desc); app.exit(1); });
    win.webContents.on('render-process-gone', (_e, d) => { console.error('SMOKE FAIL renderer gone', d); app.exit(1); });
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      const probe = await win.webContents.executeJavaScript(`({
        title: document.title,
        fontLoaded: document.fonts.check('13px "Geist Variable"'),
        hasLogo: !!document.querySelector('#logo svg'),
        settingsOpen: !document.querySelector('#settings').classList.contains('hidden'),
        shortcutLabel: document.querySelector('[data-shortcut="capture"]').textContent,
        barFits: (() => { const bar = document.querySelector('#bar'); return bar.scrollWidth <= bar.clientWidth + 1; })(),
        windowWidth: innerWidth,
        workerOk: typeof Worker === 'function',
        isolated: self.crossOriginIsolated,
        webgpu: 'gpu' in navigator,
        theme: document.documentElement.dataset.theme || null,
        textColor: getComputedStyle(document.body).color,
        height: document.querySelector('#app').getBoundingClientRect().height,
      })`);
      await sampleBackdrop();
      console.log('SMOKE', JSON.stringify(probe));
      if (process.env.HALO_SHOT) {
        // Renders the UI over a white page in both themes so contrast can be eyeballed.
        const fs = require('node:fs');
        win.showInactive();
        for (const [t, bg, alpha, preset] of [['dark', '#ffffff', 0.94, 'talk'], ['light', '#0b0b0d', 0.94, 'talk'], ['dark', '#7a7f87', 0.84, 'talk'], ['dark', '#ffffff', 0.94, 'code']]) {
          await win.webContents.executeJavaScript(`
            document.body.style.background = '${bg}';
            document.documentElement.dataset.theme = '${t}';
            document.documentElement.style.setProperty('--glass-a', '${alpha}');
            document.querySelector('#app').dataset.preset = '${preset}';
            document.querySelector('#app').style.width = '${preset === 'code' ? WIDTHS.code : WIDTHS.talk}px';
            document.querySelector('#settings').classList.add('hidden');
            document.querySelector('#panel').classList.remove('hidden');
            document.querySelector('#answer').innerHTML = '<div class="turn-q"><span class="shot-tag">Screen</span><span>What is on my screen?</span></div><div class="turn-a"><p><strong>Answer:</strong> use a hash map for O(n) lookups.</p></div><div class="turn-q"><span class="shot-tag">Screen</span><span>What about the follow-up part?</span></div><div class="turn-a"><pre><code>const seen = new Map();</code></pre></div>';
            document.querySelector('#status').textContent = 'claude-opus-5-5 · 812 tok';
          `);
          await new Promise((r) => setTimeout(r, 500));
          const fit = await win.webContents.executeJavaScript(`(() => { const bar = document.querySelector('#bar'); return { preset: '${preset}', width: bar.clientWidth, needed: bar.scrollWidth, fits: bar.scrollWidth <= bar.clientWidth + 1, input: document.querySelector('#ask-input').clientWidth }; })()`);
          console.log('SMOKE fit', JSON.stringify(fit));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(process.env.HALO_SHOT, `halo-${preset}-${t}-${bg.slice(1)}.png`), img.toPNG());
        }
      }
      app.exit(probe.hasLogo && probe.fontLoaded && probe.shortcutLabel ? 0 : 1);
    }, 1500));
  }
  win.loadURL('app://halo/index.html');
  win.once('ready-to-show', () => { if (!SMOKE) win.showInactive(); });
  win.on('moved', rememberPosition);
  win.on('show', startBackdropSampling);
  win.on('hide', stopBackdropSampling);
  win.on('closed', () => { win = null; stopBackdropSampling(); });
  win.webContents.on('did-finish-load', () => { if (theme.current) win.webContents.send('theme', theme.current); });
}

// ------------------------------------------------------------------- theme
// Dark glass over bright content, light glass over dark content. In 'auto'
// mode we sample a small thumbnail of the display every couple of seconds and
// read the mean luminance of the area under the window.
const theme = { current: null, timer: null, votes: 0, candidate: null, busy: false };
const SAMPLE_MS = 2000;

function applyTheme(next) {
  if (next === theme.current) return;
  theme.current = next;
  nativeTheme.themeSource = next;            // keeps native bits (select menus, scrollbars) in step with the glass
  if (win && !win.isDestroyed()) win.webContents.send('theme', next);
}

async function sampleBackdrop() {
  if (process.env.HALO_SHOT) return; // screenshot mode sets themes by hand
  if (theme.busy || !win || win.isDestroyed() || !win.isVisible()) return;
  const mode = config.load().themeMode || 'auto';
  if (mode === 'dark' || mode === 'light') return applyTheme(mode);
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    return applyTheme(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'); // no permission yet: follow the OS appearance
  }
  theme.busy = true;
  try {
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const scale = 192 / display.bounds.width;
    const thumbnailSize = { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return;
    const size = source.thumbnail.getSize();
    const sx = size.width / display.bounds.width, sy = size.height / display.bounds.height;
    const rect = {
      x: (bounds.x - display.bounds.x) * sx - 2, y: (bounds.y - display.bounds.y) * sy - 2,
      width: bounds.width * sx + 4, height: bounds.height * sy + 4,
    };
    const lum = luminanceOfBitmap(source.thumbnail.toBitmap(), size.width, size.height, rect);
    win.webContents.send('backdrop', lum); // renderer tunes glass opacity to it
    const next = nextTheme(theme.current, lum);
    if (next === theme.current) { theme.candidate = null; theme.votes = 0; return; }
    theme.votes = theme.candidate === next ? theme.votes + 1 : 1;
    theme.candidate = next;
    if (theme.votes >= 3 || !theme.current) applyTheme(next); // three agreeing samples (6 s) before flipping
    if (SMOKE) console.log('SMOKE backdrop', JSON.stringify({ lum: Number(lum.toFixed(3)), theme: theme.current }));
  } catch (err) {
    console.warn('backdrop sample failed', err.message);
  } finally { theme.busy = false; }
}
function startBackdropSampling() {
  stopBackdropSampling();
  sampleBackdrop();
  theme.timer = setInterval(sampleBackdrop, SAMPLE_MS);
}
function stopBackdropSampling() { clearInterval(theme.timer); theme.timer = null; }

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else showWindow();
}

function sendHotkey(action) {
  if (!win) createWindow();
  if (!win.isVisible()) showWindow();
  win.webContents.send('hotkey', { action });
}

// --------------------------------------------------------------- shortcuts
const ACTIONS = {
  toggle: () => toggleWindow(),
  selectArea: () => sendHotkey('selectArea'),
  capture: () => sendHotkey('capture'),
  listen: () => sendHotkey('listen'),
  collapse: () => sendHotkey('collapse'),
  dock: () => cycleDock(),
};

/** Registers the configured shortcuts. Returns { action: accelerator } for any that failed. */
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const failed = {};
  const shortcuts = config.load().shortcuts || {};
  for (const [action, fn] of Object.entries(ACTIONS)) {
    const accel = shortcuts[action];
    if (!accel) continue;
    let ok = false;
    try { ok = globalShortcut.register(accel, fn); } catch { ok = false; }
    if (!ok) { failed[action] = accel; console.warn('Could not register shortcut', action, accel); }
  }
  return failed;
}

function buildTrayMenu() {
  const s = config.load().shortcuts || {};
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', accelerator: s.toggle, click: toggleWindow },
    { label: 'Select capture area', accelerator: s.selectArea, click: ACTIONS.selectArea },
    { label: 'Capture screen & ask', accelerator: s.capture, click: ACTIONS.capture },
    { label: 'Toggle interview listening', accelerator: s.listen, click: ACTIONS.listen },
    { label: 'Collapse / expand panel', accelerator: s.collapse, click: ACTIONS.collapse },
    { label: 'Move to next corner', accelerator: s.dock, click: ACTIONS.dock },
    { type: 'separator' },
    { label: 'Settings…', click: () => sendHotkey('settings') },
    { type: 'separator' },
    { label: 'Quit Halo', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Halo');
  buildTrayMenu();
  tray.on('click', toggleWindow);
}

// ---------------------------------------------------------------- protocol
function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep) || !require('node:fs').existsSync(file)) {
      console.warn('app:// request for a file that does not exist:', rel);
      return new Response('Not found', { status: 404 });
    }
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    // Cross-origin isolation lets ONNX Runtime use threads for transcription.
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    if (file.endsWith('.mjs') || file.endsWith('.js')) headers.set('Content-Type', 'text/javascript');
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    return new Response(res.body, { status: res.status, headers });
  });
}

function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  // Optional system-audio capture (Electron supports loopback on Windows only;
  // on macOS pick a loopback input device such as BlackHole in Settings).
  ses.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined });
    } catch (err) {
      console.error('display media request failed', err);
      callback({});
    }
  });
}

// --------------------------------------------------------------------- ipc
function registerIpc() {
  ipcMain.handle('settings:get', () => ({ ...config.getPublic(), shortcutErrors: {} }));
  ipcMain.handle('settings:set', (_e, patch) => {
    const result = config.update(patch || {});
    let shortcutErrors = {};
    if (patch && patch.shortcuts && !SMOKE) { shortcutErrors = registerShortcuts(); buildTrayMenu(); }
    if (patch && patch.themeMode) sampleBackdrop();
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'keepFocus')) applyFocusPolicy();
    return { ...result, shortcutErrors };
  });

  ipcMain.handle('screen:select-area', async () => {
    const area = await selectCaptureArea();
    if (area) config.update({ captureArea: area });
    return config.getPublic();
  });
  ipcMain.handle('screen:capture', async () => {
    const settings = config.load();
    return captureScreen({ top: settings.captureTop, bottom: settings.captureBottom, left: settings.captureLeft, right: settings.captureRight }, settings.captureArea);
  });

  ipcMain.handle('document:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a document',
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'html'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths[0]) return null;
    return extractText(filePaths[0]);
  });

  ipcMain.handle('claude:ask', async (event, req) => {
    const { id, mode, messages } = req;
    const apiKey = config.getApiKey();
    const send = (payload) => { if (!event.sender.isDestroyed()) event.sender.send('claude:event', { id, ...payload }); };
    if (!apiKey) { send({ type: 'error', message: 'Add your Anthropic API key in Settings → Account first.' }); return; }
    const settings = config.load();
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      const result = await streamAnswer({
        apiKey, mode, messages,
        model: settings.model, effort: settings.effort,
        profile: { resume: settings.resume, job: settings.job, context: settings.context },
        signal: controller.signal,
        onDelta: (text) => send({ type: 'delta', text }),
      });
      if (result.stopReason === 'refusal') {
        send({ type: 'error', message: `Claude declined this request${result.stopDetails?.category ? ` (${result.stopDetails.category})` : ''}.` });
      } else {
        send({ type: 'done', text: result.text, stopReason: result.stopReason, usage: result.usage, model: result.model });
      }
    } catch (err) {
      if (!controller.signal.aborted) console.error('claude error', err);
      send({ type: controller.signal.aborted ? 'aborted' : 'error', message: describeError(err) });
    } finally {
      inflight.delete(id);
    }
  });
  ipcMain.handle('claude:abort', (_e, id) => { inflight.get(id)?.abort(); inflight.delete(id); });

  ipcMain.handle('mic:request', async () => {
    if (process.platform !== 'darwin' || SMOKE) return true;
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
  ipcMain.handle('shell:open', (_e, url) => { if (/^https?:/i.test(url)) return shell.openExternal(url); });

  ipcMain.on('window:resize', (_e, size) => {
    if (!win) return;
    const req = typeof size === 'object' && size ? size : { height: size };
    const b = win.getBounds();
    const display = screen.getDisplayMatching(b);
    const a = display.workArea;
    const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(Number(req.height) || MIN_HEIGHT)));
    if (Number.isFinite(req.width) && req.width > 0) contentWidth = Math.ceil(req.width);
    const w = Math.min(currentWidth(), a.width - 20);
    if (b.height === h && b.width === w) return;
    // Keep whichever edge the user anchored to: right-docked bars grow leftwards,
    // centred bars stay centred, bottom-docked bars grow upwards.
    const nearRight = b.x + b.width > a.x + a.width - 40;
    const centred = Math.abs((b.x + b.width / 2) - (a.x + a.width / 2)) < 40;
    const nearBottom = b.y + b.height > a.y + a.height - 40;
    let x = nearRight ? b.x + b.width - w : centred ? Math.round(a.x + (a.width - w) / 2) : b.x;
    x = Math.min(Math.max(x, a.x), a.x + a.width - w);
    const y = nearBottom ? Math.max(a.y, b.y + b.height - h) : b.y;
    placing = true;
    // Only panel open/close asks to animate: on macOS an animated setBounds blocks
    // the main process for its duration, so streaming growth must stay instant.
    win.setBounds({ x, y, width: w, height: h }, Boolean(req.animate));
    setTimeout(() => { placing = false; }, 300);
  });
  ipcMain.handle('window:preset', (_e, preset) => {
    config.update({ preset: preset === 'code' ? 'code' : 'talk' });
    if (!win) return;
    const b = win.getBounds();
    placeWindow(homePosition(b.height));
    return config.getPublic();
  });
  ipcMain.on('window:focus-input', grabFocusForTyping);
  ipcMain.on('window:release-focus', releaseFocus);
  ipcMain.on('window:hide', () => win?.hide());
  ipcMain.on('app:quit', () => app.quit());
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide(); // menu-bar app, no Dock icon
  registerAppProtocol();
  setupSession();
  registerIpc();
  if (!SMOKE) { createTray(); registerShortcuts(); }
  createWindow();
});

app.on('window-all-closed', () => { /* keep running in the menu bar */ });
app.on('activate', () => { if (!win) createWindow(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
