// Detection: MediaPipe Segmentation (smart) with brightness+Canny fallback

import { isSmartReady, runInference } from './smartDetection.js';

export let cvReady = false;
let _opencvLoadStarted = false;

export function onOpenCVReady() {
  cvReady = true;
  const el = document.getElementById('opencvStatus');
  el.classList.add('loaded');
  setTimeout(() => (el.style.display = 'none'), 900);
}

// Expose globally so the dynamic script tag's onload can call it
window.onOpenCVReady = onOpenCVReady;

/**
 * Lazily load OpenCV — called only when entering photo mode.
 * Safe to call multiple times (no-op if already started).
 */
export function loadOpenCVIfNeeded() {
  if (_opencvLoadStarted || cvReady) return;
  _opencvLoadStarted = true;
  const script = document.createElement('script');
  script.src = 'https://docs.opencv.org/4.9.0/opencv.js';
  script.async = true;
  script.onload = () => window.onOpenCVReady && window.onOpenCVReady();
  document.body.appendChild(script);
}

export const noteCooldowns = {};

export function shouldTriggerNote(noteId, now, cooldownMs = 250) {
  const last = noteCooldowns[noteId] || 0;
  if (now - last < cooldownMs) return false;
  noteCooldowns[noteId] = now;
  return true;
}

/* ── Offscreen canvas for fallback detection ── */

const detectionCanvas = document.createElement('canvas');
const detectionCtx = detectionCanvas.getContext('2d', { willReadFrequently: true });

function captureToDetectionCanvas({ appMode, photoImgEl, staffData }) {
  const video = document.getElementById('cameraVideo');

  if (appMode === 'photo' && photoImgEl) {
    const dispW = staffData?.displayWidth  || 320;
    const dispH = staffData?.displayHeight || 240;
    const W = 320;
    const H = Math.max(1, Math.round(W * dispH / dispW));
    detectionCanvas.width  = W;
    detectionCanvas.height = H;
    const iw = photoImgEl.naturalWidth  || photoImgEl.width;
    const ih = photoImgEl.naturalHeight || photoImgEl.height;
    const scale = iw && ih ? Math.min(W / iw, H / ih) : 1;
    const dw = (iw || W) * scale, dh = (ih || H) * scale;
    const ox = (W - dw) / 2,     oy = (H - dh) / 2;
    detectionCtx.fillStyle = '#000';
    detectionCtx.fillRect(0, 0, W, H);
    detectionCtx.drawImage(photoImgEl, ox, oy, dw, dh);
    return {
      canvas: detectionCanvas,
      scaleX: W / dispW,
      scaleY: H / dispH,
    };
  }

  const W = 320, H = 240;
  detectionCanvas.width = W;
  detectionCanvas.height = H;
  if (video.readyState >= 2) {
    detectionCtx.drawImage(video, 0, 0, W, H);
  } else {
    return null;
  }
  return {
    canvas: detectionCanvas,
    scaleX: W / (staffData?.displayWidth  || W),
    scaleY: H / (staffData?.displayHeight || H),
  };
}

/* ── Column-scan dark-object detector ── */

// Single narrow canvas for reading one thin column at a time (11 × 240 px)
const colCanvas = document.createElement('canvas');
colCanvas.width = 11;
colCanvas.height = 240;
const colCtx = colCanvas.getContext('2d', { willReadFrequently: true });

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
  const H = 240;
  const scaleY = H / dispH;
  if (colCanvas.height !== H) colCanvas.height = H;

  const srcW = source.videoWidth || source.naturalWidth || source.width || dispW;
  const srcH = source.videoHeight || source.naturalHeight || source.height || dispH;
  if (!srcW || !srcH) return null;

  // Map scanX (display coords) → a thin strip in source coordinates
  const fraction = Math.max(0, Math.min(1, scanX / dispW));
  const srcCX = fraction * srcW;
  const srcHalf = Math.max(1, Math.round(5 * srcW / dispW));
  const srcX0 = Math.max(0, Math.round(srcCX - srcHalf));
  const srcStripW = Math.min(srcHalf * 2 + 1, srcW - srcX0);
  if (srcStripW <= 0) return null;

  // Single drawImage of a thin strip → stretched to fill 11 × H (fast GPU op)
  colCtx.drawImage(source, srcX0, 0, srcStripW, srcH, 0, 0, 11, H);
  const imgData = colCtx.getImageData(0, 0, 11, H);
  const px = imgData.data;

  // Per-row grayscale brightness
  const rowB = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < 11; x++) {
      const i = (y * 11 + x) * 4;
      s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
    rowB[y] = s / 11;
  }

  // Smooth ±2 rows to suppress single-pixel grain / JPEG artefacts
  const smB = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0, c = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < H) { s += rowB[yy]; c++; }
    }
    smB[y] = s / c;
  }

  // Background brightness = mean of the brightest 20 % of rows
  // (keeps estimate unbiased even when many dark objects are present)
  const sortedB = Array.from(smB).sort((a, b) => b - a);
  const bgBright = sortedB[Math.floor(H * 0.2)] || 128;

  // Threshold: sens=70 (default) → ~0.13 (must be 13 % darker than background)
  const threshFrac = 0.28 - (sensitivity / 100) * 0.20;

  return staffData.positions.map((pos, i) => {
    const cy = Math.round(pos.y * scaleY);
    const r = 7; // ±7 canvas rows around each note Y position
    let sumArea = 0, cnt = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = cy + dy;
      if (yy >= 0 && yy < H) { sumArea += smB[yy]; cnt++; }
    }
    const localAvg = cnt > 0 ? sumArea / cnt : bgBright;

    // Dark score: how much darker is the local average vs background?
    // A thin wire (1 px in a 15-row window) barely moves the average.
    // A bird (≥3 px) or leaf pulls it down noticeably.
    const darkScore = (bgBright - localAvg) / (bgBright + 1);
    const detected = bgBright > 30 && darkScore > threshFrac;
    const confidence = detected
      ? Math.min(1, (darkScore - threshFrac) / Math.max(0.01, 0.4 - threshFrac))
      : 0;

    return { detected, confidence, y: pos.y, noteIndex: i };
  });
}

/**
 * Map Y position (display) → index in scale (0–12)
 * Lower Y (bottom) = low index (low note)
 * Higher Y (top) = high index (high note)
 */
function yToNoteIndex(y, staffData) {
  const { staffTop, staffBottom } = staffData;
  // Clamp Y to the staff area
  const clampedY = Math.max(staffTop, Math.min(staffBottom, y));
  // Invert: staffBottom = low note (index 0), staffTop = high note (index 12)
  const ratio = 1 - ((clampedY - staffTop) / (staffBottom - staffTop));
  return Math.round(ratio * 12);
}

/* ── Main export ── */
export function detectObjects({ appMode, photoImgEl, staffData, scanX, sensitivity }) {
  if (!staffData) return null;

  const video = document.getElementById('cameraVideo');
  const source = (appMode === 'photo' && photoImgEl) ? photoImgEl : video;
  if (!source) return null;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return null;

  // Keep MediaPipe running in background for the visual overlay (async, non-blocking)
  if (isSmartReady()) {
    runInference(source, { appMode, staffData, sensitivity, scanX });
  }

  // Primary note detection: column-scan brightness analysis.
  // Reads only 11 × 240 pixels — fast enough to run every detection frame.
  // Detects any dark object against a lighter background: birds, leaves, etc.
  return detectDarkObjectsAtScanLine(source, staffData, scanX, sensitivity);
}
