import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

let segmenter = null;
let loading = false;
let lastTime = 0;

// Cache mask each frame
let cachedMask = null;     // Float32Array 0.0–1.0
let maskW = 0, maskH = 0;
const INFERENCE_INTERVAL = 150; // ms

export function isSmartReady() {
  return !!segmenter;
}

export function isSmartLoading() {
  return loading;
}

export async function loadSmartModel() {
  if (segmenter || loading) return;
  loading = true;
  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
    );
    segmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  } catch (e) {
    console.warn('MediaPipe segmentation load failed:', e);
  } finally {
    loading = false;
  }
}

export async function runInference(imageSource) {
  if (!segmenter) return;
  // Throttle
  const now = Date.now();
  if (now - lastTime < INFERENCE_INTERVAL) return;
  lastTime = now;

  try {
    const isVideo = imageSource instanceof HTMLVideoElement;
    // If video is not ready, skip
    if (isVideo && imageSource.readyState < 2) return;

    const consumeResult = (result) => {
      const masks = result?.confidenceMasks;
      if (masks && masks.length > 0) {
        const bgMask = masks[0];
        const w = bgMask.width;
        const h = bgMask.height;
        if (!cachedMask || cachedMask.length !== w * h) {
          cachedMask = new Float32Array(w * h);
        }
        maskW = w;
        maskH = h;
        const bgData = typeof bgMask.getAsFloat32Array === 'function'
          ? bgMask.getAsFloat32Array()
          : bgMask.data;
        for (let i = 0; i < bgData.length; i++) {
          cachedMask[i] = 1.0 - bgData[i];
        }
      }
      if (typeof result?.close === 'function') result.close();
    };

    if (isVideo) {
      segmenter.segmentForVideo(imageSource, now, consumeResult);
    } else {
      const result = segmenter.segment(imageSource);
      consumeResult(result);
    }

  } catch (e) {
    // silently ignore
  }
}

/**
 * FIND TRANSITIONS (object edges) along the scanX column.
 *
 * Returns an array of { y (display coords), confidence }
 * Only returns the point of TRANSITION from background to foreground (rising edge),
 * NOT pixels inside the object.
 */
export function getEdgeTransitions(staffData, scanX) {
  if (!cachedMask || maskW === 0) return null;

  const W = staffData.displayWidth;
  const H = staffData.displayHeight;

  // Map scanX from display coords → mask coords
  const mx = Math.round((scanX / W) * maskW);
  if (mx < 0 || mx >= maskW) return null;

  // Read a vertical column from the mask
  const column = new Float32Array(maskH);
  for (let y = 0; y < maskH; y++) {
    column[y] = cachedMask[y * maskW + mx];
  }

  // Smooth the column (low-pass filter) to reduce noise
  const smoothed = new Float32Array(maskH);
  const kernelR = 2;
  for (let y = 0; y < maskH; y++) {
    let sum = 0, count = 0;
    for (let dy = -kernelR; dy <= kernelR; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < maskH) { sum += column[yy]; count++; }
    }
    smoothed[y] = sum / count;
  }

  // Find transitions: where the mask crosses a threshold
  const THRESHOLD = 0.4;
  const transitions = [];
  let prevAbove = smoothed[0] > THRESHOLD;

  for (let y = 1; y < maskH; y++) {
    const curAbove = smoothed[y] > THRESHOLD;
    if (curAbove && !prevAbove) {
      // Rising edge — object starts
      // Confidence = sharpness of the transition (gradient)
      const gradient = Math.abs(smoothed[y] - smoothed[y - 1]);
      const confidence = Math.min(1.0, gradient * 3 + smoothed[y] * 0.5);
      transitions.push({
        y: (y / maskH) * H,  // convert back to display coords
        confidence: Math.max(0.3, confidence),
      });
    }
    prevAbove = curAbove;
  }

  return transitions.length > 0 ? transitions : null;
}

export function drawDetections(ctx, staffData) {
  // Optional: draw a faint mask overlay (debug mode)
  // Or draw the transition points as bright dots
}
