import './style.css';

import { t, setLanguage } from './i18n.js';
import {
  initAudio, tryUnlockAudio,
  setInstrument, setScale,
  playNote, getNoteForPosition, confidenceToVelocity,
  releaseAllInstruments,
  isAudioReady,
} from './audio.js';
import {
  startCamera, flipCamera as _flipCamera, setCameraFacing as _setCameraFacing,
  capturePhoto as _capturePhoto, retakePhoto, importPhoto as _importPhoto,
  cameraFacing as _cameraFacing, currentStream,
} from './camera.js';
import {
  ctx, canvas as staffCanvas,
  resizeCanvas,
  renderStaff,
  setShowClef, setShowGrid,
  showClef, showGrid,
} from './staff.js';
import {
  cvReady,
  noteCooldowns, shouldTriggerNote,
  detectObjects as _detectObjects,
} from './detection.js';
import { loadSmartModel, isSmartReady, drawDetections, getSmartBackend } from './smartDetection.js';

/* ═══════════════════════════════════════════════════════════════
   APP STATE
═══════════════════════════════════════════════════════════════ */
let appMode = 'photo'; // 'photo' | 'live'
let isPlaying = true;
let photoDataURL = null;
let photoImgEl = null;
let sensitivity = 70;
let staffData = null;

// A2HS state — must be declared before wireUI() runs
let _deferredInstallPrompt = null;
let _a2hsPlatform = null;
const SHARE_SVG = `<svg class="a2hs-share-svg" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6.5" y1="1" x2="6.5" y2="8.5"/><polyline points="4,3.5 6.5,1 9,3.5"/><path d="M2 6.5v4a1 1 0 001 1h7a1 1 0 001-1v-4"/></svg>`;

/**
 * Compute the actual pixel bounds of a photo rendered with `background-size: contain`
 * inside #cameraView. Returns { x, y, w, h } in CSS pixels, or null if unavailable.
 */
function computePhotoBounds(imgEl) {
  if (!imgEl) return null;
  const iw = imgEl.naturalWidth  || imgEl.width;
  const ih = imgEl.naturalHeight || imgEl.height;
  if (!iw || !ih) return null;
  const rect = document.getElementById('cameraView').getBoundingClientRect();
  const cw = rect.width, ch = rect.height;
  const scale = Math.min(cw / iw, ch / ih);
  const dw = iw * scale, dh = ih * scale;
  return { x: (cw - dw) / 2, y: (ch - dh) / 2, w: dw, h: dh };
}

/** Recalculate staffData for the current photo, constraining staff to the photo area. */
function applyPhotoBounds() {
  const bounds = computePhotoBounds(photoImgEl);
  staffData = resizeCanvas(bounds);
  if (staffData) scanX = staffData.staffLeft;
}

/* ═══════════════════════════════════════════════════════════════
   SCAN LINE STATE
═══════════════════════════════════════════════════════════════ */
let scanX = 0;
let scanSpeed = 1.6; // px/frame at 60fps

function setScanSpeed(val) {
  scanSpeed = parseFloat(val) * 0.8 + 0.5;
}

function advanceScanLine() {
  if (!staffData) return scanX;
  scanX += scanSpeed;
  if (scanX > staffData.staffRight) {
    scanX = staffData.staffLeft;
    Object.keys(noteCooldowns).forEach(k => delete noteCooldowns[k]);
  }
  return scanX;
}

/* ═══════════════════════════════════════════════════════════════
   PLAY / PAUSE
═══════════════════════════════════════════════════════════════ */
function togglePlay() {
  isPlaying = !isPlaying;
  document.getElementById('iconPause').style.display = isPlaying ? '' : 'none';
  document.getElementById('iconPlay').style.display  = isPlaying ? 'none' : '';
  updatePlayBtnLabel();
  document.getElementById('playBtn').classList.toggle('active', isPlaying);
  if (!isPlaying) {
    releaseAllInstruments();
  }
}

function updatePlayBtnLabel() {
  const playTxt = document.getElementById('txt-play');
  if (playTxt) {
    playTxt.textContent = isPlaying ? t('pause') : t('play');
  }
}

