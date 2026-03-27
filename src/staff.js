// Staff canvas rendering

const canvas = document.getElementById('staffCanvas');
const ctx = canvas.getContext('2d');

export { canvas, ctx };

// Overlay visibility flags (toggled via settings)
export let showClef = false;
export let showGrid = true;

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
  c.strokeStyle = 'rgba(255, 255, 255, 0.55)';
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
      c.strokeStyle = 'rgba(255,255,255,0.3)';
      c.setLineDash([4, 3]);
      c.beginPath();
      c.moveTo(cx - hw, pos.y);
      c.lineTo(cx + hw, pos.y);
      c.stroke();
      c.setLineDash([]);
      c.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    }
  });
}

export function drawTrebleClef(sd, c = ctx) {
  // Cap font size: treble clef must fit within the left margin (staffLeft from canvas edge)
  // textAlign=center means half the char width extends left of clefX
  // Empirically the 𝄞 glyph is ~0.4× font-size wide, so maxSize = staffLeft / 0.5 * 0.8
  const maxByMargin = sd.staffLeft * 1.4;
  const maxByHeight = (sd.staffBottom - sd.staffTop) * 0.65;
  const clefSize = Math.min(maxByMargin, maxByHeight, 160);
  const clefX = sd.staffLeft - clefSize * 0.18;
  const clefY = (sd.staffTop + sd.staffBottom) / 2;
  c.fillStyle = 'rgba(255, 255, 255, 0.78)';
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
  const dpr = window.devicePixelRatio || 1;
  const key = `${canvas.width}|${canvas.height}|${+showGrid}|${+showClef}|${sd.staffTop.toFixed(0)}|${sd.staffBottom.toFixed(0)}`;
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

  // Blit cached static background (one GPU drawImage — essentially free)
  ctx.drawImage(_ensureBg(sd), 0, 0);

  if (isPlaying && scanX >= sd.staffLeft && scanX <= sd.staffRight) {
    drawScanLine(scanX, sd);
  }

  // All 13 passive dots in one batched path → single fill() call
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  for (const pos of sd.positions) {
    ctx.moveTo(scanX + 3.5, pos.y);
    ctx.arc(scanX, pos.y, 3.5, 0, Math.PI * 2);
  }
  ctx.fill();

  // Active note indicators
  if (detectionResults) {
    for (const r of detectionResults) {
      if (r.detected && r.y !== undefined) {
        drawNoteIndicator(scanX, r.y, r.confidence);
      }
    }
  }
}
