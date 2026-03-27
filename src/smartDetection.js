import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

let ortModule = null;

let backend = 'none'; // 'none' | 'yolo' | 'mediapipe'

let yoloSession = null;
let yoloLoading = false;

let segmenter = null;
let mediapipeLoading = false;

let lastTime = 0;

let cachedMask = null;
let maskW = 0;
let maskH = 0;

let cachedColumn = null;
let cachedColumnConfidence = null;
let cacheKind = 'none'; // 'none' | 'mask' | 'column'

let maskSpace = {
  type: 'display',
  scale: 1,
  padX: 0,
  padY: 0,
  protoStride: 1,
};

const EDGE_SMOOTH_RADIUS = 2;
const MIN_EDGE_SPACING_PX = 12;
const MAX_TRANSITIONS_PER_SCAN = 4;

const YOLO_MODEL_URL = '/models/yolov8n-seg.onnx';
const YOLO_INPUT = 320;
const YOLO_PROTO = 80;
const YOLO_MASK_THRESHOLD = 0.42;
const YOLO_BASE_CONF = 0.24;
const YOLO_NMS_IOU = 0.45;
const YOLO_MAX_DET = 5;
const COLUMN_X_RADIUS = 1;

const MEDIAPIPE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';

const prepCanvas = document.createElement('canvas');
const prepCtx = prepCanvas.getContext('2d', { willReadFrequently: true });

function isHighEndIPhone() {
  const ua = navigator.userAgent || '';
  return /iPhone/i.test(ua)
    && (navigator.hardwareConcurrency || 4) >= 6
    && (window.devicePixelRatio || 1) >= 3;
}

function inferenceIntervalMs() {
  if (backend === 'yolo') return isHighEndIPhone() ? 120 : 180;
  return 170;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clearSmartCache() {
  cachedMask = null;
  cachedColumn = null;
  cachedColumnConfidence = null;
  maskW = 0;
  maskH = 0;
  cacheKind = 'none';
}

export function isSmartReady() {
  return backend !== 'none';
}

export function isSmartLoading() {
  return yoloLoading || mediapipeLoading;
}

export function getSmartBackend() {
  return backend;
}

function preferredExecutionProviders() {
  if (navigator.gpu) return ['webgpu', 'wasm'];
  return ['wasm'];
}

async function loadYoloModel() {
  if (yoloSession || yoloLoading) return;
  yoloLoading = true;
  try {
    if (!ortModule) {
      ortModule = await import('onnxruntime-web');
    }
    ortModule.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';

    yoloSession = await ortModule.InferenceSession.create(YOLO_MODEL_URL, {
      executionProviders: preferredExecutionProviders(),
      graphOptimizationLevel: 'all',
    });

    const inputName = yoloSession.inputNames[0];
    const warmup = new ortModule.Tensor(
      'float32',
      new Float32Array(1 * 3 * YOLO_INPUT * YOLO_INPUT),
      [1, 3, YOLO_INPUT, YOLO_INPUT]
    );
    await yoloSession.run({ [inputName]: warmup });
    backend = 'yolo';
  } catch (error) {
    console.warn('YOLOv8n-seg load failed, fallback to MediaPipe:', error);
    yoloSession = null;
  } finally {
    yoloLoading = false;
  }
}

async function loadMediapipeModel() {
  if (segmenter || mediapipeLoading) return;
  mediapipeLoading = true;
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
    backend = 'mediapipe';
  } catch (error) {
    console.warn('MediaPipe segmentation load failed:', error);
  } finally {
    mediapipeLoading = false;
  }
}

export async function loadSmartModel() {
  if (isSmartReady() || isSmartLoading()) return;
  await loadYoloModel();
  if (!isSmartReady()) {
    await loadMediapipeModel();
  }
}

