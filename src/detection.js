// Detection: column-scan multi-signal detector
// Three signals combined: darkness, local edge contrast, and color saturation.
// All signals are relative to the column's own statistics — self-adapting per scene.

export let cvReady = false;
export function loadOpenCVIfNeeded() {} // no-op — OpenCV no longer loaded

export const noteCooldowns = {};

export function shouldTriggerNote(noteId, now, cooldownMs = 250) {
  const last = noteCooldowns[noteId] || 0;
  if (now - last < cooldownMs) return false;
  noteCooldowns[noteId] = now;
  return true;
}

/* ── Column-scan detector ── */

// Narrow canvas for live-video column reads (11 × 240 px)
const colCanvas = document.createElement('canvas');
colCanvas.width = 11;
colCanvas.height = 240;
const colCtx = colCanvas.getContext('2d', { willReadFrequently: true });

// Pre-allocated reusable buffers — avoid Float32Array GC churn on every detection call
const _rowBBuf  = new Float32Array(240); // raw per-row brightness
const _smBBuf   = new Float32Array(240); // smoothed brightness
const _rowSatBuf = new Float32Array(240); // raw per-row saturation
const _smSatBuf  = new Float32Array(240); // smoothed saturation (reusable for photo path)

// ── Live strip cache ────────────────────────────────────────────────────────
const _liveSmB  = new Float32Array(240);
const _liveSat  = new Float32Array(240); // saturation per row
let   _liveBgBright = -1;
let   _liveAvgSat   = 0;
let   _liveSerial   = 0;
let   _lastLiveSerial = -1;

// Inline HSV saturation from 0-255 R,G,B → 0-1
function _sat(r, g, b) {
  const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
  return max > 0 ? (max - min) / max : 0;
}

/**
 * Capture a vertical pixel strip from the live camera.
 * Computes brightness AND saturation per row.
 * Call from the rVFC callback so GPU→CPU stall is outside the rAF loop.
 */
export function captureLiveStrip(source, scanX, staffData) {
  if (!source || source.readyState < 2 || !staffData) return;
  const dispW = staffData.displayWidth || 320;
  const dispH = staffData.displayHeight || 240;
  const H = PHOTO_SCAN_H;
  const srcW = source.videoWidth || dispW;
  const srcH = source.videoHeight || dispH;
  if (!srcW || !srcH) return;

  const fraction  = Math.max(0, Math.min(1, scanX / dispW));
  const srcCX     = fraction * srcW;
  const srcHalf   = Math.max(1, Math.round(5 * srcW / dispW));
  const srcX0     = Math.max(0, Math.round(srcCX - srcHalf));
  const srcStripW = Math.min(srcHalf * 2 + 1, srcW - srcX0);
  if (srcStripW <= 0) return;

  if (colCanvas.height !== H) colCanvas.height = H;
  colCtx.drawImage(source, srcX0, 0, srcStripW, srcH, 0, 0, 11, H);
  const imgData = colCtx.getImageData(0, 0, 11, H);
  const px = imgData.data;

  for (let y = 0; y < H; y++) {
    let sB = 0, sSat = 0;
    for (let x = 0; x < 11; x++) {
      const i = (y * 11 + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      sB   += 0.299 * r + 0.587 * g + 0.114 * b;
      sSat += _sat(r, g, b);
    }
    _rowBBuf[y]   = sB   / 11;
    _rowSatBuf[y] = sSat / 11;
  }
  // Smooth ±1 row
  for (let y = 0; y < H; y++) {
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < H - 1 ? y + 1 : y;
    _liveSmB[y] = (_rowBBuf[y0]   + _rowBBuf[y]   + _rowBBuf[y1])   / 3;
    _liveSat[y] = (_rowSatBuf[y0] + _rowSatBuf[y] + _rowSatBuf[y1]) / 3;
  }

  let sum = 0, sumSq = 0, satSum = 0;
  for (let i = 0; i < H; i++) {
    const v = _liveSmB[i];
    sum += v; sumSq += v * v;
    satSum += _liveSat[i];
  }
  const mean = sum / H;
  _liveBgBright = Math.max(mean, mean + 0.84 * Math.sqrt(Math.max(0, sumSq / H - mean * mean)));
  _liveAvgSat   = satSum / H;
  _liveSerial++;
}

// ─── Photo pre-scan cache ─────────────────────────────────────────────────────
const PHOTO_SCAN_H = 240;
const photoScanCanvas = document.createElement('canvas');
const photoScanCtx = photoScanCanvas.getContext('2d', { willReadFrequently: true });
let _photoCache    = null; // Float32Array[H * W] brightness
let _photoSatCache = null; // Float32Array[H * W] saturation
let _photoCacheW    = 0;
let _photoCacheDispW = 1;
let _photoBgBright  = -1;
let _photoAvgSat    = 0;

export function buildPhotoScanCache(source, staffData) {
  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  const dispW = staffData?.displayWidth || 320;
  const dispH = staffData?.displayHeight || 240;
  if (!srcW || !srcH || !dispW || !dispH) { _photoCache = null; return; }

  const W = Math.min(400, Math.max(1, Math.round(PHOTO_SCAN_H * dispW / dispH)));
  const H = PHOTO_SCAN_H;
  photoScanCanvas.width  = W;
  photoScanCanvas.height = H;
  photoScanCtx.fillStyle = '#000';
  photoScanCtx.fillRect(0, 0, W, H);

  const scale = Math.min(W / srcW, H / srcH);
  const drawW = srcW * scale, drawH = srcH * scale;
  const dx = (W - drawW) / 2,  dy = (H - drawH) / 2;
  photoScanCtx.drawImage(source, 0, 0, srcW, srcH, dx, dy, drawW, drawH);

  const imgData = photoScanCtx.getImageData(0, 0, W, H);
  const px = imgData.data;
  const N = W * H;
  _photoCache    = new Float32Array(N);
  _photoSatCache = new Float32Array(N);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      _photoCache[y * W + x]    = 0.299 * r + 0.587 * g + 0.114 * b;
      _photoSatCache[y * W + x] = _sat(r, g, b);
    }
  }
  _photoCacheW    = W;
  _photoCacheDispW = dispW;

  let sum = 0, sumSq = 0, satSum = 0;
  for (let i = 0; i < N; i++) {
    const v = _photoCache[i];
    sum += v; sumSq += v * v;
    satSum += _photoSatCache[i];
  }
  const mean = sum / N;
  _photoBgBright = Math.max(mean, mean + 0.84 * Math.sqrt(Math.max(0, sumSq / N - mean * mean)));
  _photoAvgSat   = satSum / N;
}

