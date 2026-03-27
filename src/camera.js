// Camera state
export let currentStream = null;
export let cameraFacing = 'environment';

function isLikelyInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /Instagram|FBAN|FBAV|Line|Zalo|TikTok/i.test(ua);
}

function getCameraErrorMessage(err) {
  const inApp = isLikelyInAppBrowser();
  if (inApp) {
    return 'Camera is limited in in-app browser. Open in Safari/Chrome and allow camera permission.';
  }
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return 'Camera permission denied. Please allow camera access in browser settings and reload.';
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
    return 'No compatible camera found. Try switching camera or using another browser.';
  }
  return 'Camera access required. Please allow camera permissions and reload.';
}

function buildCameraAttempts(facing) {
  return [
    {
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: facing,
        width: { ideal: 960 },
        height: { ideal: 540 },
      },
      audio: false,
    },
    {
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    },
    {
      video: true,
      audio: false,
    },
  ];
}

export function setCameraFacingState(facing) {
  cameraFacing = facing;
}

export async function startCamera(facing = 'environment') {
  const video = document.getElementById('cameraVideo');
  const errorEl = document.getElementById('cameraError');
  const errorTextEl = document.getElementById('txt-camera-error');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (errorTextEl) {
      errorTextEl.textContent = 'This browser does not support camera API. Please use Safari/Chrome.';
    }
    errorEl.classList.add('active');
    return false;
  }

  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
  }
  let lastError = null;

  const attempts = buildCameraAttempts(facing);
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentStream = stream;
      video.srcObject = stream;
      video.style.transform = facing === 'user' ? 'scaleX(-1)' : '';
      await video.play();
      errorEl.classList.remove('active');
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  console.error('Camera error:', lastError);
  if (errorTextEl) {
    errorTextEl.textContent = getCameraErrorMessage(lastError);
  }
  errorEl.classList.add('active');
  return false;
}

export async function flipCamera({ appMode, photoDataURL, onFacingChange }) {
  cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
  document.getElementById('btn-cam-front').classList.toggle('active', cameraFacing === 'user');
  document.getElementById('btn-cam-back').classList.toggle('active', cameraFacing === 'environment');
  if (appMode === 'live' || !photoDataURL) {
    await startCamera(cameraFacing);
  }
  if (onFacingChange) onFacingChange(cameraFacing);
}

export async function setCameraFacing(facing, { appMode, photoDataURL, closeSettings, onFacingChange } = {}) {
  cameraFacing = facing;
  document.getElementById('btn-cam-front').classList.toggle('active', facing === 'user');
  document.getElementById('btn-cam-back').classList.toggle('active', facing === 'environment');
  if (closeSettings) closeSettings();
  if (appMode === 'live' || !photoDataURL) {
    await startCamera(cameraFacing);
  }
  if (onFacingChange) onFacingChange(cameraFacing);
}

// Offscreen canvas for photo capture
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d');

export function capturePhoto({ staffData, noteCooldowns, t }) {
  const video = document.getElementById('cameraVideo');
  if (video.readyState < 2) return null;

  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  captureCtx.drawImage(video, 0, 0);
  const photoDataURL = captureCanvas.toDataURL('image/jpeg', 0.85);

  const preview = document.getElementById('photoPreview');
  preview.style.backgroundImage = `url(${photoDataURL})`;
  preview.classList.add('active');

  // Cache Image element for detection
  const photoImgEl = new Image();
  photoImgEl.src = photoDataURL;

  // Hide live video
  video.style.opacity = '0';

  // Swap capture button to retake
  const btn = document.getElementById('captureBtn');
  btn.classList.add('retake');
  if (t) btn.title = t('retake');

  // Reset scan
  if (staffData) {
    Object.keys(noteCooldowns).forEach(k => delete noteCooldowns[k]);
  }

  return { photoDataURL, photoImgEl };
}

export function retakePhoto() {
  const video = document.getElementById('cameraVideo');
  document.getElementById('photoPreview').classList.remove('active');
  document.getElementById('photoPreview').style.backgroundImage = '';
  video.style.opacity = '1';
  document.getElementById('captureBtn').classList.remove('retake');
}

export function importPhoto({ staffData, noteCooldowns, t, onResult }) {
  const input = document.getElementById('photoImport');
  input.onchange = (e) => {
    const file = e.target.files[0];
    // Reset input immediately so the same file can be re-selected later
    input.value = '';
    if (!file) return;

    // createObjectURL is instant — zero base64 encoding, no main-thread work
    const blobUrl = URL.createObjectURL(file);

    const photoImgEl = new Image();
    photoImgEl.src = blobUrl;

    // decode() is async and off the main thread — UI stays responsive while JPEG decodes
    const decodeDone = typeof photoImgEl.decode === 'function'
      ? photoImgEl.decode().catch(() => {})
      : Promise.resolve();

    decodeDone.then(() => {
      const preview = document.getElementById('photoPreview');
      preview.style.backgroundImage = `url(${blobUrl})`;
      preview.classList.add('active');

      // Hide live video
      document.getElementById('cameraVideo').style.opacity = '0';

      // Swap capture button to retake
      const btn = document.getElementById('captureBtn');
      btn.classList.add('retake');
      if (t) btn.title = t('retake');

      // Reset scan cooldowns
      if (staffData) {
        Object.keys(noteCooldowns).forEach(k => delete noteCooldowns[k]);
      }

      if (onResult) onResult({ photoDataURL: blobUrl, photoImgEl });
    });
  };
  input.click();
}
