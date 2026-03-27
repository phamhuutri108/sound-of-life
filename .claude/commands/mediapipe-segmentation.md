# Implement MediaPipe Image Segmentation to replace COCO-SSD

## Mục tiêu

Thay thế COCO-SSD (bounding box thô, chỉ 80 class) bằng **MediaPipe Image Segmentation** để nhận được **pixel-level foreground mask**. Scan line sẽ query trực tiếp trên mask thay vì check điểm có nằm trong box không.

## Tại sao cần làm

Hệ thống hiện tại (`src/smartDetection.js`) dùng COCO-SSD trả về bounding box. `getSmartResults()` chỉ hỏi "điểm (x,y) có nằm trong box không?" — phần lớn diện tích box là không khí, gây trigger nhạc ở chỗ trống. Ngoài ra COCO-SSD chỉ nhận 80 class, bỏ qua rất nhiều vật thể thực tế.

MediaPipe Image Segmentation trả về mask 0.0–1.0 cho từng pixel, phân biệt foreground/background chính xác ở mức pixel.

## Kiến trúc hiện tại cần hiểu

Đọc kỹ các file này trước khi thay đổi:

- `src/smartDetection.js` — module cần thay thế hoàn toàn, giữ nguyên API
- `src/detection.js` — consumer: gọi `isSmartReady()`, `runInference()`, `getSmartResults()`, `loadSmartModel()`
- `src/main.js` — gọi `loadSmartModel()` khi khởi động

**API hiện tại phải giữ nguyên** (để `detection.js` không cần sửa):
```js
export function isSmartReady(): boolean
export function isSmartLoading(): boolean
export async function loadSmartModel(): Promise<void>
export async function runInference(imageSource): Promise<void>
export function getSmartResults(staffData, scanX): Array<{detected, confidence, position}> | null
export function drawDetections(ctx, staffData): void
```

## Implement

### Bước 1 — Cài package

```bash
npm install @mediapipe/tasks-vision
```

Kiểm tra xem `@mediapipe/tasks-vision` đã có trong `package.json` chưa. Nếu có rồi thì bỏ qua.

### Bước 2 — Viết lại `src/smartDetection.js`

Thay toàn bộ nội dung file. Logic chính:

**Load model:**
```js
import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

// Model nhẹ nhất: selfie_multiclass_256x256 (~3.5 MB) hoặc hair_segmentation (~1.7 MB)
// Dùng selfie_multiclass vì phân biệt foreground tốt hơn cho nhiều loại vật thể
// Nếu muốn hoàn toàn general thì dùng deeplab_v3 (~3 MB) với CATEGORY_MASK
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite';
```

**Quan trọng — chọn model đúng:**
- `selfie_multiclass_256x256`: phân biệt người/tóc/quần áo/background — tốt khi camera hướng vào người
- `deeplab_v3`: general segmentation 21 class (người, xe, cây, đồ vật...) — tốt hơn cho outdoor/objects
- Nên dùng **deeplab_v3** vì app này dùng ngoài trời, không chỉ selfie

Tìm đúng URL model từ MediaPipe documentation hoặc dùng CDN: `https://storage.googleapis.com/mediapipe-models/image_segmenter/`

**Cache mask:**
```js
// Mask là Float32Array hoặc Uint8ClampedArray, width × height
let cachedMask = null;       // confidence mask (Float32Array, giá trị 0.0–1.0)
let cachedMaskWidth = 0;
let cachedMaskHeight = 0;
const INFERENCE_INTERVAL = 150; // ms — nhanh hơn COCO-SSD vì model nhẹ hơn
```

**runInference — dùng CATEGORY_MASK hoặc CONFIDENCE_MASK:**
```js
// Ưu tiên CONFIDENCE_MASK để có giá trị 0.0–1.0 làm confidence nốt nhạc
const result = segmenter.segmentForVideo(imageSource, timestamp);
// hoặc segmenter.segment(imageSource) nếu là ảnh tĩnh (photo mode)
const confidenceMasks = result.confidenceMasks; // mảng masks theo class
// Với deeplab, lấy mask của class "background" (index 0) rồi invert
// foreground = 1 - background_mask[pixel]
```

