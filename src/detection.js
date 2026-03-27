// Detection: column-scan dark-object detector
// MediaPipe inference removed — pure pixel analysis, no ML overhead.

export let cvReady = false;
export function loadOpenCVIfNeeded() {} // no-op — OpenCV no longer loaded

export const noteCooldowns = {};

export function shouldTriggerNote(noteId, now, cooldownMs = 250) {
  const last = noteCooldowns[noteId] || 0;
  if (now - last < cooldownMs) return false;
  noteCooldowns[noteId] = now;
  return true;
}

/* ── Column-scan dark-object detector ── */

// Narrow canvas for live-video column reads (11 × 240 px)
const colCanvas = document.createElement('canvas');
colCanvas.width = 11;
colCanvas.height = 240;
const colCtx = colCanvas.getContext('2d', { willReadFrequently: true });

// ─── Photo pre-scan cache ─────────────────────────────────────────────────────
// For static photos: getImageData runs ONCE on photo load, not every 280 ms.
// Per-column lookup is then just a Float32Array slice — nearly instant.
const PHOTO_SCAN_H = 240;
const photoScanCanvas = document.createElement('canvas');
const photoScanCtx = photoScanCanvas.getContext('2d', { willReadFrequently: true });
let _photoCache = null;   // Float32Array[H * W] row-major brightness
let _photoCacheW = 0;
let _photoCacheDispW = 1;
let _photoBgBright = -1;  // pre-computed from full image — stable across all scan columns

/**
 * Pre-scan a static photo into a brightness cache.
 * Must be called after photoImgEl is fully decoded and staffData is set.
 */
export function buildPhotoScanCache(source, staffData) {
  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  const dispW = staffData?.displayWidth || 320;
  const dispH = staffData?.displayHeight || 240;
  if (!srcW || !srcH || !dispW || !dispH) { _photoCache = null; return; }

  // Cache at display aspect, 240 px tall (matches column-scan H)
  const W = Math.min(400, Math.max(1, Math.round(PHOTO_SCAN_H * dispW / dispH)));
  const H = PHOTO_SCAN_H;
  photoScanCanvas.width  = W;
  photoScanCanvas.height = H;
  photoScanCtx.fillStyle = '#000';
  photoScanCtx.fillRect(0, 0, W, H);

  // Contain-fit — mirrors CSS background-size:contain
  const scale = Math.min(W / srcW, H / srcH);
  const drawW = srcW * scale, drawH = srcH * scale;
  const dx = (W - drawW) / 2,  dy = (H - drawH) / 2;
  photoScanCtx.drawImage(source, 0, 0, srcW, srcH, dx, dy, drawW, drawH);

  const imgData = photoScanCtx.getImageData(0, 0, W, H);
  const px = imgData.data;
  _photoCache = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      _photoCache[y * W + x] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
  }
  _photoCacheW    = W;
  _photoCacheDispW = dispW;

  // Pre-compute a single stable background brightness for the whole image.
  // Using the full image (not per-column) means the same pixel always produces
  // the same result on every scan pass — no flickering.
  let sum = 0, sumSq = 0;
  const N = _photoCache.length;
  for (let i = 0; i < N; i++) { const v = _photoCache[i]; sum += v; sumSq += v * v; }
  const mean = sum / N;
  _photoBgBright = Math.max(mean, mean + 0.84 * Math.sqrt(Math.max(0, sumSq / N - mean * mean)));
}

export function clearPhotoScanCache() {
  _photoCache = null;
  _photoCacheW = 0;
  _photoBgBright = -1;
}

/**
 * Detect dark objects (birds, leaves, silhouettes) by sampling a thin pixel
 * column at scanX and comparing local brightness to the column background.
 *
 * Uses local AVERAGE (not min) so thin power wires (1 px) don't trigger —
 * only blobs with real visual mass (birds ≥ 3 px, leaves, etc.) register.
 *
 * Returns [{detected, confidence, y, noteIndex}] for every note position.
 */
