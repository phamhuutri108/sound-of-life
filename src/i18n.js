export const I18N = {
  en: {
    'app-title': 'Sound of Life',
    'tagline': 'Bống Bống Bông Bông, lên ăn cơm vàng, cơm bạc nhà ta',
    'start': 'Start',
    'loading': 'Loading edge detection…',
    'camera-error': 'Camera access required.\nPlease allow camera permissions and reload.',
    'choose-mode': 'Choose your mode',
    'photo-mode': 'PHOTO',
    'photo-desc': 'Capture a moment and compose its melody',
    'live-mode': 'LIVE',
    'live-desc': 'Real-time melody from the world around you',
    'settings': 'Settings',
    'instrument': 'Instrument',
    'ambient': 'Ambient',
    'scale': 'Scale',
    'pentatonic': 'Pentatonic',
    'major': 'Major',
    'minor': 'Minor',
    'scan-speed': 'Scan Speed',
    'slow': 'Slow',
    'fast': 'Fast',
    'sensitivity': 'Sensitivity',
    'low': 'Low',
    'high': 'High',
    'camera': 'Camera',
    'front': 'Front',
    'back': 'Back',
    'language': 'Language',
    'play': 'Play',
    'pause': 'Pause',
    'switch': 'Mode',
    'capture': 'Capture',
    'retake': 'Retake',
    'gallery': 'Gallery',
  },
  vi: {
    'app-title': 'Âm Thanh Cuộc Sống',
    'tagline': 'Bống Bống Bông Bông, lên ăn cơm vàng, cơm bạc nhà ta',
    'start': 'Bắt đầu',
    'loading': 'Đang tải nhận diện cạnh…',
    'camera-error': 'Cần quyền truy cập camera.\nVui lòng cho phép camera và tải lại trang.',
    'choose-mode': 'Chọn chế độ',
    'photo-mode': 'ẢNH',
    'photo-desc': 'Chụp một khoảnh khắc và tạo giai điệu',
    'live-mode': 'TRỰC TIẾP',
    'live-desc': 'Giai điệu thời gian thực từ thế giới xung quanh',
    'settings': 'Cài đặt',
    'instrument': 'Nhạc cụ',
    'ambient': 'Không gian',
    'scale': 'Thang âm',
    'pentatonic': 'Ngũ cung',
    'major': 'Trưởng',
    'minor': 'Thứ',
    'scan-speed': 'Tốc độ quét',
    'slow': 'Chậm',
    'fast': 'Nhanh',
    'sensitivity': 'Độ nhạy',
    'low': 'Thấp',
    'high': 'Cao',
    'camera': 'Máy ảnh',
    'front': 'Trước',
    'back': 'Sau',
    'language': 'Ngôn ngữ',
    'play': 'Phát',
    'pause': 'Dừng',
    'switch': 'Chế độ',
    'capture': 'Chụp',
    'retake': 'Chụp lại',
    'gallery': 'Thư viện',
  },
};

let currentLang = 'en';

const txtIds = [
  'app-title', 'tagline', 'start', 'loading', 'camera-error', 'choose-mode',
  'photo-mode', 'photo-desc', 'live-mode', 'live-desc', 'settings', 'instrument',
  'ambient', 'scale', 'pentatonic', 'major', 'minor', 'scan-speed', 'slow', 'fast',
  'sensitivity', 'low', 'high', 'camera', 'front', 'back', 'language',
];

export function t(key) {
  return I18N[currentLang][key] || I18N['en'][key] || key;
}

export function getCurrentLang() {
  return currentLang;
}

export function setLanguage(lang, { isPlaying, onLangChange } = {}) {
  currentLang = lang;
  document.documentElement.lang = lang;

  // Update all translated text nodes
  txtIds.forEach(key => {
    const el = document.getElementById('txt-' + key);
    if (el) el.textContent = t(key);
  });

  // Update play button label contextually
  const playTxt = document.getElementById('txt-play');
  if (playTxt) {
    playTxt.textContent = isPlaying ? t('pause') : t('play');
  }

  // Update language buttons on splash
  const langEN = document.getElementById('langEN');
  const langVI = document.getElementById('langVI');
  if (langEN) langEN.classList.toggle('active', lang === 'en');
  if (langVI) langVI.classList.toggle('active', lang === 'vi');

  // Update language buttons in settings
  const setLangEN = document.getElementById('set-langEN');
  const setLangVI = document.getElementById('set-langVI');
  if (setLangEN) setLangEN.classList.toggle('active', lang === 'en');
  if (setLangVI) setLangVI.classList.toggle('active', lang === 'vi');

  if (onLangChange) onLangChange(lang);
}
