import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

let ortModule = null;

let backend = 'none'; // 'none' | 'yolo' | 'mediapipe'

let yoloSession = null;
let yoloLoading = false;

let segmenter = null;
let mediapipeLoading = false;

let lastTime = 0;

// Cache foreground mask in [0,1]
let cachedMask = null;
let maskW = 0;
let maskH = 0;

// Mapping from display coordinates <-> cached mask coordinates.
let maskSpace = {
  type: 'display',
  scale: 1,
  padX: 0,
  padY: 0,
  protoStride: 1,
};

const EDGE_SMOOTH_RADIUS = 2;
const MIN_EDGE_SPACING_PX = 6;
const MAX_TRANSITIONS_PER_SCAN = 6;

const YOLO_MODEL_URL = '/models/yolov8n-seg.onnx';
const YOLO_INPUT = 640;
const YOLO_PROTO = 160;
const YOLO_MASK_THRESHOLD = 0.5;
const YOLO_BASE_CONF = 0.22;
const YOLO_NMS_IOU = 0.5;
const YOLO_MAX_DET = 8;

const MEDIAPIPE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';

const prepCanvas = document.createElement('canvas');
const prepCtx = prepCanvas.getContext('2d', { willReadFrequently: true });

function isHighEndIPhone() {
  const ua = navigator.userAgent || '';
  const isIPhone = /iPhone/i.test(ua);
  const hc = navigator.hardwareConcurrency || 4;
  const dpr = window.devicePixelRatio || 1;
  return isIPhone && hc >= 6 && dpr >= 3;
}

