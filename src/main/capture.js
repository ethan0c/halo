// Grabs the cropped display under the cursor. Because the overlay window has content
// protection on, it is automatically excluded from this capture.
const { desktopCapturer, screen, systemPreferences } = require('electron');

const MAX_EDGE = 1568; // Claude downsamples anything larger server-side anyway

async function captureScreen(crop = {}, area = null) {
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      throw new Error('Screen Recording permission is required. Enable it in System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch Halo.');
    }
  }
  const display = area ? screen.getAllDisplays().find(d => String(d.id) === String(area.displayId)) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (!display) throw new Error('The selected display is unavailable. Reselect the capture area in Settings → General.');
  if (area && (display.size.width !== area.displayWidth || display.size.height !== area.displayHeight)) {
    throw new Error('The selected display size changed. Reselect the capture area in Settings → General.');
  }
  const scale = display.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const source = sources.find((s) => String(s.display_id) === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error('Could not capture the screen.');

  let image = source.thumbnail;
  const original = image.getSize();
  const rect = area ? areaBounds(original, display.size, area) : cropBounds(original, display.size, crop);
  image = image.crop(rect);
  const { width, height } = image.getSize();
  const longest = Math.max(width, height);
  if (longest > MAX_EDGE) {
    const f = MAX_EDGE / longest;
    image = image.resize({ width: Math.round(width * f), height: Math.round(height * f), quality: 'best' });
  }
  const jpeg = image.toJPEG(85);
  const size = image.getSize();
  return { data: jpeg.toString('base64'), mediaType: 'image/jpeg', width: size.width, height: size.height };
}

// Margins use logical screen pixels; derive the actual thumbnail scale rather
// than assuming desktopCapturer always returns the requested Retina resolution.
function cropBounds(image, display, crop) {
  const margin = (edge) => {
    const value = crop[edge] ?? (edge === 'top' ? 120 : 0);
    if (!Number.isFinite(value) || value < 0) throw new Error('Screenshot crop margins must be non-negative numbers.');
    return value;
  };
  const x = Math.ceil(margin('left') * image.width / display.width);
  const y = Math.ceil(margin('top') * image.height / display.height);
  const right = Math.ceil(margin('right') * image.width / display.width);
  const bottom = Math.ceil(margin('bottom') * image.height / display.height);
  const width = image.width - x - right;
  const height = image.height - y - bottom;
  if (width < 1 || height < 1) throw new Error('Screenshot crop removes the entire display. Reduce the margins in Settings → General.');
  return { x, y, width, height };
}

function areaBounds(image, display, area) {
  if (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(area[k])) ||
      area.x < 0 || area.y < 0 || area.width < 8 || area.height < 8 ||
      area.x + area.width > display.width || area.y + area.height > display.height) {
    throw new Error('Invalid saved capture area. Reselect it in Settings → General.');
  }
  // Round inward so pixels outside the selection never enter the upload.
  const x = Math.ceil(area.x * image.width / display.width);
  const y = Math.ceil(area.y * image.height / display.height);
  const right = Math.floor((area.x + area.width) * image.width / display.width);
  const bottom = Math.floor((area.y + area.height) * image.height / display.height);
  if (right <= x || bottom <= y) throw new Error('The selected capture area is too small.');
  return { x, y, width: right - x, height: bottom - y };
}
module.exports = { captureScreen, cropBounds, areaBounds };
