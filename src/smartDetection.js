import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

let segmenter = null;
let loading = false;
let lastInferenceTime = 0;
let inferenceInFlight = false;
let photoMaskCached = false; // true after first successful inference on a static photo

const MEDIAPIPE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';

const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
const roiCanvas = document.createElement('canvas');
const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });

let roiTargetW = 256;
let roiTargetHMax = 192;
const TEMPORAL_ALPHA = 0.42;
let inferenceInterval = 170;

let cachedMask = null; // Float32Array foreground confidence in ROI mask-space
let maskW = 0;
let maskH = 0;

// ROI mapping from display-space to ROI source canvas (pre-segmentation)
let roiMap = null;

// History of stable edge rows to reduce frame-to-frame randomness
const edgeHistory = [];
const EDGE_HISTORY_LEN = 4;
const EDGE_MATCH_TOLERANCE = 10;
let smoothRadius = 1;
let edgePickLimit = 3;
let smartProfile = 'balanced';

const PROFILE_CONFIG = {
  'ultra-smooth': {
    roiTargetW: 224,
    roiTargetHMax: 168,
    inferenceInterval: 220,
    smoothRadius: 2,
    edgePickLimit: 2,
  },
  balanced: {
    roiTargetW: 256,
    roiTargetHMax: 192,
    inferenceInterval: 170,
    smoothRadius: 1,
    edgePickLimit: 3,
  },
  responsive: {
    roiTargetW: 288,
    roiTargetHMax: 208,
    inferenceInterval: 130,
    smoothRadius: 1,
    edgePickLimit: 4,
  },
};

export function isSmartReady() {
  return !!segmenter;
}

export function isPhotoMaskCached() {
  return photoMaskCached;
}

export function isSmartLoading() {
  return loading;
}

export function getSmartBackend() {
  return isSmartReady() ? 'mediapipe' : 'none';
}

export function setSmartProfile(profile = 'balanced') {
  const next = PROFILE_CONFIG[profile] ? profile : 'balanced';
  const cfg = PROFILE_CONFIG[next];

  smartProfile = next;
  roiTargetW = cfg.roiTargetW;
  roiTargetHMax = cfg.roiTargetHMax;
  inferenceInterval = cfg.inferenceInterval;
  smoothRadius = cfg.smoothRadius;
  edgePickLimit = cfg.edgePickLimit;
}

export function getSmartProfile() {
  return smartProfile;
}

/**
 * Call when a new photo is loaded so MediaPipe re-infers once for the overlay.
 * Also clears the cached mask so stale results from the previous photo are gone.
 */
export function resetPhotoMask() {
  photoMaskCached = false;
  cachedMask = null;
  maskW = 0;
  maskH = 0;
  lastInferenceTime = 0; // allow inference to run immediately
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
  const scale = roiTargetW / roiRect.w;
  const targetW = roiTargetW;
  const targetH = clamp(Math.round(roiRect.h * scale), 64, roiTargetHMax);

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

export function runInference(imageSource, opts = {}) {
  if (!segmenter || !imageSource || !opts.staffData) return;

  // Static photo: mask doesn't change between frames — only compute once per photo
  if (opts.appMode === 'photo' && photoMaskCached) return;

  const now = Date.now();
  if (inferenceInFlight || now - lastInferenceTime < inferenceInterval) return;
  lastInferenceTime = now;
  inferenceInFlight = true;

  // Yield to browser first so RAF/UI can process before we do heavy work
  setTimeout(() => {
    try {
      const isVideo = imageSource instanceof HTMLVideoElement;
      if (isVideo && imageSource.readyState < 2) {
        inferenceInFlight = false;
        return;
      }

      const displayInfo = drawSourceToDisplayCanvas(
        imageSource,
        opts.staffData,
        opts.appMode || 'live'
      );
      if (!displayInfo) {
        inferenceInFlight = false;
        return;
      }

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
        // Callback form = truly async, does NOT block main thread
        segmenter.segmentForVideo(roiCanvas, now, (result) => {
          try {
            readForegroundMask(result);
            if (opts.appMode === 'photo') {
              photoMaskCached = true;
              if (typeof opts.onMaskReady === 'function') opts.onMaskReady();
            }
            if (typeof result?.close === 'function') result.close();
          } catch { /* ignore */ }
          inferenceInFlight = false;
        });
      } else {
        // Photo: segment() is synchronous — runs once then photoMaskCached freezes it
        const result = segmenter.segment(roiCanvas);
        readForegroundMask(result);
        if (typeof result?.close === 'function') result.close();
        photoMaskCached = true;
        if (typeof opts.onMaskReady === 'function') opts.onMaskReady();
        inferenceInFlight = false;
      }
    } catch {
      inferenceInFlight = false;
    }
  }, 0);
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
  const radius = smoothRadius;
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
    if (picked.length >= edgePickLimit) break;
  }

  picked.sort((a, b) => a.y - b.y);

  edgeHistory.push(picked.map(t => t.y));
  if (edgeHistory.length > EDGE_HISTORY_LEN) edgeHistory.shift();

  return picked;
}

export function drawDetections(ctx, staffData) {
  // Optional debug overlay hook.
}

setSmartProfile('balanced');