/* ═══════════════════════════════════════════════════════════════
   MODE SWITCHING
═══════════════════════════════════════════════════════════════ */
function applyMode(mode) {
  appMode = mode;
  const badge = document.getElementById('modeBadge');

  const isPhoto = mode === 'photo';
  badge.textContent = t(isPhoto ? 'photo-mode' : 'live-mode');
  document.getElementById('captureBtn').style.display = isPhoto ? '' : 'none';
  document.getElementById('galleryBtn').style.display = isPhoto ? '' : 'none';
  retakePhoto();
  photoDataURL = null;
  photoImgEl = null;

  // Reset detection cooldowns
  Object.keys(noteCooldowns).forEach(k => delete noteCooldowns[k]);
}

function switchMode() {
  const newMode = appMode === 'photo' ? 'live' : 'photo';
  applyMode(newMode);
}

function goHome() {
  // Stop playback and release audio
  if (isPlaying) {
    isPlaying = false;
    releaseAllInstruments();
  }
  // Reset photo state
  doRetakePhoto();
  applyZoom(1);

  // Hide camera UI
  document.getElementById('topBar').style.display = 'none';
  document.getElementById('bottomToolbar').style.display = 'none';
  document.getElementById('zoomControls').style.display = 'none';
  document.getElementById('saveBtn').style.display = 'none';
  document.getElementById('cameraView').classList.remove('active');

  // Show splash (home with mode cards)
  document.getElementById('splash').classList.remove('hidden');
}

async function selectMode(mode) {
  initAudio(); // sync within user gesture — do NOT await
  loadSmartModel(); // fire-and-forget; detection falls back until ready
  document.getElementById('splash').classList.add('hidden');
  document.getElementById('cameraView').classList.add('active');
  document.getElementById('topBar').style.display = '';
  document.getElementById('bottomToolbar').style.display = '';
  document.getElementById('zoomControls').style.display = '';
  document.getElementById('zoomControls').style.opacity = '1';
  applyMode(mode);
  await startCamera(_cameraFacing);
  initCameraZoom();
  staffData = resizeCanvas();
  if (staffData) scanX = staffData.staffLeft;
  startAnimationLoop();

  // Show opencv status briefly if not ready yet; auto-hide after 4s
  if (!cvReady) {
    const el = document.getElementById('opencvStatus');
    el.style.display = '';
    el.classList.remove('loaded');
    setTimeout(() => el.classList.add('loaded'), 4000);
  }
}

/* ═══════════════════════════════════════════════════════════════
   PHOTO CAPTURE
═══════════════════════════════════════════════════════════════ */
function capturePhoto() {
  const result = _capturePhoto({ staffData, noteCooldowns, t });
  if (result) {
    photoDataURL = result.photoDataURL;
    photoImgEl = result.photoImgEl;
    // Show save button
    document.getElementById('saveBtn').style.display = '';
    // Wait for image to decode before computing bounds (may already be complete for data URLs)
    if (photoImgEl.complete && photoImgEl.naturalWidth) {
      applyPhotoBounds();
    } else {
      photoImgEl.onload = applyPhotoBounds;
    }
  }
}

