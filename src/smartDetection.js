import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

let segmenter = null;
let loading = false;
let lastInferenceTime = 0;

const MEDIAPIPE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';

const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
const roiCanvas = document.createElement('canvas');
const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });

const ROI_TARGET_W = 320;
const ROI_TARGET_H_MAX = 220;
const TEMPORAL_ALPHA = 0.42;
const INFERENCE_INTERVAL = 140;

let cachedMask = null; // Float32Array foreground confidence in ROI mask-space
let maskW = 0;
let maskH = 0;

// ROI mapping from display-space to ROI source canvas (pre-segmentation)
let roiMap = null;

// History of stable edge rows to reduce frame-to-frame randomness
const edgeHistory = [];
const EDGE_HISTORY_LEN = 3;
const EDGE_MATCH_TOLERANCE = 10;

export function isSmartReady() {
  return !!segmenter;
}

export function isSmartLoading() {
  return loading;
}

export function getSmartBackend() {
  return isSmartReady() ? 'mediapipe' : 'none';
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function drawSourceToDisplayCanvas(imageSource, staffData, appMode) {
  const displayW = Math.max(
    1,
    Math.round(
      staffData?.displayWidth ||
      imageSource.videoWidth ||
      imageSource.naturalWidth ||
      imageSource.width ||
      320
    )
  );
  const displayH = Math.max(
    1,
    Math.round(
      staffData?.displayHeight ||
      imageSource.videoHeight ||
      imageSource.naturalHeight ||
      imageSource.height ||
      240
    )
  );

  frameCanvas.width = displayW;
  frameCanvas.height = displayH;
  frameCtx.fillStyle = '#000';
  frameCtx.fillRect(0, 0, displayW, displayH);

  const srcW = imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || displayW;
  const srcH = imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || displayH;
  if (!srcW || !srcH) return null;

  if (appMode === 'photo') {
    // Match photo preview style: contain
    const scale = Math.min(displayW / srcW, displayH / srcH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const dx = (displayW - drawW) / 2;
    const dy = (displayH - drawH) / 2;
    frameCtx.drawImage(imageSource, dx, dy, drawW, drawH);
  } else {
    // Match live camera style: cover
    const scale = Math.max(displayW / srcW, displayH / srcH);
    const cropW = displayW / scale;
    const cropH = displayH / scale;
    const sx = (srcW - cropW) / 2;
    const sy = (srcH - cropH) / 2;
    frameCtx.drawImage(imageSource, sx, sy, cropW, cropH, 0, 0, displayW, displayH);
  }

  return { displayW, displayH };
}

function computeRoiRect(staffData, displayW, displayH) {
  const staffWidth = Math.max(1, staffData.staffRight - staffData.staffLeft);
  const staffHeight = Math.max(1, staffData.staffBottom - staffData.staffTop);

  const x = clamp(Math.round(staffData.staffLeft - staffWidth * 0.08), 0, displayW - 1);
  const y = clamp(Math.round(staffData.staffTop - staffHeight * 0.22), 0, displayH - 1);
  const w = clamp(Math.round(staffWidth * 1.16), 1, displayW - x);
  const h = clamp(Math.round(staffHeight * 1.44), 1, displayH - y);

  return { x, y, w, h };
}

function buildRoiCanvas(roiRect) {
  const scale = ROI_TARGET_W / roiRect.w;
  const targetW = ROI_TARGET_W;
  const targetH = clamp(Math.round(roiRect.h * scale), 64, ROI_TARGET_H_MAX);

  roiCanvas.width = targetW;
  roiCanvas.height = targetH;
  roiCtx.drawImage(
    frameCanvas,
    roiRect.x,
    roiRect.y,
    roiRect.w,
    roiRect.h,
    0,
    0,
    targetW,
    targetH
  );

  return {
    displayToRoiScaleX: targetW / roiRect.w,
    displayToRoiScaleY: targetH / roiRect.h,
    roiRect,
    targetW,
    targetH,
  };
}

function readForegroundMask(result) {
  const masks = result?.confidenceMasks;
  if (!masks || masks.length === 0) return null;

  const bgMask = masks[0];
  const w = bgMask.width;
  const h = bgMask.height;
  const bgData = typeof bgMask.getAsFloat32Array === 'function'
    ? bgMask.getAsFloat32Array()
    : bgMask.data;

  if (!cachedMask || cachedMask.length !== w * h) {
    cachedMask = new Float32Array(w * h);
    for (let i = 0; i < bgData.length; i++) {
      cachedMask[i] = 1 - bgData[i];
    }
  } else {
    // Temporal smoothing for stable boundaries
    for (let i = 0; i < bgData.length; i++) {
      const fg = 1 - bgData[i];
      cachedMask[i] = cachedMask[i] * (1 - TEMPORAL_ALPHA) + fg * TEMPORAL_ALPHA;
    }
  }

  maskW = w;
  maskH = h;
  return true;
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
        modelAssetPath: MEDIAPIPE_MODEL_URL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  } catch (error) {
    console.warn('MediaPipe segmentation load failed:', error);
  } finally {
    loading = false;
  }
}

export async function runInference(imageSource, opts = {}) {
  if (!segmenter || !imageSource || !opts.staffData) return;

  const now = Date.now();
  if (now - lastInferenceTime < INFERENCE_INTERVAL) return;
  lastInferenceTime = now;

  try {
    const isVideo = imageSource instanceof HTMLVideoElement;
    if (isVideo && imageSource.readyState < 2) return;

    const displayInfo = drawSourceToDisplayCanvas(
      imageSource,
      opts.staffData,
      opts.appMode || 'live'
    );
    if (!displayInfo) return;

    const roiRect = computeRoiRect(opts.staffData, displayInfo.displayW, displayInfo.displayH);
    const roiInfo = buildRoiCanvas(roiRect);
    roiMap = {
      roiRect,
      targetW: roiInfo.targetW,
      targetH: roiInfo.targetH,
      displayToRoiScaleX: roiInfo.displayToRoiScaleX,
      displayToRoiScaleY: roiInfo.displayToRoiScaleY,
      displayW: displayInfo.displayW,
      displayH: displayInfo.displayH,
    };

    if (isVideo) {
      segmenter.segmentForVideo(roiCanvas, now, (result) => {
        readForegroundMask(result);
        if (typeof result?.close === 'function') result.close();
      });
    } else {
      const result = segmenter.segment(roiCanvas);
      readForegroundMask(result);
      if (typeof result?.close === 'function') result.close();
    }
  } catch {
    // keep silent in realtime loop
  }
}

function getColumnFromMask(scanX) {
  if (!roiMap || !cachedMask || maskW === 0 || maskH === 0) return null;

  const { roiRect, targetW } = roiMap;
  if (scanX < roiRect.x || scanX > roiRect.x + roiRect.w) return null;

  const roiX = (scanX - roiRect.x) * (targetW / roiRect.w);
  const mx = clamp(Math.round((roiX / targetW) * maskW), 0, maskW - 1);

  const column = new Float32Array(maskH);
  for (let y = 0; y < maskH; y++) {
    column[y] = cachedMask[y * maskW + mx];
  }
  return column;
}

function smoothColumn(column) {
  const smoothed = new Float32Array(column.length);
  const radius = 2;
  for (let y = 0; y < column.length; y++) {
    let sum = 0;
    let count = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < column.length) {
        sum += column[yy];
        count++;
      }
    }
    smoothed[y] = sum / Math.max(1, count);
  }
  return smoothed;
}

