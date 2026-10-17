// Primary-display screenshot capture for Jev Vision mode. Requires electron,
// so it is only loaded by main.js and scripts/jev-vision-probe.js. Contract:
// docs/jev-vision/CONTRACT.md section 3.6.

const { screen, desktopCapturer } = require('electron');
const { fitImageSize, validateImageDims } = require('./jev-vision');

/**
 * DisplayInfo for the primary display. `phys` comes from screen.dipToScreenRect
 * so UIA rects (physical) can be normalized against it.
 */
function primaryDisplayInfo() {
  const d = screen.getPrimaryDisplay();
  const r = screen.dipToScreenRect(null, d.bounds);
  return {
    dipW: d.bounds.width,
    dipH: d.bounds.height,
    physX: r.x,
    physY: r.y,
    physW: r.width,
    physH: r.height,
    scaleFactor: d.scaleFactor,
  };
}

/**
 * Capture the whole primary display as a JPEG sized inside the API limits.
 * Never throws.
 * @param {{ maxSide:number, quality:number }} opts
 * @returns {Promise<{ok:true, jpeg:Buffer, width:number, height:number, ms:number}|{ok:false, error:string}>}
 */
async function capturePrimaryJpeg({ maxSide, quality }) {
  const start = Date.now();
  try {
    const primary = screen.getPrimaryDisplay();
    const phys = screen.dipToScreenRect(null, primary.bounds);
    const size = fitImageSize(phys.width, phys.height, maxSide);
    if (!size) return { ok: false, error: `no valid capture size for ${phys.width}x${phys.height}` };

    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    if (!sources || !sources.length) return { ok: false, error: 'no capture sources' };

    // getSources()[0] is not guaranteed to be the primary display (T2).
    // Only fall back to sources[0] when it is the sole source; with several and
    // no display_id match we could be looking at the wrong monitor.
    const src = sources.find(s => String(s.display_id) === String(primary.id)) ||
      (sources.length === 1 ? sources[0] : null);
    if (!src) return { ok: false, error: 'primary source not found' };
    const thumb = src.thumbnail;
    const actual = thumb.getSize();

    if (!validateImageDims(actual.width, actual.height)) {
      return { ok: false, error: `capture ${actual.width}x${actual.height} outside limits` };
    }
    const dispAspect = phys.width / phys.height;
    const imgAspect = actual.width / actual.height;
    if (Math.abs(imgAspect - dispAspect) / dispAspect > 0.01) {
      return { ok: false, error: `capture aspect ${imgAspect.toFixed(4)} != display ${dispAspect.toFixed(4)}` };
    }

    const jpeg = thumb.toJPEG(quality);
    return { ok: true, jpeg, width: actual.width, height: actual.height, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'capture failed' };
  }
}

module.exports = { primaryDisplayInfo, capturePrimaryJpeg };
