// Detection: MediaPipe segmentation (primary) + column-scan multi-signal fallback
// MediaPipe provides high-quality object segmentation when the model is ready.
// Falls back to the column-scan detector (darkness + edge contrast + saturation)
// while the model is loading or if it fails.

import { isSmartReady, runInference, getEdgeTransitions } from './smartDetection.js';

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
  _photoMelody   = null;
}

// ─── Pre-built photo melody ────────────────────────────────────────────────
// Scan every column once upfront; animation loop reads from this array —
// zero detection cost during playback, and the melody is perfectly consistent.
let _photoMelody = null; // Array<{ x: number, results: DetectionResult[] }>

/**
 * Build a complete melody for the current photo.
 * scanSpeed (px/frame at 60 fps) is used to convert run-length → real seconds,
 * so sustained instruments hold notes for exactly as long as the object is wide.
 */
export function buildPhotoMelody(staffData, sensitivity, scanSpeed) {
  if (!_photoCache || !staffData) { _photoMelody = null; return; }
  const step = Math.max(1, Math.round(staffData.spacing / 2));
  const spd = scanSpeed || 1;
  const secPerStep = step / (spd * 60); // px/step ÷ (px/frame × 60 frames/s) = seconds

  // Pass 1: detect every column
  const melody = [];
  for (let x = staffData.staffLeft; x <= staffData.staffRight; x += step) {
    const results = detectAtScanLine(null, staffData, x, sensitivity);
    if (results) melody.push({ x, results });
  }

  // Pass 2: per note-position, find contiguous detected runs,
  //         mark isNoteStart + durationSecs only on the first column of each run.
  const N = melody.length;
  if (N === 0) { _photoMelody = melody; return; }
  const M = melody[0].results.length;
  for (let ni = 0; ni < M; ni++) {
    // default: not a start
    for (let i = 0; i < N; i++) melody[i].results[ni].isNoteStart = false;
    let runStart = -1;
    for (let i = 0; i <= N; i++) {
      const detected = i < N && melody[i].results[ni].detected;
      if (detected && runStart === -1) {
        runStart = i;
      } else if (!detected && runStart !== -1) {
        const durationSecs = Math.max(0.08, (i - runStart) * secPerStep);
        melody[runStart].results[ni].isNoteStart = true;
        melody[runStart].results[ni].durationSecs = durationSecs;
        runStart = -1;
      }
    }
  }

  _applyGhostNotes(melody, secPerStep);
  _photoMelody = melody;
}

export function getPhotoMelody() { return _photoMelody; }