async function savePhoto() {
  if (!photoDataURL) return;
  const filename = `sound-of-life-${Date.now()}.jpg`;

  // If any overlay is visible, composite photo + staff canvas at display resolution.
  // Otherwise save pure photo at full camera resolution.
  let dataURL = photoDataURL;

  if ((showClef || showGrid) && staffData && photoImgEl) {
    const W = staffData.displayWidth;
    const H = staffData.displayHeight;
    const tmp = document.createElement('canvas');
    tmp.width  = W;
    tmp.height = H;
    const tc = tmp.getContext('2d');
    // Draw photo with contain fit (matches CSS background-size:contain)
    const iw = photoImgEl.naturalWidth  || photoImgEl.width;
    const ih = photoImgEl.naturalHeight || photoImgEl.height;
    const scale = Math.min(W / iw, H / ih);
    const dw = iw * scale, dh = ih * scale;
    tc.drawImage(photoImgEl, (W - dw) / 2, (H - dh) / 2, dw, dh);
    // Overlay staff canvas
    tc.drawImage(staffCanvas, 0, 0, W, H);
    dataURL = tmp.toDataURL('image/jpeg', 0.92);
  }

  // iOS Safari: Web Share API with File
  if (navigator.canShare) {
    try {
      const res  = await fetch(dataURL);
      const blob = await res.blob();
      const file = new File([blob], filename, { type: 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Sound of Life' });
        return;
      }
    } catch (_) { /* fall through */ }
  }
  // Fallback: <a download>
  const a = document.createElement('a');
  a.href     = dataURL;
  a.download = filename;
  a.click();
}

function doRetakePhoto() {
  retakePhoto();
  photoDataURL = null;
  photoImgEl = null;
  document.getElementById('saveBtn').style.display = 'none';
  // Restore full-canvas staff (no letterbox)
  staffData = resizeCanvas();
  if (staffData) scanX = staffData.staffLeft;
}

function onImportPhoto() {
  _importPhoto({
    staffData,
    noteCooldowns,
    t,
    onResult: (result) => {
      photoDataURL = result.photoDataURL;
      photoImgEl = result.photoImgEl;
      document.getElementById('saveBtn').style.display = '';
      if (photoImgEl.complete && photoImgEl.naturalWidth) {
        applyPhotoBounds();
      } else {
        photoImgEl.onload = applyPhotoBounds;
      }
    },
  });
}

function onCapture() {
  if (appMode === 'photo') {
    if (photoDataURL) {
      doRetakePhoto();
    } else {
      capturePhoto();
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS PANEL
═══════════════════════════════════════════════════════════════ */
function openSettings() {
  document.getElementById('settingsPanel').classList.add('open');
  document.getElementById('settingsBackdrop').classList.add('open');
}

function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('open');
  document.getElementById('settingsBackdrop').classList.remove('open');
}

/* ═══════════════════════════════════════════════════════════════
   CAMERA WRAPPERS (pass state context)
═══════════════════════════════════════════════════════════════ */
function flipCamera() {
  _flipCamera({ appMode, photoDataURL });
}

function setCameraFacing(facing) {
  _setCameraFacing(facing, { appMode, photoDataURL, closeSettings });
}

/* ═══════════════════════════════════════════════════════════════
   MAIN ANIMATION LOOP
═══════════════════════════════════════════════════════════════ */
let lastDetectionTime = 0;
let lastDetectionResults = null;
const isHighEndIPhone = /iPhone/i.test(navigator.userAgent || '')
  && (navigator.hardwareConcurrency || 4) >= 6
  && (window.devicePixelRatio || 1) >= 3;
const BASE_DETECTION_INTERVAL = isHighEndIPhone ? 120 : 180;
const MAX_NOTES_PER_PASS = isHighEndIPhone ? 3 : 2;

function animationLoop(now) {
  requestAnimationFrame(animationLoop);

  if (!staffData || !isPlaying) {
    // Still render staff (without scan line movement), respecting showClef/showGrid flags
    if (staffData) {
      renderStaff(scanX, null, staffData, false);
    }
    return;
  }

  // Advance scan
  const curScanX = advanceScanLine();

  // Detection (throttled)
  const activeBackend = getSmartBackend();
  const activeInterval = activeBackend === 'yolo' ? BASE_DETECTION_INTERVAL : (BASE_DETECTION_INTERVAL + 40);
  if (now - lastDetectionTime > activeInterval) {
    lastDetectionTime = now;

    // Only detect when we have a source
    const video = document.getElementById('cameraVideo');
    const hasSource = (appMode === 'photo' && photoDataURL) || (appMode === 'live' && video.readyState >= 2);
    if (hasSource) {
      lastDetectionResults = _detectObjects({
        appMode,
        photoDataURL,
        photoImgEl,
        staffData,
        scanX: curScanX,
        sensitivity,
      });

      // Trigger notes from edge transitions
      if (lastDetectionResults && isAudioReady()) {
        let fired = 0;
        for (const result of lastDetectionResults) {
          if (fired >= MAX_NOTES_PER_PASS) break;
          if (!result.detected) continue;

          // Use noteIndex (from Y position) instead of fixed index
          const noteIdx = result.noteIndex !== undefined ? result.noteIndex : 0;
          const yBin = Math.round((result.y || 0) / 12);
          const noteId = `note_lane_${noteIdx}_ybin_${yBin}`;

          if (shouldTriggerNote(noteId, now, 250)) {
            playNote(getNoteForPosition(noteIdx), confidenceToVelocity(result.confidence));
            fired++;
          }
        }
      }
    }
  }

  renderStaff(curScanX, lastDetectionResults, staffData, isPlaying);
  if (isSmartReady()) drawDetections(ctx, staffData);
}

let loopStarted = false;
function startAnimationLoop() {
  if (loopStarted) return;
  loopStarted = true;
  requestAnimationFrame(animationLoop);
}


/* ═══════════════════════════════════════════════════════════════
   ZOOM — real camera zoom (applyConstraints) with CSS scale fallback
═══════════════════════════════════════════════════════════════ */
const ZOOM_MIN = 0.5;
const ZOOM_MAX_DEFAULT = 5;
let currentZoom = 1;
let zoomMax = ZOOM_MAX_DEFAULT;

// Hardware zoom state
let zoomTrack  = null; // MediaStreamTrack with zoom capability
let zoomHwMin  = 1;
let zoomHwMax  = ZOOM_MAX_DEFAULT;


function initCameraZoom() {
  zoomTrack = null;
  const stream = currentStream;
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  if (caps.zoom) {
    zoomTrack = track;
    zoomHwMin = caps.zoom.min ?? 1;
    zoomHwMax = caps.zoom.max ?? ZOOM_MAX_DEFAULT;
    zoomMax   = zoomHwMax;
  } else {
    zoomMax = ZOOM_MAX_DEFAULT;
  }
  // Reset to 1× on new camera
  currentZoom = 1;
  document.getElementById('zoomContainer').style.transform = '';
  updateZoomPill();
}

function applyZoom(z) {
  currentZoom = Math.min(zoomMax, Math.max(ZOOM_MIN, z));

  if (zoomTrack) {
    const hwZ = Math.min(zoomHwMax, Math.max(zoomHwMin, currentZoom));
    zoomTrack.applyConstraints({ advanced: [{ zoom: hwZ }] }).catch(() => {
      _applyCSSZoom(currentZoom);
    });
    // Below hardware min (e.g. 0.5× on camera that starts at 1×) → CSS scale
    if (currentZoom < zoomHwMin) {
      _applyCSSZoom(currentZoom);
    } else {
      document.getElementById('zoomContainer').style.transform = '';
    }
  } else {
    _applyCSSZoom(currentZoom);
  }

  updateZoomPill();
  bumpZoomPillVisible();
}

function _applyCSSZoom(z) {
  document.getElementById('zoomContainer').style.transform =
    Math.abs(z - 1) < 0.001 ? '' : `scale(${z})`;
}

function bumpZoomPillVisible() {
  // Pill is always visible — nothing to do
}

function updateZoomPill() {
  const presetDefs = [
    { id: 'zoomBtn05', z: 0.5 },
    { id: 'zoomBtn1',  z: 1   },
    { id: 'zoomBtn2',  z: 2   },
    { id: 'zoomBtn3',  z: 3   },
  ];
  let activeIdx = 1; // default to 1×
  presetDefs.forEach(({ id, z }, i) => {
    const btn = document.getElementById(id);
    const isActive = Math.abs(currentZoom - z) < 0.15;
    btn.classList.toggle('active', isActive);
    if (isActive) activeIdx = i;
  });
  // Slide track so active button is centered in the 150px window
  // Each button step = 46px width + 6px gap = 52px
  // center of index i in track = i * 52 + 23; window center = 75
  // translateX = 75 - (activeIdx * 52 + 23) = 52 - activeIdx * 52
  const translateX = 52 - activeIdx * 52;
  document.getElementById('zoomTrack').style.transform = `translateX(${translateX}px)`;
}

/* ── Zoom dial (long-press rotary wheel) ── */
let dialActive   = false;
let dialTouchX   = 0;
let dialTouchZoom = 1;
let dialHideTimer = null;

const DIAL_PX_PER_LOG = 90; // px per natural-log unit — lower = more sensitive
const DIAL_PRESETS_HAPTIC = [0.5, 1, 2, 3, 4, 5];

function showZoomDial(startX) {
  clearTimeout(dialHideTimer);
  dialTouchX    = startX;
  dialTouchZoom = currentZoom;
  dialActive    = true;
  // Hide pill while dial is open
  document.getElementById('zoomControls').style.opacity = '0';
  document.getElementById('zoomControls').style.pointerEvents = 'none';
  const el = document.getElementById('zoomDialOverlay');
  el.style.display = '';
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    renderZoomDial();
  });
  if (navigator.vibrate) navigator.vibrate(10);
}

function hideZoomDial() {
  dialActive = false;
  const el = document.getElementById('zoomDialOverlay');
  el.style.opacity = '0';
  dialHideTimer = setTimeout(() => {
    el.style.display = 'none';
    // Restore pill after dial fades out
    document.getElementById('zoomControls').style.opacity = '1';
    document.getElementById('zoomControls').style.pointerEvents = '';
  }, 320);
}

function renderZoomDial() {
  const canvas = document.getElementById('zoomDialCanvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth;
  const H   = canvas.offsetHeight;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const dc = canvas.getContext('2d');
  dc.scale(dpr, dpr);
  dc.clearRect(0, 0, W, H);

  // Dark gradient background
  const bg = dc.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0,    'rgba(0,0,0,0)');
  bg.addColorStop(0.3,  'rgba(0,0,0,0.75)');
  bg.addColorStop(1,    'rgba(0,0,0,0.90)');
  dc.fillStyle = bg;
  dc.fillRect(0, 0, W, H);

  // Arc geometry — circle centered below canvas so only top arc is visible
  const cx = W / 2;
  const R  = Math.min(W * 0.52, 205);
  const cy = H + 22; // center below canvas; top of arc at cy-R ≈ 22px

  // Which presets are available given zoom range?
  const presets = [0.5, 1, 2, 3].filter(z => z >= ZOOM_MIN && z <= zoomMax + 0.5);

  const logMin = Math.log(ZOOM_MIN);
  const logMax = Math.log(Math.max(zoomMax, presets[presets.length - 1]));
  const logCur = Math.log(Math.max(ZOOM_MIN, currentZoom));
  // Fixed angular window: maps ±1.2 log units around current zoom to ±HALF_ARC
  // This keeps adjacent presets (0.5×↔1×↔2×) always near the visible edges
  const LOG_WINDOW = 2.4;
  const HALF_ARC   = Math.PI * 0.72;

  const logToAngle = (lz) =>
    -Math.PI / 2 + ((lz - logCur) / LOG_WINDOW) * HALF_ARC * 2;

  // Clip all arc drawing to canvas bounds so nodes near the edges clip cleanly
  dc.save();
  dc.beginPath();
  dc.rect(0, 0, W, H);
  dc.clip();

  // Arc track ring
  const aStart = logToAngle(logMin);
  const aEnd   = logToAngle(logMax);
  dc.beginPath();
  dc.arc(cx, cy, R, aStart, aEnd);
  dc.strokeStyle = 'rgba(255,255,255,0.18)';
  dc.lineWidth = 1.5;
  dc.stroke();

  // Fine tick marks
  const FINE_STEP = 0.1;
  for (let z = ZOOM_MIN; z <= zoomMax + 0.01; z = Math.round((z + FINE_STEP) * 10) / 10) {
    const lz    = Math.log(Math.max(0.01, z));
    const angle = logToAngle(lz);
    if (Math.abs(angle + Math.PI / 2) > HALF_ARC + 0.05) continue;
    const nearPreset = presets.some(p => Math.abs(z - p) < 0.18);
    if (nearPreset) continue;

    const isHalf = Math.abs((z * 2) % 1) < 0.01;
    const len    = isHalf ? 11 : 5;
    const ox = cx + R * Math.cos(angle);
    const oy = cy + R * Math.sin(angle);
    const ix = cx + (R - len) * Math.cos(angle);
    const iy = cy + (R - len) * Math.sin(angle);
    dc.beginPath();
    dc.moveTo(ox, oy);
    dc.lineTo(ix, iy);
    dc.strokeStyle = isHalf ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.22)';
    dc.lineWidth   = 1;
    dc.stroke();
  }

  // Preset nodes on the arc
  const NODE_R = 16;
  presets.forEach(z => {
    const lz    = Math.log(z);
    const angle = logToAngle(lz);
    const nx = cx + R * Math.cos(angle);
    const ny = cy + R * Math.sin(angle);
    // Skip if node center is well below canvas (not just clipped at edge)
    if (ny > H + NODE_R) return;
    const isActive = Math.abs(z - currentZoom) < 0.08;

    dc.beginPath();
    dc.arc(nx, ny, NODE_R, 0, Math.PI * 2);
    dc.fillStyle = isActive ? 'rgba(255,214,0,0.22)' : 'rgba(255,255,255,0.10)';
    dc.fill();
    dc.strokeStyle = isActive ? 'rgba(255,214,0,0.90)' : 'rgba(255,255,255,0.38)';
    dc.lineWidth = 1.5;
    dc.stroke();

    dc.font = `${isActive ? '700' : '500'} 12px Montserrat, sans-serif`;
    dc.fillStyle = isActive ? '#ffd600' : 'rgba(255,255,255,0.78)';
    dc.textAlign = 'center';
    dc.textBaseline = 'middle';
    dc.fillText(z + '×', nx, ny);
  });

  // ▼ pointer at arc top-center
  const topX = cx;
  const topY = cy - R - 2;
  dc.beginPath();
  dc.moveTo(topX,     topY + 13);
  dc.lineTo(topX - 7, topY + 2);
  dc.lineTo(topX + 7, topY + 2);
  dc.closePath();
  dc.fillStyle = '#ffd600';
  dc.fill();

  dc.restore();

  // Left + right edge fade so nodes clip smoothly (like iPhone)
  const FADE = 44;
  const fadeL = dc.createLinearGradient(0, 0, FADE, 0);
  fadeL.addColorStop(0, 'rgba(0,0,0,0.90)');
  fadeL.addColorStop(1, 'rgba(0,0,0,0)');
  dc.fillStyle = fadeL;
  dc.fillRect(0, 0, FADE, H);

  const fadeR = dc.createLinearGradient(W - FADE, 0, W, 0);
  fadeR.addColorStop(0, 'rgba(0,0,0,0)');
  fadeR.addColorStop(1, 'rgba(0,0,0,0.90)');
  dc.fillStyle = fadeR;
  dc.fillRect(W - FADE, 0, FADE, H);

  // Zoom value label
  document.getElementById('zoomDialValue').textContent = currentZoom.toFixed(1) + '×';
}

