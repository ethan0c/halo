// Local-only selection overlay. It never captures or uploads screen pixels.
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
let pending = null;
function selectCaptureArea() {
  if (pending) return pending;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  pending = new Promise((resolve, reject) => {
    const selector = new BrowserWindow({
      ...display.bounds, frame: false, transparent: true, resizable: false,
      movable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, '../selection-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    selector.setContentProtection(true);
    selector.setAlwaysOnTop(true, 'screen-saver', 2);
    selector.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    let result = null;
    const finish = (event, rect) => {
      if (event.sender !== selector.webContents) return;
      if (rect && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k])) &&
          rect.x >= 0 && rect.y >= 0 && rect.width >= 8 && rect.height >= 8 &&
          rect.x + rect.width <= display.size.width && rect.y + rect.height <= display.size.height) {
        result = { ...rect, displayId: String(display.id), displayWidth: display.size.width, displayHeight: display.size.height };
      }
      selector.close();
    };
    ipcMain.on('capture-area:finish', finish);
    selector.on('closed', () => { ipcMain.removeListener('capture-area:finish', finish); resolve(result); });
    selector.webContents.on('will-navigate', e => e.preventDefault());
    selector.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    selector.once('ready-to-show', () => selector.show());
    selector.loadURL('app://halo/selection.html').catch(err => { reject(err); selector.close(); });
  }).finally(() => { pending = null; });
  return pending;
}
module.exports = { selectCaptureArea };
