// Smart object detection using COCO-SSD (TensorFlow.js)
// Detects real objects (keyboard, phone, plant, book…) and returns
// bounding boxes in normalised [0–1] coordinates.
// The scan line then triggers notes only where actual objects live.

import * as cocoSsd from '@tensorflow-models/coco-ssd';

let model = null;
let modelLoading = false;

// Normalised bounding boxes from the last inference
// Each entry: { x1, y1, x2, y2, class, score }
let cachedBoxes = [];

// Only run inference this often (ms) — ~1 fps is enough; visual loop stays 60 fps
const INFERENCE_INTERVAL = 900;
let lastInferenceTime = 0;

/* ── Model loading ─────────────────────────────────────── */

export function isSmartReady() { return !!model; }
export function isSmartLoading() { return modelLoading; }

export async function loadSmartModel() {
  if (model || modelLoading) return;
  modelLoading = true;
  try {
    // lite_mobilenet_v2 is fastest on mobile (~3 MB weights)
    model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  } catch (e) {
    console.warn('COCO-SSD load failed:', e);
  } finally {
    modelLoading = false;
  }
}

/* ── Inference ─────────────────────────────────────────── */

export async function runInference(imageSource) {
  if (!model) return;
  const now = Date.now();
  if (now - lastInferenceTime < INFERENCE_INTERVAL) return;
  lastInferenceTime = now;

  try {
    // Limit to 10 detections; minimum confidence 0.25
    const predictions = await model.detect(imageSource, 10, 0.25);

    // Get natural dimensions of the source
    const imgW =
      imageSource.videoWidth  ||
      imageSource.naturalWidth ||
      imageSource.width  || 1;
    const imgH =
      imageSource.videoHeight  ||
      imageSource.naturalHeight ||
      imageSource.height || 1;

    // Normalise bbox to [0–1] range
    cachedBoxes = predictions.map(p => ({
      x1: p.bbox[0] / imgW,
      y1: p.bbox[1] / imgH,
      x2: (p.bbox[0] + p.bbox[2]) / imgW,
      y2: (p.bbox[1] + p.bbox[3]) / imgH,
      class: p.class,
      score: p.score,
    }));
  } catch (_) {
    // silently ignore inference errors
  }
}

/* ── Per-frame query (called at 60 fps, uses cached boxes) ── */

export function getSmartResults(staffData, scanX) {
  if (!staffData || cachedBoxes.length === 0) return null;

  const W = staffData.displayWidth;
  const H = staffData.displayHeight;
  const xNorm = scanX / W;

  return staffData.positions.map(pos => {
    const yNorm = pos.y / H;

    // Find the highest-confidence box that contains (xNorm, yNorm)
    let bestScore = 0;
    for (const box of cachedBoxes) {
      if (
        xNorm >= box.x1 && xNorm <= box.x2 &&
        yNorm >= box.y1 && yNorm <= box.y2
      ) {
        if (box.score > bestScore) bestScore = box.score;
      }
    }

    return {
      detected:    bestScore > 0,
      confidence:  bestScore,
      position:    pos,
    };
  });
}

/* ── Draw bounding boxes on staff canvas (optional debug) ── */

export function drawDetections(ctx, staffData) {
  if (!staffData || cachedBoxes.length === 0) return;
  const W = staffData.displayWidth;
  const H = staffData.displayHeight;

  ctx.lineWidth = 1.5;
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'top';

  for (const box of cachedBoxes) {
    const x = box.x1 * W, y = box.y1 * H;
    const w = (box.x2 - box.x1) * W;
    const h = (box.y2 - box.y1) * H;
    const alpha = 0.3 + box.score * 0.5;

    ctx.strokeStyle = `rgba(212,165,116,${alpha})`;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    ctx.fillStyle = `rgba(212,165,116,${alpha})`;
    ctx.fillText(box.class, x + 4, y + 3);
  }
}