function dialDragUpdate(clientX) {
  const dx = clientX - dialTouchX;
  // LEFT drag = zoom in (higher values toward pointer), RIGHT = zoom out
  const newLogZ = Math.log(Math.max(ZOOM_MIN, dialTouchZoom)) - dx / DIAL_PX_PER_LOG;
  const prev = currentZoom;
  applyZoom(Math.exp(newLogZ));
  // Haptic pulse when crossing a preset threshold
  DIAL_PRESETS_HAPTIC.forEach(p => {
    const crossed = (prev < p && currentZoom >= p) || (prev > p && currentZoom <= p);
    if (crossed && navigator.vibrate) navigator.vibrate(6);
  });
  renderZoomDial();
}

function wireZoomDial() {
  const overlay = document.getElementById('zoomDialOverlay');

  overlay.addEventListener('touchmove', e => {
    if (!dialActive || e.touches.length !== 1) return;
    dialDragUpdate(e.touches[0].clientX);
  }, { passive: true });

  overlay.addEventListener('touchend', () => {
    clearTimeout(dialHideTimer);
    dialHideTimer = setTimeout(hideZoomDial, 1800);
  }, { passive: true });

  // iPhone-style: press-hold then drag without lifting finger
  document.querySelectorAll('.zoom-btn').forEach(btn => {
    let lpTimer  = null;
    let pressX   = 0;
    let pressY   = 0;
    let dragging = false;

    btn.addEventListener('touchstart', e => {
      pressX   = e.touches[0].clientX;
      pressY   = e.touches[0].clientY;
      dragging = false;
      dialTouchX    = pressX;
      dialTouchZoom = currentZoom;

      lpTimer = setTimeout(() => {
        showZoomDial(pressX);
        dragging = true;
      }, 250);
    }, { passive: true });

    btn.addEventListener('touchmove', e => {
      const dx = e.touches[0].clientX - pressX;
      const dy = e.touches[0].clientY - pressY;
      if (!dragging && Math.hypot(dx, dy) > 12) clearTimeout(lpTimer);
      if (dialActive) dialDragUpdate(e.touches[0].clientX);
    }, { passive: true });

    btn.addEventListener('touchend', () => {
      clearTimeout(lpTimer);
      if (dialActive) {
        clearTimeout(dialHideTimer);
        dialHideTimer = setTimeout(hideZoomDial, 1800);
      }
    }, { passive: true });
  });
}

