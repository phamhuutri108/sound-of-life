# Detection Algorithm — Sound of Life

## Overview

Two detection methods run in combination. Brightness analysis is always active (fast fallback). OpenCV Canny edge detection activates once the library loads and provides higher accuracy.

## Method 1: Brightness Contrast Analysis

### Algorithm

For each note position along the scan line:

1. Define a sampling region: small rectangle centered on the note position
   - Width: 20-30px (adjusted for resolution)
   - Height: line spacing / 2

2. Extract pixel data from the sampling region using `ctx.getImageData()`

3. Convert to grayscale: `gray = 0.299*R + 0.587*G + 0.114*B`

4. Compute local average brightness of the sampling region

5. Compare to reference brightness:
   - In PHOTO mode: compute global average brightness of the full image once
   - In LIVE mode: compute average brightness of a reference strip (top or bottom edge without objects)

6. Detection: if `|localBrightness - referenceBrightness| > threshold` → object present

### Adaptive Threshold

```javascript
// Base threshold adjusts to scene contrast
function computeAdaptiveThreshold(imageData) {
  const pixels = imageData.data;
  let min = 255, max = 0;
  for (let i = 0; i < pixels.length; i += 16) { // sample every 4th pixel
    const gray = 0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2];
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }
  const contrast = max - min;
  // Scale threshold: high contrast scene = higher threshold needed
  // Low contrast = lower threshold to catch subtle objects
  return Math.max(20, Math.min(80, contrast * 0.3));
}
```

### Sensitivity Control

User-adjustable sensitivity (0-100) maps to threshold multiplier:
- Sensitivity 0 (low): threshold × 1.5 (harder to trigger)
- Sensitivity 50 (default): threshold × 1.0
- Sensitivity 100 (high): threshold × 0.5 (easier to trigger)

```javascript
function getAdjustedThreshold(baseThreshold, sensitivity) {
  const multiplier = 1.5 - (sensitivity / 100);
  return baseThreshold * multiplier;
}
```

## Method 2: OpenCV Canny Edge Detection

### Setup

```javascript
let cvReady = false;

function onOpenCVReady() {
  cvReady = true;
  console.log('OpenCV.js loaded');
}
```

### Algorithm

1. Capture current frame to a canvas
2. Create OpenCV Mat from canvas image data
3. Convert to grayscale
4. Apply Gaussian blur (reduce noise)
5. Run Canny edge detection
6. Sample edge map at each note position along scan line
7. If edge pixels found in sampling region → object boundary detected

```javascript
function detectEdgesAtPositions(canvas, notePositions, scanX) {
  if (!cvReady) return null;

  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 1.5);
  cv.Canny(blurred, edges, 50, 150);

  const results = [];
  const sampleWidth = 15;
  const sampleHeight = 10;

  for (const pos of notePositions) {
    const y = Math.round(pos.y);
    const x = Math.round(scanX);
    let edgeCount = 0;
    let totalPixels = 0;

    for (let dy = -sampleHeight; dy <= sampleHeight; dy++) {
      for (let dx = -sampleWidth; dx <= sampleWidth; dx++) {
        const py = y + dy;
        const px = x + dx;
        if (py >= 0 && py < edges.rows && px >= 0 && px < edges.cols) {
          totalPixels++;
          if (edges.ucharAt(py, px) > 0) {
            edgeCount++;
          }
        }
      }
    }
    results.push(edgeCount / totalPixels > 0.05); // >5% edge pixels = object
  }

  src.delete(); gray.delete(); blurred.delete(); edges.delete();
  return results;
}
```

### Performance Optimization for LIVE Mode

- Downscale frame before processing: resize to 320×240 max for edge detection
- Cache edge map for 2-3 frames (don't recompute every frame)
- Scale note positions proportionally when using downscaled frame

```javascript
function downscaleForDetection(sourceCanvas, maxWidth = 320) {
  const scale = Math.min(1, maxWidth / sourceCanvas.width);
  const w = Math.round(sourceCanvas.width * scale);
  const h = Math.round(sourceCanvas.height * scale);
  
  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  
  return { canvas: offscreen, scale };
}
```

## Combining Both Methods

```javascript
function detectObjects(canvas, notePositions, scanX, sensitivity) {
  // Method 1: Brightness (always available)
  const brightnessResults = detectBrightnessAtPositions(canvas, notePositions, scanX, sensitivity);
  
  // Method 2: Edge detection (if OpenCV loaded)
  const edgeResults = cvReady 
    ? detectEdgesAtPositions(canvas, notePositions, scanX) 
    : null;
  
  // Combine: object detected if EITHER method detects it
  // This gives us broad coverage (brightness catches large objects,
  // edges catch fine details and boundaries)
  return notePositions.map((pos, i) => {
    const byBrightness = brightnessResults[i];
    const byEdge = edgeResults ? edgeResults[i] : false;
    return {
      detected: byBrightness || byEdge,
      confidence: (byBrightness ? 0.5 : 0) + (byEdge ? 0.5 : 0),
      position: pos,
    };
  });
}
```

## Debouncing / Note Triggering

Each note position has a cooldown to prevent the same note from firing repeatedly:

```javascript
const noteCooldowns = {}; // noteId → timestamp of last trigger

function shouldTriggerNote(noteId, now, cooldownMs = 200) {
  const lastTrigger = noteCooldowns[noteId] || 0;
  if (now - lastTrigger < cooldownMs) return false;
  noteCooldowns[noteId] = now;
  return true;
}
```
