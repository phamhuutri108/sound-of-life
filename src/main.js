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
  ctx,
  resizeCanvas,
  renderStaff,
  setShowClef, setShowGrid,
} from './staff.js';
import {
  cvReady,
  noteCooldowns, shouldTriggerNote,
  detectObjects as _detectObjects,
} from './detection.js';
import { loadSmartModel, isSmartReady, drawDetections } from './smartDetection.js';

/* ═══════════════════════════════════════════════════════════════
   APP STATE
═══════════════════════════════════════════════════════════════ */
let appMode = 'photo'; // 'photo' | 'live'
let isPlaying = true;
let photoDataURL = null;
let photoImgEl = null;
let sensitivity = 70;
let staffData = null;

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
  document.getElementById('zoomControls').style.opacity = '0';
  applyMode(mode);
  await startCamera(_cameraFacing);
  initCameraZoom();
  staffData = resizeCanvas();
  if (staffData) scanX = staffData.staffLeft;
  startAnimationLoop();

  // Show opencv status if not ready
  if (!cvReady) {
    const el = document.getElementById('opencvStatus');
    el.style.display = '';
    el.classList.remove('loaded');
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
    // Reset scan to start
    if (staffData) scanX = staffData.staffLeft;
  }
}

function doRetakePhoto() {
  retakePhoto();
  photoDataURL = null;
  photoImgEl = null;
}