/* ── Pinch-to-zoom ── */
let pinchStartDist = 0;
let pinchStartZoom = 1;

function getPinchDist(e) {
  return Math.hypot(
    e.touches[0].clientX - e.touches[1].clientX,
    e.touches[0].clientY - e.touches[1].clientY,
  );
}

/* ═══════════════════════════════════════════════════════════════
   DOM WIRING — run after DOM is ready
═══════════════════════════════════════════════════════════════ */
function wireUI() {
  // Splash lang buttons
  document.getElementById('langEN').addEventListener('click', () => setLanguage('en', { isPlaying, onLangChange: updateA2HSHint }));
  document.getElementById('langVI').addEventListener('click', () => setLanguage('vi', { isPlaying, onLangChange: updateA2HSHint }));

  // Mode select
  document.getElementById('modeCardPhoto').addEventListener('click', () => selectMode('photo'));
  document.getElementById('modeCardLive').addEventListener('click', () => selectMode('live'));

  // Top bar
  document.getElementById('backBtn').addEventListener('click', goHome);
  document.getElementById('flipBtn').addEventListener('click', flipCamera);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('saveBtn').addEventListener('click', savePhoto);

  // Bottom toolbar
  document.getElementById('captureBtn').addEventListener('click', onCapture);
  document.getElementById('galleryBtn').addEventListener('click', onImportPhoto);
  document.getElementById('playBtn').addEventListener('click', togglePlay);
  document.getElementById('switchBtn').addEventListener('click', switchMode);

  // Settings backdrop
  document.getElementById('settingsBackdrop').addEventListener('click', closeSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);

  // Instrument buttons
  document.getElementById('btn-inst-ambient').addEventListener('click', () => setInstrument('ambient'));
  document.getElementById('btn-inst-piano').addEventListener('click', () => setInstrument('piano'));
  document.getElementById('btn-inst-marimba').addEventListener('click', () => setInstrument('marimba'));
  document.getElementById('btn-inst-kalimba').addEventListener('click', () => setInstrument('kalimba'));
  document.getElementById('btn-inst-flute').addEventListener('click', () => setInstrument('flute'));

  // Scale buttons
  document.getElementById('btn-scale-pentatonic').addEventListener('click', () => setScale('pentatonic'));
  document.getElementById('btn-scale-major').addEventListener('click', () => setScale('major'));
  document.getElementById('btn-scale-minor').addEventListener('click', () => setScale('minor'));

  // Scan speed slider
  document.getElementById('speedSlider').addEventListener('input', e => setScanSpeed(e.target.value));

  // Sensitivity slider
  document.getElementById('sensitivitySlider').addEventListener('input', e => {
    sensitivity = parseInt(e.target.value);
  });

  // Overlay toggles
  document.getElementById('toggleClef').addEventListener('change', e => setShowClef(e.target.checked));
  document.getElementById('toggleGrid').addEventListener('change', e => setShowGrid(e.target.checked));

  // Camera facing buttons in settings
  document.getElementById('btn-cam-front').addEventListener('click', () => setCameraFacing('user'));
  document.getElementById('btn-cam-back').addEventListener('click', () => setCameraFacing('environment'));

  // Re-init hardware zoom after camera flip or switch
  document.getElementById('cameraVideo').addEventListener('loadedmetadata', () => {
    initCameraZoom();
  });

  // Language buttons in settings
  document.getElementById('set-langEN').addEventListener('click', () => setLanguage('en', { isPlaying, onLangChange: updateA2HSHint }));
  document.getElementById('set-langVI').addEventListener('click', () => setLanguage('vi', { isPlaying, onLangChange: updateA2HSHint }));

  // Camera view: fallback audio unlock on touch (iOS)
  document.getElementById('cameraView').addEventListener('touchend', () => {
    tryUnlockAudio();
  }, { passive: true });

  // A2HS banner
  document.getElementById('a2hsDismiss').addEventListener('click', () => {
    document.getElementById('a2hsBanner').classList.add('hidden');
    localStorage.setItem('a2hs-dismissed', '1');
  });

  document.getElementById('a2hsInstallBtn').addEventListener('click', async () => {
    if (_deferredInstallPrompt) {
      _deferredInstallPrompt.prompt();
      const { outcome } = await _deferredInstallPrompt.userChoice;
      _deferredInstallPrompt = null;
      document.getElementById('a2hsBanner').classList.add('hidden');
      if (outcome === 'accepted') localStorage.setItem('a2hs-dismissed', '1');
    }
  });

  initA2HS();

  // Zoom dial (long-press) + preset buttons
  wireZoomDial();

  // Zoom preset buttons
  [
    { id: 'zoomBtn05', z: 0.5 },
    { id: 'zoomBtn1',  z: 1   },
    { id: 'zoomBtn2',  z: 2   },
    { id: 'zoomBtn3',  z: 3   },
  ].forEach(({ id, z }) => {
    document.getElementById(id).addEventListener('click', () => applyZoom(z));
  });

  // Pinch-to-zoom (2 fingers on camera view)
  const cameraViewEl = document.getElementById('cameraView');

  cameraViewEl.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      pinchStartDist = getPinchDist(e);
      pinchStartZoom = currentZoom;
    }
  }, { passive: true });

  cameraViewEl.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      const dist = getPinchDist(e);
      applyZoom(pinchStartZoom * (dist / pinchStartDist));
    }
  }, { passive: true });

  // Show pill when touching the viewfinder
  cameraViewEl.addEventListener('touchstart', () => {
    bumpZoomPillVisible();
  }, { passive: true });

  // Double-tap to reset zoom to 1×
  let lastTap = 0;
  cameraViewEl.addEventListener('touchend', e => {
    if (e.touches.length > 0) return;
    const now = Date.now();
    if (now - lastTap < 300) {
      applyZoom(1);
    }
    lastTap = now;
  }, { passive: true });

  // ResizeObserver + orientationchange for landscape/portrait
  const ro = new ResizeObserver(() => {
    if (photoImgEl) {
      applyPhotoBounds();
    } else {
      staffData = resizeCanvas();
    }
    if (staffData) scanX = Math.max(staffData.staffLeft, Math.min(scanX, staffData.staffRight));
  });
  ro.observe(document.getElementById('cameraView'));

  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (photoImgEl) {
        applyPhotoBounds();
      } else {
        staffData = resizeCanvas();
      }
    }, 200);
  });
}

