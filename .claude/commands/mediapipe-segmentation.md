# Thay thế hệ thống phát hiện nốt nhạc: MediaPipe Segmentation + Edge-triggered Notes

## Tổng quan

Viết lại hoàn toàn hệ thống quét nốt nhạc. Hệ thống hiện tại sai ở mức kiến trúc:
- Nó check "có vật thể ở 13 vị trí CỐ ĐỊNH trên khuông nhạc không?" → sai
- Đúng phải là: "scan line CHẠM VÀO RÌA vật thể ở ĐÂU?" → nốt nhạc trigger tại đó

## Video reference (cần hiểu trước khi code)

App lấy cảm hứng từ tác phẩm "일상 속 풍경을 음악으로 듣는다면" — scan line quét từ trái sang phải:
- Chim đậu trên dây điện → mỗi chú chim là một nốt, vị trí Y = cao độ
- Hạt lúa trên thân cây → mật độ dày = giai điệu nhanh
- Đường viền gạch ngoằn ngoèo → pitch trượt lên xuống theo hình dạng
- Lon rác vứt ngổn ngang → nhịp ngẫu hứng, dồn dập
- Ánh đèn thành phố ban đêm → ambient thưa thớt

**Quy tắc cốt lõi:**
1. Nốt nhạc CHỈ trigger khi scan line chạm BIÊN/RÌA vật thể (transition background→foreground), KHÔNG phải suốt khi đi qua bên trong
2. Vị trí Y thực tế của rìa vật thể quyết định CAO ĐỘ nốt — cao = nốt cao, thấp = nốt trầm
3. Mật độ vật thể trên đường quét quyết định NHỊP ĐIỆU
4. Độ tương phản/sharpness của rìa vật thể quyết định VELOCITY (mạnh/nhẹ)

## Kiến trúc hiện tại (cần hiểu để biết phải sửa gì)

### Flow hiện tại (SAI):
```
13 vị trí Y cố định (staff positions)
  → Tại mỗi vị trí: "có vật thể không?" (COCO-SSD box hoặc brightness)
  → Nếu có: playNote(SCALES[index])
```

Vấn đề: một vật thể lớn trigger TẤT CẢ các vị trí nó bao phủ liên tục. Không có nhịp điệu, không có phân biệt rìa vs bên trong.

### Flow mới (ĐÚNG):
```
Tại scanX, lấy CỘT pixel từ segmentation mask
  → Tìm tất cả TRANSITIONS (0→1, nền→vật) trong cột đó
  → Mỗi transition tại Y:
      - Map Y → nốt nhạc (Y càng cao trên màn hình → nốt càng cao)
      - Trigger nốt đó với velocity từ sharpness của transition
  → KHÔNG trigger khi ở bên trong vật thể (transition đã xảy ra rồi)
```

## Các file cần thay đổi

### File 1: `src/smartDetection.js` — VIẾT LẠI HOÀN TOÀN

Thay COCO-SSD bằng MediaPipe Image Segmentation.

**Cài package:**
```bash
npm install @mediapipe/tasks-vision
```

**API exports phải giữ nguyên tên** (nhưng thay đổi behavior):
```js
export function isSmartReady(): boolean
export function isSmartLoading(): boolean
export async function loadSmartModel(): Promise<void>
export async function runInference(imageSource): Promise<void>
export function drawDetections(ctx, staffData): void
```

**XÓA** `getSmartResults()` — thay bằng API mới:
```js
export function getEdgeTransitions(staffData, scanX): Array<{y, confidence}> | null
```