// ─── Shared ghost-note fill ───────────────────────────────────────────────
// Deterministic, brightness-derived ghost notes that step melodically through
// silent gaps. Identical algorithm used by both column-scan and MediaPipe paths
// so the two are musically consistent.
function _applyGhostNotes(melody, secPerStep) {
  const N = melody.length;
  if (N === 0 || !_photoCache) return;
  const M = melody[0].results.length;
  const W = _photoCacheW;
  const H = PHOTO_SCAN_H;
  const MIN_GAP = 4;
  const _r = s => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };
  const _bright = ci => {
    const frac = Math.max(0, Math.min(1, melody[ci].x / (_photoCacheDispW || W)));
    const cx = Math.round(frac * (W - 1));
    const x0 = Math.max(0, cx - 2), x1 = Math.min(W - 1, cx + 2);
    const y0 = Math.floor(H * 0.25), y1 = Math.floor(H * 0.75);
    let s = 0, c = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x <= x1; x++) { s += _photoCache[y * W + x]; c++; }
    return c ? s / c : 128;
  };
  let prevNi = -1;
  const _place = (ci, seed) => {
    if (ci < 0 || ci >= N) return false;
    const bright = _bright(ci);
    const dir   = _r(seed + 3) > 0.5 ? 1 : -1;
    const steps = Math.round(_r(seed + 4) * 2);
    let ni = Math.round((bright / 255) * (M - 1)) + dir * steps;
    ni = Math.max(0, Math.min(M - 1, ni));
    if (ni === prevNi) ni = Math.max(0, Math.min(M - 1, ni + dir));
    // Don't place on top of an already-detected row (real or prior ghost)
    if (melody[ci].results[ni].detected) return false;
    prevNi = ni;
    // Duration varies naturally: 2–4 steps, shorter ghosts feel more incidental
    const dur = secPerStep * (2 + _r(seed + 6) * 2);
    melody[ci].results[ni].detected     = true;
    melody[ci].results[ni].isNoteStart  = true;
    melody[ci].results[ni].durationSecs = dur;
    melody[ci].results[ni].confidence   = 0.0; // minimum velocity — subtle
    melody[ci].results[ni].isGhost      = true;
    return true;
  };
  let gapStart = -1;
  for (let i = 0; i <= N; i++) {
    const isEmpty = i < N && !melody[i].results.some(r => r.isNoteStart);
    if (isEmpty && gapStart === -1) { gapStart = i; continue; }
    if ((!isEmpty || i === N) && gapStart !== -1) {
      const gapLen = i - gapStart;
      const seed   = gapStart * 13;
      // Small gaps (4–7): single quiet ghost, 65% chance
      if (gapLen >= MIN_GAP && gapLen < MIN_GAP * 2) {
        if (_r(seed) < 0.65) {
          const t1 = 0.25 + _r(seed + 1) * 0.5;
          _place(Math.floor(gapStart + gapLen * t1), seed + 10);
        }
      // Medium gaps (8–15): 1–2 ghosts, 85% chance
      } else if (gapLen >= MIN_GAP * 2 && gapLen < MIN_GAP * 3) {
        if (_r(seed) < 0.85) {
          const t1 = 0.2 + _r(seed + 1) * 0.6;
          _place(Math.floor(gapStart + gapLen * t1), seed + 10);
          if (_r(seed + 2) < 0.55) {
            const half = t1 < 0.5 ? 0.55 + _r(seed + 5) * 0.3 : 0.15 + _r(seed + 5) * 0.3;
            _place(Math.floor(gapStart + gapLen * half), seed + 20);
          }
        }
      // Long gaps (16+): up to 3 ghosts, 90% chance
      } else if (gapLen >= MIN_GAP * 3) {
        if (_r(seed) < 0.90) {
          const t1 = 0.15 + _r(seed + 1) * 0.25;
          const t2 = 0.45 + _r(seed + 2) * 0.20;
          const t3 = 0.72 + _r(seed + 7) * 0.18;
          _place(Math.floor(gapStart + gapLen * t1), seed + 10);
          if (_r(seed + 3) < 0.75) _place(Math.floor(gapStart + gapLen * t2), seed + 20);
          if (_r(seed + 4) < 0.50) _place(Math.floor(gapStart + gapLen * t3), seed + 30);
        }
      }
      gapStart = -1;
    }
  }

  // ── Pass 2: bridge wide pitch leaps between adjacent real notes ────────────
  // When two consecutive real isNoteStart events jump ≥4 pitch positions and
  // are close enough in time, add a quiet passing-tone ghost at the midpoint.
  // This fills the "empty space" between two real notes without sounding added.
  const realStarts = [];
  for (let i = 0; i < N; i++) {
    for (let ni = 0; ni < M; ni++) {
      const r = melody[i].results[ni];
      if (r.isNoteStart && !r.isGhost) realStarts.push({ ci: i, ni });
    }
  }
  realStarts.sort((a, b) => a.ci - b.ci || a.ni - b.ni);

  // ── Pass 3: lead-in before first real note, tail-out after last real note ──
  // Place 1–2 ghost notes just before the melody begins and just after it ends
  // so the music "breathes in" before the first note and fades out naturally.
  const _placeRaw = (ci, ni, dur) => {
    if (ci < 0 || ci >= N || ni < 0 || ni >= M) return;
    if (melody[ci].results[ni].detected) return;
    melody[ci].results[ni].detected     = true;
    melody[ci].results[ni].isNoteStart  = true;
    melody[ci].results[ni].durationSecs = dur;
    melody[ci].results[ni].confidence   = 0.0;
    melody[ci].results[ni].isGhost      = true;
  };

  if (realStarts.length > 0) {
    // Lead-in: 1–2 ghost notes before first real note
    const first = realStarts[0];
    if (first.ci >= 2) {
      const seedL = first.ci * 31;
      const offset1 = Math.max(1, Math.round(first.ci * 0.45));
      const ni1 = Math.max(0, Math.min(M - 1, first.ni + (_r(seedL) > 0.5 ? 1 : -1)));
      _placeRaw(first.ci - offset1, ni1, secPerStep * 2);
      if (first.ci >= 4 && _r(seedL + 1) < 0.55) {
        const offset2 = Math.max(1, Math.round(first.ci * 0.75));
        const ni2 = Math.max(0, Math.min(M - 1, ni1 + (_r(seedL + 2) > 0.5 ? 1 : -1)));
        _placeRaw(first.ci - offset2, ni2, secPerStep * 1.5);
      }
    }

    // Tail-out: 1–2 ghost notes after last real note
    const last = realStarts[realStarts.length - 1];
    const tailRoom = N - 1 - last.ci;
    if (tailRoom >= 2) {
      const seedT = last.ci * 37;
      const offset1 = Math.max(1, Math.round(tailRoom * 0.40));
      const ni1 = Math.max(0, Math.min(M - 1, last.ni + (_r(seedT) > 0.5 ? 1 : -1)));
      _placeRaw(last.ci + offset1, ni1, secPerStep * 2);
      if (tailRoom >= 4 && _r(seedT + 1) < 0.55) {
        const offset2 = Math.max(1, Math.round(tailRoom * 0.75));
        const ni2 = Math.max(0, Math.min(M - 1, ni1 + (_r(seedT + 2) > 0.5 ? 1 : -1)));
        _placeRaw(last.ci + offset2, ni2, secPerStep * 1.5);
      }
    }
  }

  for (let k = 0; k < realStarts.length - 1; k++) {
    const a = realStarts[k], b = realStarts[k + 1];
    const pitchGap = Math.abs(a.ni - b.ni);
    const timeGap  = b.ci - a.ci;
    // Only bridge when pitch jumps wide AND time gap is short-to-medium
    if (pitchGap < 4 || timeGap < 2 || timeGap > MIN_GAP * 5) continue;
    const midCi = Math.round((a.ci + b.ci) / 2);
    const midNi = Math.round((a.ni + b.ni) / 2);
    if (midCi < 0 || midCi >= N) continue;
    if (melody[midCi].results[midNi].detected) continue; // don't overwrite
    const seed = (a.ci * 17 + b.ci * 7) | 0;
    if (_r(seed + 9) < 0.70) {
      melody[midCi].results[midNi].detected     = true;
      melody[midCi].results[midNi].isNoteStart  = true;
      melody[midCi].results[midNi].durationSecs = secPerStep * 1.5; // brief passing tone
      melody[midCi].results[midNi].confidence   = 0.0;
      melody[midCi].results[midNi].isGhost      = true;
    }
  }
}