// Wire everything up once the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireUI);
} else {
  wireUI();
}

/* ═══════════════════════════════════════════════════════════════
   ADD TO HOME SCREEN
═══════════════════════════════════════════════════════════════ */
function updateA2HSHint() {
  const hint = document.getElementById('a2hsHint');
  if (!hint || !_a2hsPlatform) return;
  if (_a2hsPlatform === 'ios') {
    hint.innerHTML = `${SHARE_SVG} <span>${t('a2hs-ios')}</span>`;
  } else if (_a2hsPlatform === 'android') {
    // Native install prompt available — show just the description
    hint.textContent = t('a2hs-android');
  } else {
    // android-manual: no native prompt, guide user via browser menu
    hint.innerHTML = `<span class="a2hs-menu-dots">⋮</span> <span>${t('a2hs-android-manual')}</span>`;
  }
}

function showA2HSBanner(platform) {
  const banner = document.getElementById('a2hsBanner');
  if (!banner) return;
  _a2hsPlatform = platform;
  const installBtn = document.getElementById('a2hsInstallBtn');
  if (installBtn) installBtn.style.display = platform === 'android' ? 'block' : 'none';
  updateA2HSHint();
  banner.classList.remove('hidden');
}

function initA2HS() {
  if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) return;
  if (localStorage.getItem('a2hs-dismissed')) return;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  if (isIOS) {
    showA2HSBanner('ios');
  } else if (isAndroid) {
    // Show immediately with manual instruction; upgrade to install button if prompt fires
    showA2HSBanner('android-manual');
  }
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  if (!localStorage.getItem('a2hs-dismissed') && !window.matchMedia('(display-mode: standalone)').matches) {
    showA2HSBanner('android'); // upgrade to native install button
  }
});

// Register service worker (required for Android PWA install prompt)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
