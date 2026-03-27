// Staff canvas rendering

const canvas = document.getElementById('staffCanvas');
const ctx = canvas.getContext('2d');

export { canvas, ctx };

export function resizeCanvas() {
  const rect = document.getElementById('cameraView').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width  = rect.width  + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return calculateStaffPositions(canvas.width, canvas.height);
}

export function calculateStaffPositions(canvasW, canvasH) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvasW / dpr;
  const H = canvasH / dpr;
  const marginTop    = H * 0.12;
  const marginBottom = H * 0.12;
  const staffTop     = marginTop;
  const staffBottom  = H - marginBottom;
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
    staffLeft:  W * 0.12,
    staffRight: W * 0.97,
    displayWidth: W,
    displayHeight: H,
  };
}

export function drawStaffLines(sd) {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  sd.positions.forEach(pos => {
    if (pos.isLine) {
      ctx.beginPath();
      ctx.moveTo(sd.staffLeft, pos.y);
      ctx.lineTo(sd.staffRight, pos.y);
      ctx.stroke();
    }
    if (pos.isLedger) {
      const cx  = sd.displayWidth / 2;
      const hw  = sd.spacing * 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(cx - hw, pos.y);
      ctx.lineTo(cx + hw, pos.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    }
  });
}

export function drawTrebleClef(sd) {
  const clefX = sd.staffLeft - 4;
  const clefY = (sd.staffTop + sd.staffBottom) / 2;
  const clefSize = (sd.staffBottom - sd.staffTop) * 1.0;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = `${clefSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u{1D11E}', clefX, clefY);
}

export function drawScanLine(scanX, sd) {
  const g = ctx.createLinearGradient(scanX - 6, 0, scanX + 6, 0);
  g.addColorStop(0,   'rgba(255,255,255,0)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.4)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.4)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(scanX - 6, 0, 12, sd.displayHeight);
}

export function drawNoteIndicator(x, y, active, confidence = 1) {
  if (!active) {
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const alpha = 0.5 + confidence * 0.5;
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 22);
  glow.addColorStop(0,   `rgba(212,165,116,${alpha})`);
  glow.addColorStop(0.5, `rgba(212,165,116,${alpha * 0.4})`);
  glow.addColorStop(1,   'rgba(212,165,116,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255,240,220,${alpha})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 8, 6, -0.3, 0, Math.PI * 2);
  ctx.fill();
}

export function renderStaff(scanX, detectionResults, staffData, isPlaying) {
  if (!staffData) return;
  const sd = staffData;
  ctx.clearRect(0, 0, sd.displayWidth, sd.displayHeight);
  drawStaffLines(sd);
  drawTrebleClef(sd);
  if (isPlaying && scanX >= sd.staffLeft && scanX <= sd.staffRight) {
    drawScanLine(scanX, sd);
  }
  if (detectionResults) {
    sd.positions.forEach((pos, i) => {
      const r = detectionResults[i];
      drawNoteIndicator(scanX, pos.y, r?.detected, r?.confidence);
    });
  } else {
    // draw passive indicators
    sd.positions.forEach(pos => {
      drawNoteIndicator(scanX, pos.y, false, 0);
    });
  }
}
