// Staff canvas rendering

const canvas = document.getElementById('staffCanvas');
const ctx = canvas.getContext('2d');

export { canvas, ctx };

// Overlay visibility flags (toggled via settings)
export let showClef = false;
export let showGrid = false;

export function setShowClef(v) { showClef = v; }
export function setShowGrid(v) { showGrid = v; }

export function resizeCanvas(bounds) {
  const rect = document.getElementById('cameraView').getBoundingClientRect();
  // Cap DPR at 2 — DPR-3 screens fill 9× the pixels for ~0 visible improvement
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width  = rect.width  + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return calculateStaffPositions(canvas.width, canvas.height, bounds);
}

export function calculateStaffPositions(canvasW, canvasH, bounds) {
  // Must match the capped DPR used in resizeCanvas
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvasW / dpr;
  const H = canvasH / dpr;
  // When a photo is letterboxed, constrain staff to the photo's actual display area
  const bx = bounds ? bounds.x : 0;
  const by = bounds ? bounds.y : 0;
  const bw = bounds ? bounds.w : W;
  const bh = bounds ? bounds.h : H;
  const marginTop    = bh * 0.12;
  const marginBottom = bh * 0.12;
  const staffTop     = by + marginTop;
  const staffBottom  = by + bh - marginBottom;
  const staffHeight  = staffBottom - staffTop;
  const N = 13;
  const spacing = staffHeight / (N - 1);
  const positions = [];
  for (let i = 0; i < N; i++) {
    positions.push({
      index: i,
      y: staffBottom - i * spacing,
      isLine:   [2, 4, 6, 8, 10].includes(i),
      isLedger: i === 0,
    });
  }
  return {
    positions, spacing,
    staffTop, staffBottom,
    staffLeft:  bx + bw * 0.16,
    staffRight: bx + bw * 0.95,
    displayWidth: W,
    displayHeight: H,
  };
}

export function drawStaffLines(sd, c = ctx) {
  c.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  c.lineWidth = 1.5;
  c.setLineDash([]);
  sd.positions.forEach(pos => {
    if (pos.isLine) {
      c.beginPath();
      c.moveTo(sd.staffLeft, pos.y);
      c.lineTo(sd.staffRight, pos.y);
      c.stroke();
    }
    if (pos.isLedger) {
      const cx  = sd.displayWidth / 2;
      const hw  = sd.spacing * 2;
      c.strokeStyle = 'rgba(255,255,255,0.21)';
      c.setLineDash([4, 3]);
      c.beginPath();
      c.moveTo(cx - hw, pos.y);
      c.lineTo(cx + hw, pos.y);
      c.stroke();
      c.setLineDash([]);
      c.strokeStyle = 'rgba(255, 255, 255, 0.38)';
    }
  });
}

export function drawTrebleClef(sd, c = ctx) {
  // Size the clef to match the 5-staff-lines span (indices 2–10 = 8/12 of staffHeight).
  // No margin cap — the clef is allowed to partially clip the left canvas edge.
  const staffSpan = sd.staffBottom - sd.staffTop;
  const clefSize = Math.min(staffSpan * (8 / 12), 480);
  const clefX = Math.max(clefSize * 0.28, sd.staffLeft * 0.55);
  const clefY = (sd.staffTop + sd.staffBottom) / 2;
  c.fillStyle = 'rgba(255, 255, 255, 0.55)';
  c.font = `${clefSize}px serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('\u{1D11E}', clefX, clefY);
}

export function drawScanLine(scanX, sd) {
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(scanX - 7, 0, 14, sd.displayHeight);
  ctx.fillStyle = 'rgba(255,255,255,0.40)';
  ctx.fillRect(scanX - 3, 0, 6, sd.displayHeight);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(scanX - 1, 0, 2, sd.displayHeight);
}

// Only called for ACTIVE notes; passive dots are batched in renderStaff
function drawNoteIndicator(x, y, confidence = 1) {
  const alpha = 0.5 + confidence * 0.5;
  // Outer glow
  ctx.fillStyle = `rgba(255,255,255,${(alpha * 0.22).toFixed(2)})`;
  ctx.beginPath();
  ctx.arc(x, y, 22, 0, Math.PI * 2);
  ctx.fill();
  // Note head ellipse
  ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 8, 6, -0.3, 0, Math.PI * 2);
  ctx.fill();
}

export function drawGrid(sd) {
  const cols = 8;
  const rows = 12;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  // horizontal lines
  for (let r = 0; r <= rows; r++) {
    const y = (sd.displayHeight / rows) * r;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(sd.displayWidth, y);
    ctx.stroke();
  }
  // vertical lines
  for (let c = 0; c <= cols; c++) {
    const x = (sd.displayWidth / cols) * c;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, sd.displayHeight);
    ctx.stroke();
  }
}

// ─── Static background cache ──────────────────────────────────────────────
// Staff lines + clef never change between frames — render once per config,
// then blit with a single ctx.drawImage() (one GPU copy, near zero cost).
let _bgCanvas = null;
let _bgKey = '';

function _ensureBg(sd) {
  // Must match the capped DPR used in resizeCanvas — do NOT use raw devicePixelRatio here
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const key = `${canvas.width}|${canvas.height}|${+showGrid}|${+showClef}|${sd.staffTop.toFixed(0)}|${sd.staffBottom.toFixed(0)}|${sd.staffLeft.toFixed(0)}`;
  if (_bgKey === key && _bgCanvas) return _bgCanvas;
  if (!_bgCanvas) _bgCanvas = document.createElement('canvas');
  _bgCanvas.width  = canvas.width;
  _bgCanvas.height = canvas.height;
  const bc = _bgCanvas.getContext('2d');
  bc.setTransform(dpr, 0, 0, dpr, 0, 0);
  bc.clearRect(0, 0, sd.displayWidth, sd.displayHeight);
  // Clip to display bounds so nothing bleeds off-screen
  bc.save();
  bc.beginPath();
  bc.rect(0, 0, sd.displayWidth, sd.displayHeight);
  bc.clip();
  if (showGrid) drawStaffLines(sd, bc);
  if (showClef) drawTrebleClef(sd, bc);
  bc.restore();
  _bgKey = key;
  return _bgCanvas;
}

/** Call when showGrid / showClef toggle so background is redrawn next frame. */
export function markBgDirty() { _bgKey = ''; }

export function renderStaff(scanX, detectionResults, staffData, isPlaying) {
  if (!staffData) return;
  const sd = staffData;
  ctx.clearRect(0, 0, sd.displayWidth, sd.displayHeight);

  // Blit cached static background at 1:1 physical pixels.
  // The bg canvas is already at full physical resolution; bypass ctx's DPR
  // transform so it isn't scaled again (which would overflow the canvas).
  const bgCanvas = _ensureBg(sd);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgCanvas, 0, 0);
  ctx.restore();

  if (isPlaying && scanX >= sd.staffLeft && scanX <= sd.staffRight) {
    drawScanLine(scanX, sd);
  }

  // Active note indicators
  if (detectionResults) {
    for (const r of detectionResults) {
      if (r.detected && r.y !== undefined) {
        drawNoteIndicator(scanX, r.y, r.confidence);
      }
    }
  }
}
