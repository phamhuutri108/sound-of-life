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
  canvas, ctx,
  resizeCanvas,
  drawStaffLines, drawTrebleClef, drawNoteIndicator,
  renderStaff,
} from './staff.js';
import {
  cvReady,
  noteCooldowns, shouldTriggerNote,
  detectObjects as _detectObjects,
} from './detection.js';

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

function selectMode(mode) {
  document.getElementById('modeSelect').classList.add('hidden');
  document.getElementById('cameraView').classList.add('active');
  document.getElementById('topBar').style.display = '';
  document.getElementById('bottomToolbar').style.display = '';
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
const DETECTION_INTERVAL = 66; // ~15fps for detection

function animationLoop(now) {
  requestAnimationFrame(animationLoop);

  if (!staffData || !isPlaying) {
    // Still render staff (without scan line movement)
    if (staffData) {
      ctx.clearRect(0, 0, staffData.displayWidth, staffData.displayHeight);
      drawStaffLines(staffData);
      drawTrebleClef(staffData);
      // draw passive dots at scan position
      staffData.positions.forEach(pos => drawNoteIndicator(scanX, pos.y, false, 0));
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

      // Trigger notes
      if (lastDetectionResults && isAudioReady()) {
        lastDetectionResults.forEach((result, i) => {
          if (result.detected) {
            const noteId = `note_${i}`;
            if (shouldTriggerNote(noteId, now)) {
              const note = getNoteForPosition(i);
              const vel = confidenceToVelocity(result.confidence);
              playNote(note, vel);
            }
          }
        });
      }
    }
  }

  renderStaff(curScanX, lastDetectionResults, staffData, isPlaying);
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
  document.getElementById('splash').classList.add('hidden');
  setTimeout(() => {
    document.getElementById('modeSelect').classList.remove('hidden');
  }, 350);
}

/* ═══════════════════════════════════════════════════════════════
   PINCH-TO-ZOOM
═══════════════════════════════════════════════════════════════ */
let currentZoom = 1;
let pinchStartDist = 0;
let pinchStartZoom = 1;

function getPinchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.hypot(dx, dy);
}

function applyZoom() {
  const z = currentZoom;
  const video = document.getElementById('cameraVideo');
  video.style.transform = `scale(${z})`;
  document.getElementById('photoPreview').style.transform = `scale(${z})`;
  canvas.style.transform = `scale(${z})`;
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

  // Pinch-to-zoom
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
      currentZoom = Math.min(5, Math.max(1, pinchStartZoom * (dist / pinchStartDist)));
      applyZoom();
    }
  }, { passive: true });

  // Double-tap to reset zoom
  let lastTap = 0;
  cameraViewEl.addEventListener('touchend', e => {
    if (e.touches.length > 0) return;
    const now = Date.now();
    if (now - lastTap < 300) {
      currentZoom = 1;
      applyZoom();
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