**Pseudocode:**
```js
import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

let segmenter = null;
let loading = false;

// Cache mask mỗi frame
let cachedMask = null;     // Float32Array 0.0–1.0
let maskW = 0, maskH = 0;
const INFERENCE_INTERVAL = 150; // ms

export async function loadSmartModel() {
  if (segmenter || loading) return;
  loading = true;
  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
    );
    // deeplab_v3: general 21-class segmentation — tốt cho outdoor
    // Tìm đúng URL từ https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter
    // Hoặc dùng selfie_multiclass nếu deeplab URL không available
    segmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'MODEL_URL_HERE', // PHẢI verify URL đúng
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
    // Nếu video chưa ready thì skip
    if (isVideo && imageSource.readyState < 2) return;

    const result = isVideo
      ? segmenter.segmentForVideo(imageSource, now)
      : segmenter.segment(imageSource);

    // Lấy confidence mask — mảng masks theo class
    // Index 0 thường là background. Tạo foreground mask = max của tất cả class khác background
    const masks = result.confidenceMasks;
    if (masks && masks.length > 0) {
      const bgMask = masks[0]; // background class
      const w = bgMask.width;
      const h = bgMask.height;
      // foreground = 1 - background
      // Hoặc nếu nhiều class: foreground = max(class1, class2, ...) bỏ background
      if (!cachedMask || cachedMask.length !== w * h) {
        cachedMask = new Float32Array(w * h);
      }
      maskW = w;
      maskH = h;
      const bgData = bgMask.getAsFloat32Array();
      for (let i = 0; i < bgData.length; i++) {
        cachedMask[i] = 1.0 - bgData[i]; // invert: high = foreground
      }
    }
    // Close result to free memory
    if (result.close) result.close();
  } catch (e) {
    // silently ignore
  }
}

/**
 * TÌM CÁC TRANSITION (rìa vật thể) dọc theo cột scanX.
 *
 * Trả về mảng { y (display coords), confidence }
 * Chỉ trả về điểm CHUYỂN TIẾP từ nền→vật (rising edge),
 * KHÔNG trả về pixel bên trong vật thể.
 */
export function getEdgeTransitions(staffData, scanX) {
  if (!cachedMask || maskW === 0) return null;

  const W = staffData.displayWidth;
  const H = staffData.displayHeight;

  // Map scanX từ display coords → mask coords
  const mx = Math.round((scanX / W) * maskW);
  if (mx < 0 || mx >= maskW) return null;

  // Đọc cột dọc từ mask
  const column = new Float32Array(maskH);
  for (let y = 0; y < maskH; y++) {
    column[y] = cachedMask[y * maskW + mx];
  }

  // Smooth cột (low-pass filter) để giảm noise
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

  // Tìm transitions: nơi mask chuyển từ <threshold sang >threshold
  const THRESHOLD = 0.4;
  const transitions = [];
  let prevAbove = smoothed[0] > THRESHOLD;

  for (let y = 1; y < maskH; y++) {
    const curAbove = smoothed[y] > THRESHOLD;
    if (curAbove && !prevAbove) {
      // Rising edge — vật thể bắt đầu
      // Confidence = sự sắc nét của transition (gradient)
      const gradient = Math.abs(smoothed[y] - smoothed[y - 1]);
      const confidence = Math.min(1.0, gradient * 3 + smoothed[y] * 0.5);
      transitions.push({
        y: (y / maskH) * H,  // chuyển về display coords
        confidence: Math.max(0.3, confidence),
      });
    }
    prevAbove = curAbove;
  }

  return transitions.length > 0 ? transitions : null;
}

export function drawDetections(ctx, staffData) {
  // Optional: vẽ mask overlay mờ (debug mode)
  // Hoặc vẽ các điểm transition như chấm sáng
}
```

### File 2: `src/detection.js` — SỬA import và flow

Thay đổi chính: Không còn dùng `getSmartResults()` với 13 vị trí cố định. Dùng `getEdgeTransitions()` trả về mảng transitions tại Y thực.

```js
import { isSmartReady, runInference, getEdgeTransitions } from './smartDetection.js';

// Sửa function detectObjects():
export function detectObjects({ appMode, photoImgEl, staffData, scanX, sensitivity }) {
  if (!staffData) return null;

  // ── Smart path: MediaPipe segmentation ──
  if (isSmartReady()) {
    const video = document.getElementById('cameraVideo');
    const source = (appMode === 'photo' && photoImgEl) ? photoImgEl : video;
    runInference(source);

    const transitions = getEdgeTransitions(staffData, scanX);
    if (transitions) {
      // Trả về dạng mới: mảng {y, confidence, noteIndex}
      // Map mỗi transition Y → note index trong scale
      return transitions.map(t => ({
        detected: true,
        confidence: t.confidence,
        y: t.y,
        noteIndex: yToNoteIndex(t.y, staffData),
      }));
    }
    // Fall through nếu chưa có mask
  }

  // ── Fallback: brightness + Canny (giữ nguyên logic cũ) ──
  // ... giữ nguyên code fallback hiện tại nhưng wrap kết quả cùng format
}

/**
 * Map vị trí Y (display) → index trong scale (0–12)
 * Y thấp hơn (phía dưới) = index thấp (nốt trầm)
 * Y cao hơn (phía trên) = index cao (nốt cao)
 */
function yToNoteIndex(y, staffData) {
  const { staffTop, staffBottom } = staffData;
  // Clamp Y vào vùng staff
  const clampedY = Math.max(staffTop, Math.min(staffBottom, y));
  // Invert: staffBottom = nốt thấp (index 0), staffTop = nốt cao (index 12)
  const ratio = 1 - (clampedY - staffTop) / (staffBottom - staffTop);
  return Math.round(ratio * 12);
}
```

### File 3: `src/main.js` — SỬA animation loop

Thay đổi cách trigger notes: Không còn loop qua 13 vị trí cố định. Dùng transitions trực tiếp.