function detectDarkObjectsAtScanLine(source, staffData, scanX, sensitivity) {
  const dispW = staffData.displayWidth || 320;
  const dispH = staffData.displayHeight || 240;
  const H = PHOTO_SCAN_H; // 240
  const scaleY = H / dispH;
  const smB = new Float32Array(H);

  // ── Photo cache path: instant Float32Array read, no drawImage/getImageData ──
  if (_photoCache && _photoCacheW > 0 && !(source instanceof HTMLVideoElement)) {
    const W = _photoCacheW;
    const fraction = Math.max(0, Math.min(1, scanX / (_photoCacheDispW || dispW)));
    const cx = Math.round(fraction * (W - 1));
    const x0 = Math.max(0, cx - 2), x1 = Math.min(W - 1, cx + 2);
    const cols = x1 - x0 + 1;
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let x = x0; x <= x1; x++) s += _photoCache[y * W + x];
      smB[y] = s / cols;
    }
  } else {
    // ── Live video path: read 11 × 240 strip from current frame ────────────
    const srcW = source.videoWidth || source.naturalWidth || source.width || dispW;
    const srcH = source.videoHeight || source.naturalHeight || source.height || dispH;
    if (!srcW || !srcH) return null;

    const fraction = Math.max(0, Math.min(1, scanX / dispW));
    const srcCX = fraction * srcW;
    const srcHalf = Math.max(1, Math.round(5 * srcW / dispW));
    const srcX0 = Math.max(0, Math.round(srcCX - srcHalf));
    const srcStripW = Math.min(srcHalf * 2 + 1, srcW - srcX0);
    if (srcStripW <= 0) return null;

    if (colCanvas.height !== H) colCanvas.height = H;
    colCtx.drawImage(source, srcX0, 0, srcStripW, srcH, 0, 0, 11, H);
    const imgData = colCtx.getImageData(0, 0, 11, H);
    const px = imgData.data;

    const rowB = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let x = 0; x < 11; x++) {
        const i = (y * 11 + x) * 4;
        s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      }
      rowB[y] = s / 11;
    }
    // Smooth ±2 rows to suppress single-pixel JPEG grain
    for (let y = 0; y < H; y++) {
      let s = 0, c = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < H) { s += rowB[yy]; c++; }
      }
      smB[y] = s / c;
    }
  }

  // ── Background brightness ─────────────────────────────────────────────────
  // Photo: use pre-computed global value (stable — same result every scan pass)
  // Live:  compute per-column (no cache available)
  let bgBright;
  if (_photoCache && _photoBgBright >= 0 && !(source instanceof HTMLVideoElement)) {
    bgBright = _photoBgBright;
  } else {
    let sum = 0, sumSq = 0;
    for (let i = 0; i < H; i++) { const v = smB[i]; sum += v; sumSq += v * v; }
    const mean = sum / H;
    bgBright = Math.max(mean, mean + 0.84 * Math.sqrt(Math.max(0, sumSq / H - mean * mean)));
  }

  const threshFrac = 0.28 - (sensitivity / 100) * 0.20;

  return staffData.positions.map((pos, i) => {
    const cy = Math.round(pos.y * scaleY);
    const r = 7;
    let sumArea = 0, cnt = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = cy + dy;
      if (yy >= 0 && yy < H) { sumArea += smB[yy]; cnt++; }
    }
    const localAvg = cnt > 0 ? sumArea / cnt : bgBright;
    const darkScore = (bgBright - localAvg) / (bgBright + 1);
    const detected = bgBright > 30 && darkScore > threshFrac;
    const confidence = detected
      ? Math.min(1, (darkScore - threshFrac) / Math.max(0.01, 0.4 - threshFrac))
      : 0;
    return { detected, confidence, y: pos.y, noteIndex: i };
  });
}

/* ── Main export ── */
let _videoEl = null; // cached to avoid per-frame DOM query

export function detectObjects({ appMode, photoImgEl, staffData, scanX, sensitivity }) {
  if (!staffData) return null;
  const source = (appMode === 'photo' && photoImgEl)
    ? photoImgEl
    : (_videoEl || (_videoEl = document.getElementById('cameraVideo')));
  if (!source) return null;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return null;
  return detectDarkObjectsAtScanLine(source, staffData, scanX, sensitivity);
}