function drawDisplayFrameToCanvas(imageSource, staffData, appMode) {
  const frameW = Math.max(1, Math.round(
    staffData?.displayWidth || imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || YOLO_INPUT
  ));
  const frameH = Math.max(1, Math.round(
    staffData?.displayHeight || imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || YOLO_INPUT
  ));
  prepCanvas.width = frameW;
  prepCanvas.height = frameH;
  prepCtx.fillStyle = '#000';
  prepCtx.fillRect(0, 0, frameW, frameH);

  const srcW = imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || frameW;
  const srcH = imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || frameH;
  if (!srcW || !srcH) return null;

  if (appMode === 'photo') {
    const scale = Math.min(frameW / srcW, frameH / srcH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const dx = (frameW - drawW) / 2;
    const dy = (frameH - drawH) / 2;
    prepCtx.drawImage(imageSource, dx, dy, drawW, drawH);
    return { frameW, frameH };
  }

  const scale = Math.max(frameW / srcW, frameH / srcH);
  const cropW = frameW / scale;
  const cropH = frameH / scale;
  const sx = (srcW - cropW) / 2;
  const sy = (srcH - cropH) / 2;
  prepCtx.drawImage(imageSource, sx, sy, cropW, cropH, 0, 0, frameW, frameH);
  return { frameW, frameH };
}

function letterboxToYoloSquare() {
  const srcW = prepCanvas.width;
  const srcH = prepCanvas.height;
  const scale = Math.min(YOLO_INPUT / srcW, YOLO_INPUT / srcH);
  const resizedW = Math.round(srcW * scale);
  const resizedH = Math.round(srcH * scale);
  const padX = (YOLO_INPUT - resizedW) / 2;
  const padY = (YOLO_INPUT - resizedH) / 2;

  const square = document.createElement('canvas');
  square.width = YOLO_INPUT;
  square.height = YOLO_INPUT;
  const squareCtx = square.getContext('2d', { willReadFrequently: true });
  squareCtx.fillStyle = 'rgb(114, 114, 114)';
  squareCtx.fillRect(0, 0, YOLO_INPUT, YOLO_INPUT);
  squareCtx.drawImage(prepCanvas, 0, 0, srcW, srcH, padX, padY, resizedW, resizedH);

  return { square, scale, padX, padY, srcW, srcH };
}

function tensorFromCanvas(canvas) {
  const imageData = canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const area = canvas.width * canvas.height;
  const data = new Float32Array(3 * area);

  for (let i = 0; i < area; i++) {
    const p = i * 4;
    data[i] = imageData[p] / 255;
    data[area + i] = imageData[p + 1] / 255;
    data[2 * area + i] = imageData[p + 2] / 255;
  }

  return new ortModule.Tensor('float32', data, [1, 3, canvas.height, canvas.width]);
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-6);
}

function nms(boxes, threshold, maxDet) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of sorted) {
    let keep = true;
    for (const prev of kept) {
      if (iou(box, prev) > threshold) {
        keep = false;
        break;
      }
    }
    if (keep) kept.push(box);
    if (kept.length >= maxDet) break;
  }
  return kept;
}

function pickDetectionAndProtoTensors(outputs) {
  const tensors = Object.values(outputs);
  let det = null;
  let proto = null;
  for (const tensor of tensors) {
    if (!Array.isArray(tensor?.dims)) continue;
    if (tensor.dims.length === 3) det = tensor;
    if (tensor.dims.length === 4) proto = tensor;
  }
  return { det, proto };
}

function buildImageEdgeColumn(scanX, displayHeight) {
  const displayWidth = prepCanvas.width;
  const edge = new Float32Array(displayHeight);
  const imageData = prepCtx.getImageData(0, 0, prepCanvas.width, prepCanvas.height).data;
  const xCenter = clamp(Math.round(scanX), 0, displayWidth - 1);

  const luma = new Float32Array(displayHeight);
  for (let y = 0; y < displayHeight; y++) {
    let sum = 0;
    let count = 0;
    for (let dx = -1; dx <= 1; dx++) {
      const x = clamp(xCenter + dx, 0, displayWidth - 1);
      const idx = (y * displayWidth + x) * 4;
      sum += 0.299 * imageData[idx] + 0.587 * imageData[idx + 1] + 0.114 * imageData[idx + 2];
      count++;
    }
    luma[y] = sum / Math.max(1, count);
  }

  let maxGrad = 1;
  for (let y = 1; y < displayHeight; y++) {
    const grad = Math.abs(luma[y] - luma[y - 1]);
    edge[y] = grad;
    if (grad > maxGrad) maxGrad = grad;
  }
  for (let y = 0; y < displayHeight; y++) {
    edge[y] /= maxGrad;
  }
  return edge;
}

