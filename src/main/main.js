const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage,
  protocol, net, systemPreferences, session, shell, desktopCapturer, dialog,
} = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const config = require('./config');
const { streamAnswer, describeError } = require('./claude');
const { captureScreen } = require('./capture');
const { extractText } = require('./documents');

const DIST = path.join(__dirname, '..', '..', 'dist');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const WIDTH = 660;
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 820;
const VISIBLE_TO_CAPTURE = Boolean(process.env.HALO_VISIBLE); // debug only
const SMOKE = Boolean(process.env.HALO_SMOKE); // headless self-check used by `npm run smoke`

if (SMOKE) app.setPath('userData', path.join(require('node:os').tmpdir(), 'halo-smoke-' + process.pid));
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

// app:// is a privileged origin: fetch, Cache API, WebGPU and workers all work,
// unlike file://. That is what lets the Whisper model cache locally.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let tray = null;
const inflight = new Map(); // request id -> AbortController

// ------------------------------------------------------------------ window
function createWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  win = new BrowserWindow({
    width: WIDTH,
    height: MIN_HEIGHT,
    x: Math.round(x + (width - WIDTH) / 2),
    y: y + 10,
    frame: false,
    transparent: true,
    vibrancy: process.env.HALO_NO_VIBRANCY ? undefined : 'hud',
    visualEffectState: 'active',
    roundedCorners: true,
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
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
        workerOk: typeof Worker === 'function',
        isolated: self.crossOriginIsolated,
        webgpu: 'gpu' in navigator,
        height: document.querySelector('#app').getBoundingClientRect().height,
      })`);
      console.log('SMOKE', JSON.stringify(probe));
      app.exit(probe.hasLogo && probe.fontLoaded && probe.shortcutLabel ? 0 : 1);
    }, 1500));
  }
  win.loadURL('app://halo/index.html');
  win.once('ready-to-show', () => { if (!SMOKE) win.show(); });
  win.on('closed', () => { win = null; });
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else { win.show(); win.focus(); }
}

function sendHotkey(action) {
  if (!win) createWindow();
  if (!win.isVisible()) win.show();
  win.webContents.send('hotkey', { action });
}

// --------------------------------------------------------------- shortcuts
const ACTIONS = {
  toggle: () => toggleWindow(),
  capture: () => sendHotkey('capture'),
  listen: () => sendHotkey('listen'),
  collapse: () => sendHotkey('collapse'),
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
    { label: 'Capture screen & ask', accelerator: s.capture, click: ACTIONS.capture },
    { label: 'Toggle interview listening', accelerator: s.listen, click: ACTIONS.listen },
    { label: 'Collapse / expand panel', accelerator: s.collapse, click: ACTIONS.collapse },
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
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
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
    return { ...result, shortcutErrors };
  });

  ipcMain.handle('screen:capture', async () => captureScreen());

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
    if (process.platform !== 'darwin') return true;
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
  ipcMain.handle('shell:open', (_e, url) => { if (/^https?:/i.test(url)) return shell.openExternal(url); });

  ipcMain.on('window:resize', (_e, height) => {
    if (!win) return;
    const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(Number(height) || MIN_HEIGHT)));
    const b = win.getBounds();
    if (b.height !== h) win.setBounds({ x: b.x, y: b.y, width: WIDTH, height: h }, false);
  });
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