/**
 * Build a photo melody using the MediaPipe segmentation mask.
 * Called after resetPhotoMask() + runInference() completes — upgrades the
 * column-scan melody that was built immediately on photo load.
 * Uses the same run-length encoding and ghost-note fill as buildPhotoMelody.
 */
export function buildPhotoMelodyFromMediaPipe(staffData, sensitivity, scanSpeed) {
  if (!staffData) { _photoMelody = null; return; }
  const step = Math.max(1, Math.round(staffData.spacing / 2));
  const spd = scanSpeed || 1;
  const secPerStep = step / (spd * 60);
  const N_pos = staffData.positions.length;

  // Pass 1: scan every column via mask → 13-element result arrays
  const melody = [];
  for (let x = staffData.staffLeft; x <= staffData.staffRight; x += step) {
    const results = staffData.positions.map((pos, i) => ({
      detected: false, confidence: 0,
      y: pos.y, noteIndex: i,
      isNoteStart: false, durationSecs: null, isGhost: false,
    }));
    const transitions = getEdgeTransitions(staffData, x, sensitivity);
    if (transitions && transitions.length > 0) {
      for (const t of transitions) {
        const ni = yToNoteIndex(t.y, staffData);
        if (ni >= 0 && ni < N_pos) {
          results[ni].detected   = true;
          results[ni].confidence = t.confidence;
          results[ni].y          = t.y;
        }
      }
    }
    melody.push({ x, results });
  }

  // Pass 2: run-length encoding → mark isNoteStart + durationSecs
  const Mel = melody.length;
  if (Mel === 0) { _photoMelody = melody; return; }
  for (let ni = 0; ni < N_pos; ni++) {
    let runStart = -1;
    for (let i = 0; i <= Mel; i++) {
      const detected = i < Mel && melody[i].results[ni].detected;
      if (detected && runStart === -1) {
        runStart = i;
      } else if (!detected && runStart !== -1) {
        const durationSecs = Math.max(0.08, (i - runStart) * secPerStep);
        melody[runStart].results[ni].isNoteStart = true;
        melody[runStart].results[ni].durationSecs = durationSecs;
        runStart = -1;
      }
    }
  }

  // Pass 3: ghost note fill (same algorithm as buildPhotoMelody)
  _applyGhostNotes(melody, secPerStep);
  _photoMelody = melody;
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
    // No fresh live cache available — caller should retry next cycle.
    // Returning null avoids a GPU→CPU stall (drawImage+getImageData) on the main thread,
    // which is far more disruptive than skipping one detection cycle.
    return null;
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

/** Map a display-space Y → note index (0 = lowest, 12 = highest) */
function yToNoteIndex(y, staffData) {
  const { staffTop, staffBottom } = staffData;
  const clampedY = Math.max(staffTop, Math.min(staffBottom, y));
  const ratio = 1 - ((clampedY - staffTop) / (staffBottom - staffTop));
  return Math.round(ratio * 12);
}

export function detectObjects({ appMode, photoImgEl, staffData, scanX, sensitivity }) {
  if (!staffData) return null;

  // ── Primary path: MediaPipe segmentation ──
  // Runs once per photo (photoMaskCached) or throttled per video frame.
  if (isSmartReady()) {
    const video = document.getElementById('cameraVideo');
    const source = (appMode === 'photo' && photoImgEl) ? photoImgEl : video;
    if (source) {
      runInference(source, { appMode, staffData, sensitivity, scanX }); // fire-and-forget
    }
    const transitions = getEdgeTransitions(staffData, scanX, sensitivity);
    if (transitions) {
      return transitions.map(t => ({
        detected: true,
        confidence: t.confidence,
        y: t.y,
        noteIndex: yToNoteIndex(t.y, staffData),
      }));
    }
    // Mask not ready yet — fall through to column-scan for this cycle
  }

  // ── Fallback: column-scan multi-signal detector ──
  const source = (appMode === 'photo' && photoImgEl)
    ? photoImgEl
    : (_videoEl || (_videoEl = document.getElementById('cameraVideo')));
  if (!source) return null;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return null;
  return detectAtScanLine(source, staffData, scanX, sensitivity);
}