function sampleProtoColumn(protoData, protoH, protoW, detections, protoX) {
  const column = new Float32Array(protoH);
  for (const detBox of detections) {
    if (protoX + COLUMN_X_RADIUS < detBox.px1 || protoX - COLUMN_X_RADIUS > detBox.px2) continue;

    const x0 = clamp(protoX - COLUMN_X_RADIUS, detBox.px1, detBox.px2);
    const x1 = clamp(protoX + COLUMN_X_RADIUS, detBox.px1, detBox.px2);
    for (let y = detBox.py1; y <= detBox.py2; y++) {
      let best = column[y];
      for (let x = x0; x <= x1; x++) {
        let logit = 0;
        const offsetBase = y * protoW + x;
        for (let c = 0; c < 32; c++) {
          logit += detBox.coeff[c] * protoData[c * protoH * protoW + offsetBase];
        }
        const value = sigmoid(logit) * (0.72 + detBox.score * 0.28);
        if (value > best) best = value;
      }
      column[y] = best;
    }
  }
  return column;
}

function upsampleProtoColumnToDisplay(protoColumn, displayHeight, scale, padY, stride) {
  const result = new Float32Array(displayHeight);
  for (let y = 0; y < displayHeight; y++) {
    const modelY = y * scale + padY;
    const protoY = clamp(modelY / stride, 0, protoColumn.length - 1);
    const y0 = Math.floor(protoY);
    const y1 = Math.min(protoColumn.length - 1, y0 + 1);
    const t = protoY - y0;
    result[y] = lerp(protoColumn[y0], protoColumn[y1], t);
  }
  return result;
}

async function runYoloInference(imageSource, opts) {
  if (typeof opts.scanX !== 'number' || !opts.staffData) return;

  const drawInfo = drawDisplayFrameToCanvas(imageSource, opts.staffData, opts.appMode);
  if (!drawInfo) return;

  const letterboxed = letterboxToYoloSquare();
  const inputTensor = tensorFromCanvas(letterboxed.square);
  const inputName = yoloSession.inputNames[0];
  const outputs = await yoloSession.run({ [inputName]: inputTensor });
  const { det, proto } = pickDetectionAndProtoTensors(outputs);
  if (!det || !proto) {
    clearSmartCache();
    return;
  }

  const detData = det.data;
  const [batch, d1, d2] = det.dims;
  if (batch !== 1) {
    clearSmartCache();
    return;
  }

  const channelsFirst = d1 <= 200 && d2 >= 1000;
  const rows = channelsFirst ? d2 : d1;
  const dims = channelsFirst ? d1 : d2;
  if (dims < 4 + 1 + 32) {
    clearSmartCache();
    return;
  }

  const classCount = dims - 4 - 32;
  const confThreshold = clamp(YOLO_BASE_CONF - (opts.sensitivity / 100) * 0.08, 0.15, 0.3);
  const pick = (row, col) => channelsFirst ? detData[col * rows + row] : detData[row * dims + col];

  const candidates = [];
  for (let row = 0; row < rows; row++) {
    const cx = pick(row, 0);
    const cy = pick(row, 1);
    const w = pick(row, 2);
    const h = pick(row, 3);
    if (w <= 2 || h <= 2) continue;

    let score = 0;
    for (let c = 0; c < classCount; c++) {
      const classScore = pick(row, 4 + c);
      if (classScore > score) score = classScore;
    }
    if (score < confThreshold) continue;

    const mx1 = cx - w / 2;
    const my1 = cy - h / 2;
    const mx2 = cx + w / 2;
    const my2 = cy + h / 2;
    const x1 = clamp((mx1 - letterboxed.padX) / letterboxed.scale, 0, letterboxed.srcW - 1);
    const y1 = clamp((my1 - letterboxed.padY) / letterboxed.scale, 0, letterboxed.srcH - 1);
    const x2 = clamp((mx2 - letterboxed.padX) / letterboxed.scale, 0, letterboxed.srcW - 1);
    const y2 = clamp((my2 - letterboxed.padY) / letterboxed.scale, 0, letterboxed.srcH - 1);
    if (x2 - x1 < 4 || y2 - y1 < 4) continue;

    const coeff = new Float32Array(32);
    for (let k = 0; k < 32; k++) {
      coeff[k] = pick(row, 4 + classCount + k);
    }

    candidates.push({ x1, y1, x2, y2, score, coeff, mx1, my1, mx2, my2 });
  }

  if (candidates.length === 0) {
    clearSmartCache();
    return;
  }

  const detections = nms(candidates, YOLO_NMS_IOU, YOLO_MAX_DET);
  const protoData = proto.data;
  const [, protoC, protoH, protoW] = proto.dims;
  if (protoC !== 32 || protoH !== YOLO_PROTO || protoW !== YOLO_PROTO) {
    clearSmartCache();
    return;
  }

  const stride = YOLO_INPUT / protoW;
  const modelX = opts.scanX * letterboxed.scale + letterboxed.padX;
  const protoX = clamp(Math.round(modelX / stride), 0, protoW - 1);

  for (const detBox of detections) {
    detBox.px1 = clamp(Math.floor(detBox.mx1 / stride), 0, protoW - 1);
    detBox.py1 = clamp(Math.floor(detBox.my1 / stride), 0, protoH - 1);
    detBox.px2 = clamp(Math.ceil(detBox.mx2 / stride), 0, protoW - 1);
    detBox.py2 = clamp(Math.ceil(detBox.my2 / stride), 0, protoH - 1);
  }

  const protoColumn = sampleProtoColumn(protoData, protoH, protoW, detections, protoX);
  const displayColumn = upsampleProtoColumnToDisplay(
    protoColumn,
    drawInfo.frameH,
    letterboxed.scale,
    letterboxed.padY,
    stride
  );

  cachedColumn = displayColumn;
  cachedColumnConfidence = buildImageEdgeColumn(opts.scanX, drawInfo.frameH);
  cacheKind = 'column';
  cachedMask = null;
  maskW = drawInfo.frameW;
  maskH = drawInfo.frameH;
  maskSpace = {
    type: 'display',
    scale: 1,
    padX: 0,
    padY: 0,
    protoStride: 1,
  };
}