function onImportPhoto() {
  _importPhoto({
    staffData,
    noteCooldowns,
    t,
    onResult: (result) => {
      photoDataURL = result.photoDataURL;
      photoImgEl = result.photoImgEl;
      if (staffData) scanX = staffData.staffLeft;
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
const DETECTION_INTERVAL = 200; // ~5fps — lighter on mobile
const MAX_NOTES_PER_PASS = 2;   // prevent audio overload

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
  if (now - lastDetectionTime > DETECTION_INTERVAL) {
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

      // Trigger notes — cap at MAX_NOTES_PER_PASS to prevent audio overload
      if (lastDetectionResults && isAudioReady()) {
        let fired = 0;
        for (let i = 0; i < lastDetectionResults.length && fired < MAX_NOTES_PER_PASS; i++) {
          const result = lastDetectionResults[i];
          if (result.detected && shouldTriggerNote(`note_${i}`, now)) {
            playNote(getNoteForPosition(i), confidenceToVelocity(result.confidence));
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
const ZOOM_MIN = 1;
const ZOOM_MAX_DEFAULT = 5;
let currentZoom = 1;
let zoomMax = ZOOM_MAX_DEFAULT;

// Hardware zoom state
let zoomTrack  = null; // MediaStreamTrack with zoom capability
let zoomHwMin  = 1;
let zoomHwMax  = ZOOM_MAX_DEFAULT;

// Auto-hide pill
let zoomHideTimer = null;

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
      // hardware zoom failed — CSS fallback
      _applyCSSZoom(currentZoom);
    });
    // Clear CSS scale when using hardware zoom
    document.getElementById('zoomContainer').style.transform = '';
  } else {
    _applyCSSZoom(currentZoom);
  }

  updateZoomPill();
  bumpZoomPillVisible();
}

function _applyCSSZoom(z) {
  document.getElementById('zoomContainer').style.transform =
    z <= 1.0001 ? '' : `scale(${z})`;
}

function bumpZoomPillVisible() {
  const pill = document.getElementById('zoomControls');
  pill.style.opacity = '1';
  clearTimeout(zoomHideTimer);
  zoomHideTimer = setTimeout(() => {
    pill.style.opacity = '0';
  }, 3000);
}

function updateZoomPill() {
  const presetDefs = [
    { id: 'zoomBtn1', z: 1 },
    { id: 'zoomBtn2', z: 2 },
    { id: 'zoomBtn3', z: 3 },
  ];
  presetDefs.forEach(({ id, z }) => {
    const btn = document.getElementById(id);
    const isActive = Math.abs(currentZoom - z) < 0.08;
    btn.classList.toggle('active', isActive);
  });
}

/* ── Zoom dial (long-press rotary wheel) ── */
let dialActive   = false;
let dialTouchX   = 0;
let dialTouchZoom = 1;
let dialHideTimer = null;
const DIAL_PX_PER_LOG = 220; // ~375px to go from 1× to 5×

function showZoomDial(startX) {
  clearTimeout(dialHideTimer);
  dialTouchX    = startX;
  dialTouchZoom = currentZoom;
  dialActive    = true;
  const el = document.getElementById('zoomDialOverlay');
  el.style.display = '';
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  renderZoomDial();
  if (navigator.vibrate) navigator.vibrate(10);
}

function hideZoomDial() {
  dialActive = false;
  const el = document.getElementById('zoomDialOverlay');
  el.style.opacity = '0';
  dialHideTimer = setTimeout(() => { el.style.display = 'none'; }, 320);
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

  // Circle center sits below canvas so only the top arc shows
  const cx = W / 2;
  const cy = H + 40;
  const R  = Math.min(W * 0.94, 440);

  const logMin = Math.log(ZOOM_MIN);
  const logMax = Math.log(Math.max(zoomMax, 5));
  const logCur = Math.log(Math.max(ZOOM_MIN, currentZoom));
  const HALF_ARC = Math.PI * 0.68; // ±123° visible arc

  // angle for any log-zoom relative to current (current = top = -π/2)
  const logToAngle = (lz) =>
    -Math.PI / 2 + ((lz - logCur) / (logMax - logMin)) * HALF_ARC * 2;

  // Faint background arc track
  dc.beginPath();
  dc.arc(cx, cy, R, logToAngle(logMin), logToAngle(logMax));
  dc.strokeStyle = 'rgba(255,255,255,0.10)';
  dc.lineWidth = 1;
  dc.stroke();

  // Tick marks — fine every 0.1, major at .5 / 1 / 1.5 / 2 / 3 / 4 / 5 / 6 / 8
  const MAJOR_SET = new Set([0.5, 1, 1.5, 2, 3, 4, 5, 6, 8]);
  const step = 0.1;
  for (let z = ZOOM_MIN; z <= zoomMax + 0.01; z = Math.round((z + step) * 10) / 10) {
    const logZ  = Math.log(z);
    const angle = logToAngle(logZ);
    if (Math.abs(angle + Math.PI / 2) > HALF_ARC + 0.05) continue;

    const isMajor  = MAJOR_SET.has(Math.round(z * 10) / 10);
    const isCur    = Math.abs(z - currentZoom) < 0.07;
    const tickLen  = isMajor ? 18 : 9;
    const x1 = cx + R * Math.cos(angle);
    const y1 = cy + R * Math.sin(angle);
    const x2 = cx + (R - tickLen) * Math.cos(angle);
    const y2 = cy + (R - tickLen) * Math.sin(angle);

    dc.beginPath();
    dc.moveTo(x1, y1);
    dc.lineTo(x2, y2);
    dc.strokeStyle = isCur
      ? '#ffd600'
      : isMajor
        ? 'rgba(255,255,255,0.75)'
        : 'rgba(255,255,255,0.28)';
    dc.lineWidth = isMajor ? 1.8 : 1;
    dc.stroke();

    // Label major ticks (except current — shown by big text above)
    if (isMajor && !isCur) {
      const lx = cx + (R - 34) * Math.cos(angle);
      const ly = cy + (R - 34) * Math.sin(angle);
      dc.font = '400 11px Montserrat, sans-serif';
      dc.fillStyle = 'rgba(255,255,255,0.55)';
      dc.textAlign = 'center';
      dc.textBaseline = 'middle';
      dc.fillText(z + '×', lx, ly);
    }
  }

  // Fixed ▼ pointer at top center
  const px = cx;
  const py = cy - R + 2;
  dc.beginPath();
  dc.moveTo(px, py + 12);
  dc.lineTo(px - 7, py + 1);
  dc.lineTo(px + 7, py + 1);
  dc.closePath();
  dc.fillStyle = '#ffd600';
  dc.fill();

  // Value label
  document.getElementById('zoomDialValue').textContent = currentZoom.toFixed(1) + '×';
}

function wireZoomDial() {
  const overlay = document.getElementById('zoomDialOverlay');

  // Touch on dial → drag to zoom
  overlay.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      dialTouchX    = e.touches[0].clientX;
      dialTouchZoom = currentZoom;
    }
  }, { passive: true });

  overlay.addEventListener('touchmove', e => {
    if (!dialActive || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - dialTouchX;
    const newLogZ = Math.log(Math.max(ZOOM_MIN, dialTouchZoom)) + dx / DIAL_PX_PER_LOG;
    applyZoom(Math.exp(newLogZ));
    renderZoomDial();
  }, { passive: true });

  overlay.addEventListener('touchend', () => {
    clearTimeout(dialHideTimer);
    dialHideTimer = setTimeout(hideZoomDial, 1800);
  }, { passive: true });

  // Long press on any zoom-btn → show dial
  document.querySelectorAll('.zoom-btn').forEach(btn => {
    let lpTimer = null;
    btn.addEventListener('touchstart', e => {
      const startX = e.touches[0].clientX;
      lpTimer = setTimeout(() => { showZoomDial(startX); }, 320);
    }, { passive: true });
    btn.addEventListener('touchend',  () => clearTimeout(lpTimer), { passive: true });
    btn.addEventListener('touchmove', () => clearTimeout(lpTimer), { passive: true });
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
  document.getElementById('langEN').addEventListener('click', () => setLanguage('en', { isPlaying }));
  document.getElementById('langVI').addEventListener('click', () => setLanguage('vi', { isPlaying }));

  // Mode select
  document.getElementById('modeCardPhoto').addEventListener('click', () => selectMode('photo'));
  document.getElementById('modeCardLive').addEventListener('click', () => selectMode('live'));

  // Top bar
  document.getElementById('backBtn').addEventListener('click', goHome);
  document.getElementById('flipBtn').addEventListener('click', flipCamera);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

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
  document.getElementById('set-langEN').addEventListener('click', () => setLanguage('en', { isPlaying }));
  document.getElementById('set-langVI').addEventListener('click', () => setLanguage('vi', { isPlaying }));

  // Camera view: fallback audio unlock on touch (iOS)
  document.getElementById('cameraView').addEventListener('touchend', () => {
    tryUnlockAudio();
  }, { passive: true });

  // Zoom dial (long-press) + preset buttons
  wireZoomDial();

  // Zoom preset buttons
  [
    { id: 'zoomBtn1', z: 1 },
    { id: 'zoomBtn2', z: 2 },
    { id: 'zoomBtn3', z: 3 },
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
    staffData = resizeCanvas();
    if (staffData) scanX = Math.max(staffData.staffLeft, Math.min(scanX, staffData.staffRight));
  });
  ro.observe(document.getElementById('cameraView'));

  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      staffData = resizeCanvas();
    }, 200);
  });
}

// Wire everything up once the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireUI);
} else {
  wireUI();
}
