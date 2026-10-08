// Decides whether the glass should be dark or light by looking at what is on
// screen behind the overlay. The overlay itself is content-protected, so it
// never shows up in its own sample.

/**
 * Mean perceived luminance (0..1) of a rectangle inside a BGRA bitmap.
 * Pure function so it can be unit-tested without Electron.
 */
function luminanceOfBitmap(bitmap, width, height, rect) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2];
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
    }
  }
  return n ? sum / n / 255 : 0.5;
}

/**
 * Hysteresis: a bright backdrop wants dark glass, a dark backdrop wants light
 * glass, and the theme only flips once the luminance clearly crosses over.
 */
function nextTheme(currentTheme, luminance) {
  if (currentTheme === 'dark') return luminance < 0.3 ? 'light' : 'dark';
  if (currentTheme === 'light') return luminance > 0.6 ? 'dark' : 'light';
  return luminance > 0.47 ? 'dark' : 'light';
}

module.exports = { luminanceOfBitmap, nextTheme };
