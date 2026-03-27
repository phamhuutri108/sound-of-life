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
  capturePhoto as _capturePhoto, retakePhoto,
  cameraFacing as _cameraFacing,
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

  if (mode === 'photo') {
    badge.textContent = t('photo-mode');
    document.getElementById('captureBtn').style.display = '';
    retakePhoto();
    photoDataURL = null;
    photoImgEl = null;
  } else {
    badge.textContent = t('live-mode');
    document.getElementById('captureBtn').style.display = 'none';
    retakePhoto();
    photoDataURL = null;
    photoImgEl = null;
  }

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

  // Hide camera UI
  document.getElementById('topBar').style.display = 'none';
  document.getElementById('bottomToolbar').style.display = 'none';
  document.getElementById('zoomControls').style.display = 'none';
  document.getElementById('cameraView').classList.remove('active');

  // Show mode selection
  document.getElementById('modeSelect').classList.remove('hidden');
}

function selectMode(mode) {
  document.getElementById('modeSelect').classList.add('hidden');
  document.getElementById('cameraView').classList.add('active');
  document.getElementById('topBar').style.display = '';
  document.getElementById('bottomToolbar').style.display = '';
  document.getElementById('zoomControls').style.display = '';
  applyMode(mode);
  startCamera(_cameraFacing);
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
   STARTUP
═══════════════════════════════════════════════════════════════ */
function onStart() {
  initAudio(); // sync within gesture — do NOT await
  loadSmartModel(); // fire-and-forget; detection falls back until ready
  document.getElementById('splash').classList.add('hidden');
  setTimeout(() => {
    document.getElementById('modeSelect').classList.remove('hidden');
  }, 350);
}


/* ═══════════════════════════════════════════════════════════════
   ZOOM
═══════════════════════════════════════════════════════════════ */
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_PRESETS = [1, 2, 3];
let currentZoom = 1;

function applyZoom(z) {
  currentZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  // Scale the zoom container — overflow is clipped by parent .camera-view
  document.getElementById('zoomContainer').style.transform =
    currentZoom === 1 ? '' : `scale(${currentZoom})`;
  updateZoomButtons();
}

function updateZoomButtons() {
  document.querySelectorAll('.zoom-btn').forEach(btn => btn.classList.remove('active'));
  const presetIds = ['zoomBtn1', 'zoomBtn2', 'zoomBtn3'];
  ZOOM_PRESETS.forEach((z, i) => {
    if (Math.abs(currentZoom - z) < 0.05) {
      document.getElementById(presetIds[i]).classList.add('active');
    }
  });
}

/* ── Long-press zoom wheel ── */
const WHEEL_DRAG_SCALE = 0.015; // zoom change per pixel dragged
let wheelActive = false;
let wheelStartX = 0;
let wheelStartZoom = 1;
let longPressTimer = null;

function showZoomWheel() {
  const wrap = document.getElementById('zoomWheelWrap');
  wrap.style.display = '';
  wheelActive = true;
  updateWheelKnob();
  if (navigator.vibrate) navigator.vibrate(10);
}

function hideZoomWheel() {
  document.getElementById('zoomWheelWrap').style.display = 'none';
  wheelActive = false;
}

function updateWheelKnob() {
  const track = document.getElementById('zoomWheelTrack');
  const knob  = document.getElementById('zoomWheelKnob');
  const fill  = document.getElementById('zoomWheelFill');
  const label = document.getElementById('zoomWheelValue');
  const W = track.clientWidth;
  const ratio = (currentZoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN);
  const x = Math.round(ratio * W);
  knob.style.left = x + 'px';
  fill.style.width = x + 'px';
  label.textContent = currentZoom.toFixed(1) + '×';
}

function wireZoomWheel() {
  const presetDefs = [
    { id: 'zoomBtn1', z: 1 },
    { id: 'zoomBtn2', z: 2 },
    { id: 'zoomBtn3', z: 3 },
  ];

  presetDefs.forEach(({ id, z }) => {
    const btn = document.getElementById(id);

    // Tap → set preset immediately
    btn.addEventListener('click', () => {
      applyZoom(z);
    });

    // Long press → show wheel (passive so click still fires for short taps)
    btn.addEventListener('touchstart', e => {
      wheelStartX    = e.touches[0].clientX;
      wheelStartZoom = currentZoom;
      longPressTimer = setTimeout(() => {
        showZoomWheel();
      }, 300);
    }, { passive: true });

    btn.addEventListener('touchend', () => {
      clearTimeout(longPressTimer);
    }, { passive: true });

    btn.addEventListener('touchmove', () => {
      clearTimeout(longPressTimer);
    }, { passive: true });
  });

  // Drag on the track itself after wheel is shown
  document.addEventListener('touchmove', e => {
    if (!wheelActive) return;
    const dx = e.touches[0].clientX - wheelStartX;
    applyZoom(wheelStartZoom + dx * WHEEL_DRAG_SCALE);
    updateWheelKnob();
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!wheelActive) return;
    wheelStartZoom = currentZoom;
    wheelStartX    = 0;
    setTimeout(hideZoomWheel, 1200);
  }, { passive: true });
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
  // Splash
  document.getElementById('startBtn').addEventListener('click', onStart);
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

  // Language buttons in settings
  document.getElementById('set-langEN').addEventListener('click', () => setLanguage('en', { isPlaying }));
  document.getElementById('set-langVI').addEventListener('click', () => setLanguage('vi', { isPlaying }));

  // Camera view: fallback audio unlock on touch (iOS)
  document.getElementById('cameraView').addEventListener('touchend', () => {
    tryUnlockAudio();
  }, { passive: true });

  // Zoom wheel long-press + preset buttons
  wireZoomWheel();

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