function consumeMediapipeResult(result) {
  const masks = result?.confidenceMasks;
  if (!masks || masks.length === 0) return;

  const bgMask = masks[0];
  const width = bgMask.width;
  const height = bgMask.height;
  const bgData = typeof bgMask.getAsFloat32Array === 'function'
    ? bgMask.getAsFloat32Array()
    : bgMask.data;

  if (!cachedMask || cachedMask.length !== width * height) {
    cachedMask = new Float32Array(width * height);
  }
  for (let i = 0; i < bgData.length; i++) {
    cachedMask[i] = 1 - bgData[i];
  }

  cacheKind = 'mask';
  cachedColumn = null;
  cachedColumnConfidence = null;
  maskW = width;
  maskH = height;
  maskSpace = {
    type: 'display',
    scale: 1,
    padX: 0,
    padY: 0,
    protoStride: 1,
  };

  if (typeof result?.close === 'function') result.close();
}

async function runMediapipeInference(imageSource) {
  const isVideo = imageSource instanceof HTMLVideoElement;
  if (isVideo && imageSource.readyState < 2) return;

  if (isVideo) {
    segmenter.segmentForVideo(imageSource, Date.now(), consumeMediapipeResult);
  } else {
    consumeMediapipeResult(segmenter.segment(imageSource));
  }
}

export async function runInference(imageSource, opts = {}) {
  if (!imageSource || !isSmartReady()) return;

  const now = Date.now();
  if (now - lastTime < inferenceIntervalMs()) return;
  lastTime = now;

  const merged = {
    appMode: opts.appMode || 'live',
    scanX: opts.scanX,
    sensitivity: typeof opts.sensitivity === 'number' ? opts.sensitivity : 70,
    staffData: opts.staffData || null,
  };

  try {
    if (backend === 'yolo' && yoloSession) {
      await runYoloInference(imageSource, merged);
      return;
    }
    if (backend === 'mediapipe' && segmenter) {
      await runMediapipeInference(imageSource);
    }
  } catch {
    clearSmartCache();
  }
}