export function clearPhotoScanCache() {
  _photoCache    = null;
  _photoSatCache = null;
  _photoCacheW   = 0;
  _photoBgBright = -1;
  _photoAvgSat   = 0;
}

/**
 * Multi-signal detection at a scan column:
 *
 *   darkScore  — position darker than column background  (silhouettes, objects)
 *   edgeScore  — local brightness range in window        (rooflines, borders, outlines)
 *   satScore   — more colorful than column average       (leaves, signs, any vivid element)
 *
 * All scores are relative to the column's own statistics → self-adapting per scene.
 * Final score = max(darkScore, edgeScore × 0.75, satScore × 1.2)
 */
function detectAtScanLine(source, staffData, scanX, sensitivity) {
  const dispW = staffData.displayWidth || 320;
  const dispH = staffData.displayHeight || 240;
  const H = PHOTO_SCAN_H;
  const scaleY = H / dispH;

  let smB, smSat, bgBright, avgSat;

  // ── Photo cache path ──────────────────────────────────────────────────────
  if (_photoCache && _photoCacheW > 0 && !(source instanceof HTMLVideoElement)) {
    smB   = _smBBuf;
    smSat = _smSatBuf;
    const W = _photoCacheW;
    const fraction = Math.max(0, Math.min(1, scanX / (_photoCacheDispW || dispW)));
    const cx = Math.round(fraction * (W - 1));
    const x0 = Math.max(0, cx - 2), x1 = Math.min(W - 1, cx + 2);
    const cols = x1 - x0 + 1;
    for (let y = 0; y < H; y++) {
      let sB = 0, sSat = 0;
      for (let x = x0; x <= x1; x++) {
        sB   += _photoCache[y * W + x];
        sSat += _photoSatCache[y * W + x];
      }
      smB[y]   = sB   / cols;
      smSat[y] = sSat / cols;
    }
    bgBright = _photoBgBright;
    avgSat   = _photoAvgSat;

  // ── Live strip cache path ─────────────────────────────────────────────────
  } else if (_liveSerial !== _lastLiveSerial && source instanceof HTMLVideoElement) {
    _lastLiveSerial = _liveSerial;
    smB      = _liveSmB;
    smSat    = _liveSat;
    bgBright = _liveBgBright;
    avgSat   = _liveAvgSat;

  } else {
    // ── Fallback live path ────────────────────────────────────────────────
    const srcW = source.videoWidth || source.naturalWidth || source.width || dispW;
    const srcH = source.videoHeight || source.naturalHeight || source.height || dispH;
    if (!srcW || !srcH) return null;

    const fraction  = Math.max(0, Math.min(1, scanX / dispW));
    const srcCX     = fraction * srcW;
    const srcHalf   = Math.max(1, Math.round(5 * srcW / dispW));
    const srcX0     = Math.max(0, Math.round(srcCX - srcHalf));
    const srcStripW = Math.min(srcHalf * 2 + 1, srcW - srcX0);
    if (srcStripW <= 0) return null;

    if (colCanvas.height !== H) colCanvas.height = H;
    colCtx.drawImage(source, srcX0, 0, srcStripW, srcH, 0, 0, 11, H);
    const imgData = colCtx.getImageData(0, 0, 11, H);
    const px = imgData.data;

    smB   = _smBBuf;
    smSat = _smSatBuf;
    for (let y = 0; y < H; y++) {
      let sB = 0, sSat = 0;
      for (let x = 0; x < 11; x++) {
        const i = (y * 11 + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        sB   += 0.299 * r + 0.587 * g + 0.114 * b;
        sSat += _sat(r, g, b);
      }
      _rowBBuf[y]   = sB   / 11;
      _rowSatBuf[y] = sSat / 11;
    }
    for (let y = 0; y < H; y++) {
      let s = 0, ss = 0, c = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < H) { s += _rowBBuf[yy]; ss += _rowSatBuf[yy]; c++; }
      }
      smB[y]   = s  / c;
      smSat[y] = ss / c;
    }

    let sum = 0, sumSq = 0, satSum = 0;
    for (let i = 0; i < H; i++) {
      const v = smB[i];
      sum += v; sumSq += v * v;
      satSum += smSat[i];
    }
    const mean = sum / H;
    bgBright = Math.max(mean, mean + 0.84 * Math.sqrt(Math.max(0, sumSq / H - mean * mean)));
    avgSat   = satSum / H;
  }

  // Threshold: lower base + sensitivity range gives finer control
  const threshFrac = 0.20 - (sensitivity / 100) * 0.14;

  return staffData.positions.map((pos, i) => {
    const cy = Math.round(pos.y * scaleY);
    const r = 7;
    let sumArea = 0, maxArea = 0, minArea = 255, sumSat = 0, cnt = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = cy + dy;
      if (yy >= 0 && yy < H) {
        const v = smB[yy];
        sumArea += v;
        if (v > maxArea) maxArea = v;
        if (v < minArea) minArea = v;
        sumSat += smSat[yy];
        cnt++;
      }
    }
    const localAvg    = cnt > 0 ? sumArea / cnt : bgBright;
    const localSatAvg = cnt > 0 ? sumSat  / cnt : avgSat;

    const darkScore = (bgBright - localAvg) / (bgBright + 1);
    const edgeScore = cnt > 1 ? (maxArea - minArea) / (bgBright + 1) : 0;
    const satScore  = (localSatAvg - avgSat) * 2; // relative to column's own avg

    const score    = Math.max(darkScore, edgeScore * 0.75, satScore * 1.2);
    const detected = bgBright > 20 && score > threshFrac;
    const confidence = detected
      ? Math.min(1, (score - threshFrac) / Math.max(0.01, 0.4 - threshFrac))
      : 0;
    return { detected, confidence, y: pos.y, noteIndex: i };
  });
}

/* ── Main export ── */
let _videoEl = null;

export function detectObjects({ appMode, photoImgEl, staffData, scanX, sensitivity }) {
  if (!staffData) return null;
  const source = (appMode === 'photo' && photoImgEl)
    ? photoImgEl
    : (_videoEl || (_videoEl = document.getElementById('cameraVideo')));
  if (!source) return null;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return null;
  return detectAtScanLine(source, staffData, scanX, sensitivity);
}
