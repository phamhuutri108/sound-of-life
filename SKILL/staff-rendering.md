# Staff Rendering — Sound of Life

## Canvas Setup

The staff is drawn on a transparent canvas that overlays the camera feed / captured photo.

```javascript
function setupOverlayCanvas(videoElement) {
  const canvas = document.getElementById('staffCanvas');
  
  // Match canvas to video display size
  const updateSize = () => {
    const rect = videoElement.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    
    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  };
  
  const observer = new ResizeObserver(updateSize);
  observer.observe(videoElement);
  updateSize();
  
  return canvas;
}
```

## Staff Layout

### Dimensions

```
Canvas
┌─────────────────────────────────────────────┐
│  margin top (15% of height)                 │
│  ─────────────── line 5 (top)     ← E5     │
│                   space           ← D5      │
│  ─────────────── line 4           ← C5      │ 
│                   space           ← B4      │
│  ─────────────── line 3 (middle)  ← A4      │
│                   space           ← G4      │
│  ─────────────── line 2           ← F4      │
│                   space           ← E4      │
│  ─────────────── line 1 (bottom)  ← D4      │
│                                              │
│  Below staff: ledger positions               │
│  ─ ─ ─ ─ ─ ─  ledger line        ← C4      │
│                   space           ← B3      │
│  ─ ─ ─ ─ ─ ─  ledger line        ← A3      │
│                   space           ← G3      │
│                                   ← ...     │
│  margin bottom (15% of height)              │
└─────────────────────────────────────────────┘
```

### Position Calculation

13 positions total, evenly spaced vertically within the staff region:

```javascript
function calculateStaffPositions(canvasWidth, canvasHeight) {
  const displayWidth = canvasWidth / window.devicePixelRatio;
  const displayHeight = canvasHeight / window.devicePixelRatio;
  
  const marginTop = displayHeight * 0.12;
  const marginBottom = displayHeight * 0.12;
  const staffTop = marginTop;
  const staffBottom = displayHeight - marginBottom;
  const staffHeight = staffBottom - staffTop;
  
  const positionCount = 13;
  const spacing = staffHeight / (positionCount - 1);
  
  const positions = [];
  for (let i = 0; i < positionCount; i++) {
    // i=0 is lowest note (bottom), i=12 is highest (top)
    positions.push({
      index: i,
      y: staffBottom - i * spacing,
      // Lines at positions corresponding to standard staff lines
      // Standard staff: lines at positions 2, 4, 6, 8, 10 (from bottom)
      // (adjustable based on layout preference)
      isLine: [2, 4, 6, 8, 10].includes(i),
      isLedger: [0].includes(i), // middle C ledger line
    });
  }
  
  return {
    positions,
    spacing,
    staffTop,
    staffBottom,
    staffLeft: displayWidth * 0.12, // room for treble clef
    staffRight: displayWidth * 0.95,
    displayWidth,
    displayHeight,
  };
}
```

## Drawing Functions

### Draw Staff Lines

```javascript
function drawStaffLines(ctx, staffData) {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1.5;
  
  staffData.positions.forEach(pos => {
    if (pos.isLine) {
      ctx.beginPath();
      ctx.moveTo(staffData.staffLeft, pos.y);
      ctx.lineTo(staffData.staffRight, pos.y);
      ctx.stroke();
    }
    if (pos.isLedger) {
      // Ledger lines are shorter (only as wide as the note)
      const cx = staffData.displayWidth / 2;
      const ledgerHalf = staffData.spacing * 1.5;
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.moveTo(cx - ledgerHalf, pos.y);
      ctx.lineTo(cx + ledgerHalf, pos.y);
      ctx.stroke();
    }
  });
}
```

### Draw Treble Clef

Use an SVG path or Unicode character. For simplicity, use the Unicode treble clef:

```javascript
function drawTrebleClef(ctx, staffData) {
  const clefX = staffData.staffLeft - 5;
  // Position the clef centered on the staff
  const clefY = (staffData.staffTop + staffData.staffBottom) / 2;
  const clefSize = (staffData.staffBottom - staffData.staffTop) * 0.9;
  
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = `${clefSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('𝄞', clefX, clefY);
}
```

Alternatively, draw the treble clef as an SVG path for better control. A simplified treble clef path:

```javascript
function drawTrebleClefPath(ctx, x, y, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.beginPath();
  // Simplified treble clef bezier path
  // (Use a pre-defined path data — complex but renders beautifully)
  // ... bezier curves ...
  ctx.fill();
  ctx.restore();
}
```

### Draw Scan Line

```javascript
function drawScanLine(ctx, scanX, staffData) {
  const gradient = ctx.createLinearGradient(scanX - 3, 0, scanX + 3, 0);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
  gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.4)');
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.9)');
  gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.4)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  
  ctx.fillStyle = gradient;
  ctx.fillRect(scanX - 6, 0, 12, staffData.displayHeight);
}
```

### Draw Note Indicators

When an object is detected at a note position, draw a glowing circle:

```javascript
function drawNoteIndicator(ctx, x, y, active, confidence = 1) {
  if (!active) {
    // Passive indicator: small subtle dot
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  
  // Active indicator: glowing note
  const alpha = 0.5 + confidence * 0.5;
  
  // Outer glow
  const glowGrad = ctx.createRadialGradient(x, y, 0, x, y, 20);
  glowGrad.addColorStop(0, `rgba(212, 165, 116, ${alpha})`);  // warm gold
  glowGrad.addColorStop(0.5, `rgba(212, 165, 116, ${alpha * 0.4})`);
  glowGrad.addColorStop(1, 'rgba(212, 165, 116, 0)');
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.arc(x, y, 20, 0, Math.PI * 2);
  ctx.fill();
  
  // Inner solid note
  ctx.fillStyle = `rgba(255, 240, 220, ${alpha})`;
  ctx.beginPath();
  // Draw as filled ellipse (music note shape)
  ctx.ellipse(x, y, 8, 6, -0.3, 0, Math.PI * 2);
  ctx.fill();
}
```

## Full Render Loop

```javascript
function renderStaff(ctx, staffData, scanX, detectionResults) {
  // Clear canvas
  ctx.clearRect(0, 0, staffData.displayWidth, staffData.displayHeight);
  
  // Draw staff lines
  drawStaffLines(ctx, staffData);
  
  // Draw treble clef
  drawTrebleClef(ctx, staffData);
  
  // Draw scan line
  if (scanX >= staffData.staffLeft && scanX <= staffData.staffRight) {
    drawScanLine(ctx, scanX, staffData);
  }
  
  // Draw note indicators at scan line intersection
  if (detectionResults) {
    staffData.positions.forEach((pos, i) => {
      const result = detectionResults[i];
      drawNoteIndicator(ctx, scanX, pos.y, result?.detected, result?.confidence);
    });
  }
}
```

## Scan Line Animation

```javascript
let scanX = 0;
let scanSpeed = 2; // pixels per frame at 60fps

// Speed control: user slider maps 1-5 to actual px/frame
function setScanSpeed(sliderValue) {
  // sliderValue: 1 (slow) to 5 (fast)
  scanSpeed = sliderValue * 0.8 + 0.5;
}

function animateScanLine(staffData) {
  scanX += scanSpeed;
  
  // Loop back to start
  if (scanX > staffData.staffRight) {
    scanX = staffData.staffLeft;
    // Reset note cooldowns on new sweep
    Object.keys(noteCooldowns).forEach(k => delete noteCooldowns[k]);
  }
  
  return scanX;
}
```