function inferenceIntervalMs() {
  if (backend === 'yolo') {
    return isHighEndIPhone() ? 95 : 130;
  }
  return 150;
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
    const providers = preferredExecutionProviders();
    yoloSession = await ortModule.InferenceSession.create(YOLO_MODEL_URL, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });

    const inputName = yoloSession.inputNames[0];
    const warmup = new ortModule.Tensor('float32', new Float32Array(1 * 3 * YOLO_INPUT * YOLO_INPUT), [1, 3, YOLO_INPUT, YOLO_INPUT]);
    await yoloSession.run({ [inputName]: warmup });

    backend = 'yolo';
  } catch (e) {
    console.warn('YOLOv8n-seg load failed, fallback to MediaPipe:', e);
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
  } catch (e) {
    console.warn('MediaPipe segmentation load failed:', e);
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
  const frameW = Math.max(1, Math.round(staffData?.displayWidth || imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || YOLO_INPUT));
  const frameH = Math.max(1, Math.round(staffData?.displayHeight || imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || YOLO_INPUT));
  prepCanvas.width = frameW;
  prepCanvas.height = frameH;
  prepCtx.fillStyle = '#000';
  prepCtx.fillRect(0, 0, frameW, frameH);

  const srcW = imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || frameW;
  const srcH = imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || frameH;
  if (!srcW || !srcH) {
    return null;
  }

  if (appMode === 'photo') {
    // Match CSS photo preview: background-size contain
    const scale = Math.min(frameW / srcW, frameH / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    const dx = (frameW - dw) / 2;
    const dy = (frameH - dh) / 2;
    prepCtx.drawImage(imageSource, dx, dy, dw, dh);
    return { frameW, frameH, drawMode: 'contain' };
  }

  // Match CSS live video: object-fit cover
  const scale = Math.max(frameW / srcW, frameH / srcH);
  const cropW = frameW / scale;
  const cropH = frameH / scale;
  const sx = (srcW - cropW) / 2;
  const sy = (srcH - cropH) / 2;
  prepCtx.drawImage(imageSource, sx, sy, cropW, cropH, 0, 0, frameW, frameH);
  return { frameW, frameH, drawMode: 'cover' };
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
  const sqCtx = square.getContext('2d', { willReadFrequently: true });
  sqCtx.fillStyle = 'rgb(114, 114, 114)';
  sqCtx.fillRect(0, 0, YOLO_INPUT, YOLO_INPUT);
  sqCtx.drawImage(prepCanvas, 0, 0, srcW, srcH, padX, padY, resizedW, resizedH);

  return { square, scale, padX, padY, srcW, srcH };
}

function tensorFromCanvas(canvas) {
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Float32Array(1 * 3 * canvas.width * canvas.height);
  const area = canvas.width * canvas.height;

  for (let i = 0; i < area; i++) {
    const p = i * 4;
    data[i] = img[p] / 255;
    data[area + i] = img[p + 1] / 255;
    data[2 * area + i] = img[p + 2] / 255;
  }

  return new ortModule.Tensor('float32', data, [1, 3, canvas.height, canvas.width]);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sigmoid(v) {
  return 1 / (1 + Math.exp(-v));
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-6);
}

function nms(boxes, iouThreshold, maxDet) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of sorted) {
    let keep = true;
    for (const k of kept) {
      if (iou(box, k) > iouThreshold) {
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

  for (const t of tensors) {
    if (!Array.isArray(t?.dims)) continue;
    if (t.dims.length === 3) det = t;
    if (t.dims.length === 4) proto = t;
  }
  return { det, proto };
}

async function runYoloInference(imageSource, opts) {
  const drawInfo = drawDisplayFrameToCanvas(imageSource, opts.staffData, opts.appMode);
  if (!drawInfo) return;

  const lb = letterboxToYoloSquare();
  const inputTensor = tensorFromCanvas(lb.square);
  const inputName = yoloSession.inputNames[0];
  const outputs = await yoloSession.run({ [inputName]: inputTensor });
  const { det, proto } = pickDetectionAndProtoTensors(outputs);
  if (!det || !proto) return;

  const detData = det.data;
  const [b0, d1, d2] = det.dims;
  if (b0 !== 1) return;

  // Most exports are [1, 116, 8400], but support [1, 8400, 116] too.
  const channelsFirst = d1 <= 200 && d2 >= 1000;
  const rows = channelsFirst ? d2 : d1;
  const dims = channelsFirst ? d1 : d2;
  if (dims < 4 + 1 + 32) return;

  const classCount = dims - 4 - 32;
  const confThreshold = clamp(YOLO_BASE_CONF - (opts.sensitivity / 100) * 0.08, 0.12, 0.3);

  const candidates = [];
  const pick = (r, c) => {
    if (channelsFirst) {
      return detData[c * rows + r];
    }
    return detData[r * dims + c];
  };

  for (let r = 0; r < rows; r++) {
    const cx = pick(r, 0);
    const cy = pick(r, 1);
    const w = pick(r, 2);
    const h = pick(r, 3);
    if (w <= 2 || h <= 2) continue;

    let score = 0;
    for (let c = 0; c < classCount; c++) {
      const p = pick(r, 4 + c);
      if (p > score) score = p;
    }
    if (score < confThreshold) continue;

    const mx1 = cx - w / 2;
    const my1 = cy - h / 2;
    const mx2 = cx + w / 2;
    const my2 = cy + h / 2;

    const x1 = clamp((mx1 - lb.padX) / lb.scale, 0, lb.srcW - 1);
    const y1 = clamp((my1 - lb.padY) / lb.scale, 0, lb.srcH - 1);
    const x2 = clamp((mx2 - lb.padX) / lb.scale, 0, lb.srcW - 1);
    const y2 = clamp((my2 - lb.padY) / lb.scale, 0, lb.srcH - 1);

    if (x2 - x1 < 4 || y2 - y1 < 4) continue;

    const coeff = new Float32Array(32);
    for (let k = 0; k < 32; k++) {
      coeff[k] = pick(r, 4 + classCount + k);
    }

    candidates.push({ x1, y1, x2, y2, score, coeff, mx1, my1, mx2, my2 });
  }

  if (candidates.length === 0) {
    cachedMask = null;
    return;
  }

  const detections = nms(candidates, YOLO_NMS_IOU, YOLO_MAX_DET);

  const protoData = proto.data;
  const [, protoC, protoH, protoW] = proto.dims;
  if (protoC !== 32 || protoH !== YOLO_PROTO || protoW !== YOLO_PROTO) return;

  const unionMask = new Float32Array(protoW * protoH);
  const stride = YOLO_INPUT / protoW;

  for (const detBox of detections) {
    const px1 = clamp(Math.floor(detBox.mx1 / stride), 0, protoW - 1);
    const py1 = clamp(Math.floor(detBox.my1 / stride), 0, protoH - 1);
    const px2 = clamp(Math.ceil(detBox.mx2 / stride), 0, protoW - 1);
    const py2 = clamp(Math.ceil(detBox.my2 / stride), 0, protoH - 1);
    const scoreBoost = 0.7 + detBox.score * 0.3;

    for (let y = py1; y <= py2; y++) {
      for (let x = px1; x <= px2; x++) {
        const pIdx = y * protoW + x;
        let m = 0;
        for (let c = 0; c < 32; c++) {
          m += detBox.coeff[c] * protoData[(c * protoH + y) * protoW + x];
        }
        const sm = sigmoid(m);
        if (sm > YOLO_MASK_THRESHOLD) {
          const fg = sm * scoreBoost;
          if (fg > unionMask[pIdx]) unionMask[pIdx] = fg;
        }
      }
    }
  }

  cachedMask = unionMask;
  maskW = protoW;
  maskH = protoH;
  maskSpace = {
    type: 'yolo-proto',
    scale: lb.scale,
    padX: lb.padX,
    padY: lb.padY,
    protoStride: stride,
    frameW: lb.srcW,
    frameH: lb.srcH,
  };
}

function consumeMediapipeResult(result) {
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
    maskSpace = {
      type: 'display',
      scale: 1,
      padX: 0,
      padY: 0,
      protoStride: 1,
    };
  }
  if (typeof result?.close === 'function') result.close();
}

async function runMediapipeInference(imageSource) {
  const isVideo = imageSource instanceof HTMLVideoElement;
  if (isVideo && imageSource.readyState < 2) return;
  if (isVideo) {
    segmenter.segmentForVideo(imageSource, Date.now(), consumeMediapipeResult);
  } else {
    const result = segmenter.segment(imageSource);
    consumeMediapipeResult(result);
  }
}

export async function runInference(imageSource, opts = {}) {
  if (!imageSource || !isSmartReady()) return;

  const now = Date.now();
  if (now - lastTime < inferenceIntervalMs()) return;
  lastTime = now;

  const merged = {
    appMode: opts.appMode || 'live',
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
    // Keep silent to avoid spamming logs in realtime loop.
  }
}

function mapDisplayXToMaskX(scanX, staffData) {
  if (maskSpace.type === 'display') {
    const mx = Math.round((scanX / staffData.displayWidth) * maskW);
    return clamp(mx, 0, maskW - 1);
  }
  const modelX = scanX * maskSpace.scale + maskSpace.padX;
  const mx = Math.round(modelX / maskSpace.protoStride);
  return clamp(mx, 0, maskW - 1);
}

function mapDisplayYToMaskY(displayY, staffData) {
  if (maskSpace.type === 'display') {
    const my = Math.round((displayY / Math.max(1, staffData.displayHeight)) * maskH);
    return clamp(my, 0, maskH - 1);
  }
  const modelY = displayY * maskSpace.scale + maskSpace.padY;
  const my = Math.round(modelY / maskSpace.protoStride);
  return clamp(my, 0, maskH - 1);
}

function mapMaskYToDisplayY(maskY, staffData) {
  if (maskSpace.type === 'display') {
    return (maskY / maskH) * staffData.displayHeight;
  }
  const modelY = maskY * maskSpace.protoStride;
  const displayY = (modelY - maskSpace.padY) / Math.max(1e-6, maskSpace.scale);
  return clamp(displayY, 0, staffData.displayHeight);
}

/**
 * Returns transitions on current scan column: [{ y, confidence }]
 */
export function getEdgeTransitions(staffData, scanX, sensitivity = 50) {
  if (!cachedMask || maskW === 0 || maskH === 0 || !staffData) return null;

  const mx = mapDisplayXToMaskX(scanX, staffData);

  const staffTopMask = mapDisplayYToMaskY(staffData.staffTop, staffData);
  const staffBottomMask = mapDisplayYToMaskY(staffData.staffBottom, staffData);
  const yStart = Math.min(staffTopMask, staffBottomMask);
  const yEnd = Math.max(staffTopMask, staffBottomMask);
  if (yEnd <= yStart) return null;

  const column = new Float32Array(maskH);
  for (let y = 0; y < maskH; y++) {
    column[y] = cachedMask[y * maskW + mx];
  }

  const smoothed = new Float32Array(maskH);
  const kernelR = EDGE_SMOOTH_RADIUS;
  for (let y = 0; y < maskH; y++) {
    let sum = 0;
    let count = 0;
    for (let dy = -kernelR; dy <= kernelR; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < maskH) {
        sum += column[yy];
        count++;
      }
    }
    smoothed[y] = sum / count;
  }

  let sum = 0;
  let maxVal = 0;
  for (let y = yStart; y <= yEnd; y++) {
    const v = smoothed[y];
    sum += v;
    if (v > maxVal) maxVal = v;
  }
  const len = yEnd - yStart + 1;
  const meanVal = len > 0 ? sum / len : 0.4;
  const sensNorm = clamp(sensitivity / 100, 0, 1);
  const highThreshold = clamp(meanVal + (maxVal - meanVal) * 0.15 - sensNorm * 0.08, 0.2, 0.72);
  const lowThreshold = clamp(highThreshold - 0.08, 0.12, 0.62);

  const candidates = [];
  let prevAbove = smoothed[yStart] > highThreshold;
  for (let y = yStart + 1; y <= yEnd; y++) {
    const prev = smoothed[y - 1];
    const cur = smoothed[y];
    const curAbove = cur > highThreshold;
    if (!prevAbove && prev < lowThreshold && curAbove) {
      const y0 = Math.max(yStart, y - 2);
      const y1 = Math.min(yEnd, y + 2);
      const gradient = Math.max(0, smoothed[y1] - smoothed[y0]);
      const confidence = Math.min(1, gradient * 2.5 + cur * 0.45);
      candidates.push({ y, confidence: Math.max(0.2, confidence) });
    }
    prevAbove = curAbove;
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.confidence - a.confidence);
  const accepted = [];
  for (const c of candidates) {
    const near = accepted.some(a => Math.abs(a.y - c.y) < MIN_EDGE_SPACING_PX);
    if (!near) accepted.push(c);
    if (accepted.length >= MAX_TRANSITIONS_PER_SCAN) break;
  }

  accepted.sort((a, b) => a.y - b.y);
  return accepted.map(t => ({
    y: mapMaskYToDisplayY(t.y, staffData),
    confidence: t.confidence,
  }));
}

export function drawDetections(ctx, staffData) {
  // Optional debug overlay hook.
}