function getTransitionsFromColumn(staffData, sensitivity) {
  if (!cachedColumn || cachedColumn.length === 0) return null;

  const yStart = clamp(Math.round(staffData.staffTop), 0, cachedColumn.length - 1);
  const yEnd = clamp(Math.round(staffData.staffBottom), 0, cachedColumn.length - 1);
  if (yEnd <= yStart) return null;

  const smoothed = new Float32Array(cachedColumn.length);
  for (let y = 0; y < cachedColumn.length; y++) {
    let sum = 0;
    let count = 0;
    for (let dy = -EDGE_SMOOTH_RADIUS; dy <= EDGE_SMOOTH_RADIUS; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < cachedColumn.length) {
        sum += cachedColumn[yy];
        count++;
      }
    }
    smoothed[y] = sum / Math.max(1, count);
  }

  let roiMean = 0;
  let roiMax = 0;
  for (let y = yStart; y <= yEnd; y++) {
    const value = smoothed[y];
    roiMean += value;
    if (value > roiMax) roiMax = value;
  }
  const roiLen = yEnd - yStart + 1;
  roiMean /= Math.max(1, roiLen);

  const sens = clamp(sensitivity / 100, 0, 1);
  const highThreshold = clamp(roiMean + (roiMax - roiMean) * 0.18 - sens * 0.08, 0.18, 0.68);
  const lowThreshold = clamp(highThreshold - 0.08, 0.1, 0.58);

  const candidates = [];
  let prevAbove = smoothed[yStart] > highThreshold;
  for (let y = yStart + 1; y <= yEnd; y++) {
    const prev = smoothed[y - 1];
    const cur = smoothed[y];
    const curAbove = cur > highThreshold;
    if (!prevAbove && prev < lowThreshold && curAbove) {
      const maskGrad = Math.max(0, cur - prev);
      const edgeGrad = cachedColumnConfidence ? cachedColumnConfidence[y] : 0;
      const confidence = clamp(cur * 0.45 + maskGrad * 1.6 + edgeGrad * 0.8, 0.2, 1);
      candidates.push({ y, confidence });
    }
    prevAbove = curAbove;
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.confidence - a.confidence);
  const accepted = [];
  for (const candidate of candidates) {
    const near = accepted.some(prev => Math.abs(prev.y - candidate.y) < MIN_EDGE_SPACING_PX);
    if (!near) accepted.push(candidate);
    if (accepted.length >= MAX_TRANSITIONS_PER_SCAN) break;
  }

  accepted.sort((a, b) => a.y - b.y);
  return accepted.map(item => ({ y: item.y, confidence: item.confidence }));
}

function getTransitionsFromMask(staffData, scanX, sensitivity) {
  if (!cachedMask || maskW === 0 || maskH === 0) return null;

  const mx = clamp(Math.round((scanX / staffData.displayWidth) * maskW), 0, maskW - 1);
  const yStart = clamp(Math.round((staffData.staffTop / staffData.displayHeight) * maskH), 0, maskH - 1);
  const yEnd = clamp(Math.round((staffData.staffBottom / staffData.displayHeight) * maskH), 0, maskH - 1);
  if (yEnd <= yStart) return null;

  const column = new Float32Array(maskH);
  for (let y = 0; y < maskH; y++) {
    column[y] = cachedMask[y * maskW + mx];
  }

  const smoothed = new Float32Array(maskH);
  for (let y = 0; y < maskH; y++) {
    let sum = 0;
    let count = 0;
    for (let dy = -EDGE_SMOOTH_RADIUS; dy <= EDGE_SMOOTH_RADIUS; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < maskH) {
        sum += column[yy];
        count++;
      }
    }
    smoothed[y] = sum / Math.max(1, count);
  }

  let roiMean = 0;
  let roiMax = 0;
  for (let y = yStart; y <= yEnd; y++) {
    roiMean += smoothed[y];
    if (smoothed[y] > roiMax) roiMax = smoothed[y];
  }
  roiMean /= Math.max(1, yEnd - yStart + 1);

  const sens = clamp(sensitivity / 100, 0, 1);
  const highThreshold = clamp(roiMean + (roiMax - roiMean) * 0.15 - sens * 0.08, 0.2, 0.72);
  const lowThreshold = clamp(highThreshold - 0.08, 0.12, 0.62);

  const candidates = [];
  let prevAbove = smoothed[yStart] > highThreshold;
  for (let y = yStart + 1; y <= yEnd; y++) {
    const prev = smoothed[y - 1];
    const cur = smoothed[y];
    const curAbove = cur > highThreshold;
    if (!prevAbove && prev < lowThreshold && curAbove) {
      const confidence = clamp(cur * 0.55 + Math.max(0, cur - prev) * 2.1, 0.2, 1);
      candidates.push({ y, confidence });
    }
    prevAbove = curAbove;
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.confidence - a.confidence);
  const accepted = [];
  for (const candidate of candidates) {
    const near = accepted.some(prev => Math.abs(prev.y - candidate.y) < MIN_EDGE_SPACING_PX / 2);
    if (!near) accepted.push(candidate);
    if (accepted.length >= MAX_TRANSITIONS_PER_SCAN) break;
  }

  accepted.sort((a, b) => a.y - b.y);
  return accepted.map(item => ({
    y: (item.y / maskH) * staffData.displayHeight,
    confidence: item.confidence,
  }));
}

export function getEdgeTransitions(staffData, scanX, sensitivity = 50) {
  if (!staffData) return null;
  if (cacheKind === 'column') return getTransitionsFromColumn(staffData, sensitivity);
  if (cacheKind === 'mask') return getTransitionsFromMask(staffData, scanX, sensitivity);
  return null;
}

export function drawDetections(ctx, staffData) {
  // Reserved for future debug overlay.
}