**Sửa phần animationLoop** (khoảng line 313-360):
```js
// Trigger notes từ edge transitions
if (lastDetectionResults && isAudioReady()) {
  let fired = 0;
  for (const result of lastDetectionResults) {
    if (fired >= MAX_NOTES_PER_PASS) break;
    if (!result.detected) continue;

    // Dùng noteIndex (từ Y position) thay vì index cố định
    const noteIdx = result.noteIndex !== undefined ? result.noteIndex : 0;
    const noteId = `note_y_${Math.round(result.y || 0)}`;

    if (shouldTriggerNote(noteId, now, 250)) {
      playNote(getNoteForPosition(noteIdx), confidenceToVelocity(result.confidence));
      fired++;
    }
  }
}
```

Cooldown key dùng `note_y_${y}` thay vì `note_${i}` — vì giờ notes không có index cố định mà theo vị trí Y thực.

**Sửa phần renderStaff call:**
```js
// Truyền transitions thay vì fixed-position results
renderStaff(curScanX, lastDetectionResults, staffData, isPlaying);
```

### File 4: `src/staff.js` — SỬA renderStaff và drawNoteIndicator

Vì notes giờ ở vị trí Y động (không cố định trên khuông), render phải thay đổi.

**Sửa renderStaff:**
```js
export function renderStaff(scanX, detectionResults, staffData, isPlaying) {
  if (!staffData) return;
  const sd = staffData;
  ctx.clearRect(0, 0, sd.displayWidth, sd.displayHeight);

  // Staff lines vẫn vẽ như cũ (visual guide)
  if (showGrid) drawStaffLines(sd);
  if (showClef) drawTrebleClef(sd);

  if (isPlaying && scanX >= sd.staffLeft && scanX <= sd.staffRight) {
    drawScanLine(scanX, sd);
  }

  if (detectionResults) {
    // Vẽ passive dots tại 13 vị trí cố định (staff positions)
    sd.positions.forEach(pos => {
      drawNoteIndicator(scanX, pos.y, false, 0);
    });

    // Vẽ ACTIVE notes tại vị trí Y thực của transitions
    for (const r of detectionResults) {
      if (r.detected && r.y !== undefined) {
        drawNoteIndicator(scanX, r.y, true, r.confidence);
      }
    }
  } else {
    sd.positions.forEach(pos => {
      drawNoteIndicator(scanX, pos.y, false, 0);
    });
  }
}
```

### File 5: `vite.config.js` — WASM config

```js
import { defineConfig } from 'vite';
export default defineConfig({
  base: '/',
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
});
```

## Thứ tự implement

1. **`npm install @mediapipe/tasks-vision`**
2. **`src/smartDetection.js`** — viết lại hoàn toàn (MediaPipe + edge transitions)
3. **`src/detection.js`** — sửa import, thêm `yToNoteIndex()`, đổi return format
4. **`src/main.js`** — sửa animation loop (trigger notes từ transitions)
5. **`src/staff.js`** — sửa renderStaff (vẽ notes tại Y động)
6. **`vite.config.js`** — thêm WASM exclude
7. Test trên mobile real device

## Fallback strategy

- Nếu MediaPipe load thất bại → `isSmartReady()` = false → detection.js tự dùng brightness+Canny
- Fallback CŨ vẫn dùng 13 vị trí cố định (chấp nhận được cho fallback)
- Format trả về của fallback phải wrap để compatible:
  ```js
  return fixedResults.map((r, i) => ({
    ...r,
    y: staffData.positions[i].y,
    noteIndex: i,
  }));
  ```

## Lưu ý kỹ thuật

1. **Model URL**: PHẢI verify URL đúng trước khi dùng. Check `https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter` — URL model có thể thay đổi theo version.

2. **WASM files**: MediaPipe cần WASM runtime. Load từ CDN: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm`. Nếu lỗi CORS hoặc WASM, thử load bằng `<script>` tag trong `index.html` thay vì npm import.

3. **Cooldown tuning**: `shouldTriggerNote` cooldown nên tăng lên 250ms (từ 180ms) vì edge transitions chính xác hơn — không cần trigger nhanh.

4. **MAX_NOTES_PER_PASS**: Giữ nguyên 2 hoặc tăng lên 3 vì giờ notes chính xác hơn, ít noise hơn.

5. **iOS Safari**: MediaPipe tasks-vision cần Safari 16+. Test thực tế trên device.

6. **Memory**: Gọi `result.close()` sau khi đọc mask xong để free WASM memory.

## File KHÔNG thay đổi

- `src/audio.js` — không cần sửa (playNote, getNoteForPosition vẫn dùng được)
- `src/camera.js` — không liên quan
- `src/i18n.js` — không liên quan
- `index.html` — không cần sửa (trừ khi phải load WASM bằng script tag)
