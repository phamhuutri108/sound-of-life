// Detection: MediaPipe Segmentation (smart) with brightness+Canny fallback

import { isSmartReady, runInference, getEdgeTransitions } from './smartDetection.js';

export let cvReady = false;

export function onOpenCVReady() {
  cvReady = true;
  const el = document.getElementById('opencvStatus');
  el.classList.add('loaded');
  setTimeout(() => (el.style.display = 'none'), 900);
}

// Expose globally so the CDN script's onload attribute can call it
window.onOpenCVReady = onOpenCVReady;

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

/* ── Fallback: brightness contrast ── */

function computeAdaptiveThreshold(imageData) {
  const px = imageData.data;
  let mn = 255, mx = 0;
  for (let i = 0; i < px.length; i += 16) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (g < mn) mn = g;
    if (g > mx) mx = g;
  }
  return Math.max(20, Math.min(80, (mx - mn) * 0.3));
}

function detectBrightnessAtPositions(frameData, notePositions, scanXScaled, sensitivity) {
  const { imageData, width, height } = frameData;
  const px = imageData.data;
  const base = computeAdaptiveThreshold(imageData);
  const threshold = base * (1.5 - sensitivity / 100);

  let globalSum = 0, globalCount = 0;
  for (let i = 0; i < px.length; i += 16) {
    globalSum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    globalCount++;
  }
  const globalAvg = globalSum / globalCount;

  const sampleW = 12, sampleH = 8;
  return notePositions.map(pos => {
    const cx = Math.round(scanXScaled);
    const cy = Math.round(pos.yScaled);
    let localSum = 0, localCount = 0;
    for (let dy = -sampleH; dy <= sampleH; dy++) {
      for (let dx = -sampleW; dx <= sampleW; dx++) {
        const px2 = cx + dx, py2 = cy + dy;
        if (px2 >= 0 && px2 < width && py2 >= 0 && py2 < height) {
          const idx = (py2 * width + px2) * 4;
          localSum += 0.299 * px[idx] + 0.587 * px[idx + 1] + 0.114 * px[idx + 2];
          localCount++;
        }
      }
    }
    const localAvg = localCount > 0 ? localSum / localCount : globalAvg;
    return Math.abs(localAvg - globalAvg) > threshold;
  });
}

/* ── Fallback: OpenCV Canny edges ── */

function detectEdgesAtPositions(detCanvas, notePositions, scanXScaled) {
  if (!cvReady) return null;
  try {
    const src = cv.imread(detCanvas);
    const gray = new cv.Mat(), blurred = new cv.Mat(), edges = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 1.5);
    cv.Canny(blurred, edges, 50, 150);
    const sw = 12, sh = 8;
    const results = notePositions.map(pos => {
      const cx = Math.round(scanXScaled);
      const cy = Math.round(pos.yScaled);
      let edgeCount = 0, total = 0;
      for (let dy = -sh; dy <= sh; dy++) {
        for (let dx = -sw; dx <= sw; dx++) {
          const py = cy + dy, px = cx + dx;
          if (py >= 0 && py < edges.rows && px >= 0 && px < edges.cols) {
            total++;
            if (edges.ucharAt(py, px) > 0) edgeCount++;
          }
        }
      }
      return total > 0 && edgeCount / total > 0.05;
    });
    src.delete(); gray.delete(); blurred.delete(); edges.delete();
    return results;
  } catch (e) {
    return null;
  }
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
  
    // ── Smart path: MediaPipe segmentation ──
    if (isSmartReady()) {
      const video = document.getElementById('cameraVideo');
      const source = (appMode === 'photo' && photoImgEl) ? photoImgEl : video;
      if (source) {
          runInference(source, { appMode, staffData, sensitivity }); // fire-and-forget
      }
  
      const transitions = getEdgeTransitions(staffData, scanX, sensitivity);
      if (transitions) {
        // Return new format: array of {y, confidence, noteIndex}
        return transitions.map(t => ({
          detected: true,
          confidence: t.confidence,
          y: t.y,
          noteIndex: yToNoteIndex(t.y, staffData),
        }));
      }
      // Fall through if mask is not ready yet
    }
  
    // ── Fallback: brightness + Canny (original logic) ──
    const cap = captureToDetectionCanvas({ appMode, photoImgEl, staffData });
    if (!cap) return null;
  
    const { canvas: detCanvas, scaleX, scaleY } = cap;
    const imageData = detectionCtx.getImageData(0, 0, detCanvas.width, detCanvas.height);
    const frameData = { imageData, width: detCanvas.width, height: detCanvas.height };
  
    const scanXScaled = scanX * scaleX;
    const notePositions = staffData.positions.map(pos => ({
      ...pos,
      yScaled: pos.y * scaleY,
    }));
  
    const brightness = detectBrightnessAtPositions(frameData, notePositions, scanXScaled, sensitivity);
    const edges = detectEdgesAtPositions(detCanvas, notePositions, scanXScaled);
  
    const fixedResults = notePositions.map((pos, i) => {
      const byB = brightness[i];
      const byE = edges ? edges[i] : false;
      return {
        detected: byB || byE,
        confidence: (byB ? 0.5 : 0) + (byE ? 0.5 : 0),
      };
    });

    // Wrap fallback results to be compatible with new format
    return fixedResults.map((r, i) => ({
      ...r,
      y: staffData.positions[i].y,
      noteIndex: i,
    }));
  }
