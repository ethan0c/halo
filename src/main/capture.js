// Grabs the display under the cursor. Because the overlay window has content
// protection on, it is automatically excluded from this capture.
const { desktopCapturer, screen, systemPreferences } = require('electron');

const MAX_EDGE = 1568; // Claude downsamples anything larger server-side anyway

async function captureScreen() {
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      throw new Error('Screen Recording permission is required. Enable it in System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch Halo.');
    }
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('Could not capture the screen.');

  let image = source.thumbnail;
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

module.exports = { captureScreen };