**getSmartResults — query mask tại vị trí nốt:**
```js
export function getSmartResults(staffData, scanX) {
  if (!cachedMask || cachedMask.length === 0) return null;

  const W = staffData.displayWidth;
  const H = staffData.displayHeight;

  return staffData.positions.map(pos => {
    // Map display coordinates → mask coordinates
    const mx = Math.round((scanX / W) * cachedMaskWidth);
    const my = Math.round((pos.y / H) * cachedMaskHeight);

    // Lấy average confidence trong vùng nhỏ xung quanh điểm (giảm noise)
    const r = 3; // radius 3px trên mask
    let sum = 0, count = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = mx + dx, py = my + dy;
        if (px >= 0 && px < cachedMaskWidth && py >= 0 && py < cachedMaskHeight) {
          sum += cachedMask[py * cachedMaskWidth + px];
          count++;
        }
      }
    }
    const confidence = count > 0 ? sum / count : 0;

    return {
      detected: confidence > 0.4,  // threshold có thể tune
      confidence,
      position: pos,
    };
  });
}
```

**drawDetections — vẽ overlay mask lên canvas (debug/visual feedback):**

Thay vì vẽ bounding box, vẽ mask overlay mờ màu xanh lá lên staff canvas:
```js
export function drawDetections(ctx, staffData) {
  if (!cachedMask || !staffData) return;
  // Tạo ImageData từ mask, vẽ với globalAlpha thấp
  // Chỉ vẽ khi debug mode bật (optional)
}
```

### Bước 3 — Xử lý Photo mode vs Live mode

`runInference` nhận `imageSource` có thể là:
- `HTMLVideoElement` (live mode) → dùng `segmentForVideo(source, Date.now())`
- `HTMLImageElement` (photo mode) → dùng `segment(source)`

Detect loại:
```js
const isVideo = imageSource instanceof HTMLVideoElement;
const result = isVideo
  ? segmenter.segmentForVideo(imageSource, Date.now())
  : segmenter.segment(imageSource);
```

### Bước 4 — Fallback nếu MediaPipe load thất bại

Nếu `loadSmartModel()` throw, `isSmartReady()` trả về false → `detection.js` tự động fallback sang brightness+Canny. Không cần xử lý thêm.

### Bước 5 — Kiểm tra performance

- Inference interval: bắt đầu với 150ms, tăng lên 300ms nếu device lag
- Mask resolution: MediaPipe tự resize input, output mask thường 256×256
- Không allocate array mới mỗi frame — reuse `cachedMask`

## Lưu ý quan trọng

1. **WASM files**: `@mediapipe/tasks-vision` cần WASM bundle. Với Vite cần config để copy WASM files vào public. Xem `vite.config.js` — có thể cần thêm:
   ```js
   // vite.config.js
   import { defineConfig } from 'vite';
   export default defineConfig({
     base: '/',
     optimizeDeps: {
       exclude: ['@mediapipe/tasks-vision'],
     },
   });
   ```

2. **CDN alternative**: Nếu WASM config phức tạp, load MediaPipe từ CDN trong `index.html`:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.js" crossorigin="anonymous"></script>
   ```
   Rồi dùng `window.Vision` thay vì import.

3. **Model URL**: Phải verify URL model đúng từ https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter trước khi dùng. URL có thể thay đổi theo version.

4. **iOS Safari compatibility**: MediaPipe tasks-vision hỗ trợ iOS Safari 16+. Kiểm tra thực tế trên device.

5. **Không xóa fallback**: `detection.js` đã có brightness+Canny fallback. Chỉ cần `isSmartReady()` trả false là fallback tự chạy.

## File cần thay đổi

- `src/smartDetection.js` — viết lại hoàn toàn
- `vite.config.js` — có thể cần thêm config WASM
- `package.json` — thêm dependency `@mediapipe/tasks-vision`

## File KHÔNG được thay đổi

- `src/detection.js` — API không đổi nên không cần sửa
- `src/main.js` — không cần sửa
- `src/audio.js`, `src/staff.js`, `src/camera.js` — không liên quan
