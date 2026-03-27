// Camera state
export let currentStream = null;
export let cameraFacing = 'environment';

export function setCameraFacingState(facing) {
  cameraFacing = facing;
}

export async function startCamera(facing = 'environment') {
  const video = document.getElementById('cameraVideo');

  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    currentStream = stream;
    video.srcObject = stream;
    await video.play();
    document.getElementById('cameraError').classList.remove('active');
  } catch (err) {
    console.error('Camera error:', err);
    document.getElementById('cameraError').classList.add('active');
  }
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