function temporalBoostForY(yDisplay) {
  if (edgeHistory.length === 0) return 0;
  let support = 0;
  for (const frame of edgeHistory) {
    if (frame.some(v => Math.abs(v - yDisplay) <= EDGE_MATCH_TOLERANCE)) {
      support++;
    }
  }
  return support / edgeHistory.length;
}

export function getEdgeTransitions(staffData, scanX, sensitivity = 50) {
  if (!roiMap || !cachedMask || maskW === 0 || maskH === 0) return null;

  const column = getColumnFromMask(scanX);
  if (!column) return null;

  const smoothed = smoothColumn(column);

  // Staff band inside ROI space
  const yTopRoi = clamp(
    Math.round((staffData.staffTop - roiMap.roiRect.y) * (roiMap.targetH / roiMap.roiRect.h)),
    0,
    maskH - 1
  );
  const yBottomRoi = clamp(
    Math.round((staffData.staffBottom - roiMap.roiRect.y) * (roiMap.targetH / roiMap.roiRect.h)),
    0,
    maskH - 1
  );
  const yStart = Math.min(yTopRoi, yBottomRoi);
  const yEnd = Math.max(yTopRoi, yBottomRoi);
  if (yEnd <= yStart) return null;

  let mean = 0;
  let maxV = 0;
  for (let y = yStart; y <= yEnd; y++) {
    const v = smoothed[y];
    mean += v;
    if (v > maxV) maxV = v;
  }
  mean /= Math.max(1, yEnd - yStart + 1);

  const sens = clamp(sensitivity / 100, 0, 1);
  const high = clamp(mean + (maxV - mean) * 0.2 - sens * 0.08, 0.2, 0.68);
  const low = clamp(high - 0.08, 0.1, 0.58);

  const rawTransitions = [];
  let prevAbove = smoothed[yStart] > high;

  for (let y = yStart + 1; y <= yEnd; y++) {
    const prev = smoothed[y - 1];
    const cur = smoothed[y];
    const curAbove = cur > high;

    if (!prevAbove && prev < low && curAbove) {
      const grad = Math.max(0, cur - prev);
      const yDisplay = roiMap.roiRect.y + (y / maskH) * roiMap.roiRect.h;
      const temporal = temporalBoostForY(yDisplay);
      const confidence = clamp(cur * 0.5 + grad * 1.8 + temporal * 0.45, 0.2, 1);

      // Require either strong edge or moderate temporal support
      if (confidence > 0.38 || temporal > 0.34) {
        rawTransitions.push({ y: yDisplay, confidence });
      }
    }
    prevAbove = curAbove;
  }

  if (rawTransitions.length === 0) {
    edgeHistory.push([]);
    if (edgeHistory.length > EDGE_HISTORY_LEN) edgeHistory.shift();
    return null;
  }

  rawTransitions.sort((a, b) => b.confidence - a.confidence);
  const picked = [];
  for (const t of rawTransitions) {
    const near = picked.some(p => Math.abs(p.y - t.y) < 12);
    if (!near) picked.push(t);
    if (picked.length >= 5) break;
  }

  picked.sort((a, b) => a.y - b.y);

  edgeHistory.push(picked.map(t => t.y));
  if (edgeHistory.length > EDGE_HISTORY_LEN) edgeHistory.shift();

  return picked;
}

export function drawDetections(ctx, staffData) {
  // Optional debug overlay hook.
}
