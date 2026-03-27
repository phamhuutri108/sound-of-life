---
name: sound-of-life
description: Build "Sound of Life" — a mobile-first web app that overlays a musical staff on camera feed, detects objects via brightness + edge detection, and plays musical notes when objects intersect staff positions. Use this skill whenever working on the Sound of Life app, including UI, camera integration, audio synthesis, object detection, or any feature of this project. Single HTML file, deployed on web, uses Tone.js + OpenCV.js from CDN.
---

# Sound of Life — Complete Build Skill

## Concept

"Sound of Life" turns the real world into music. A musical staff (khuông nhạc) is overlaid on a camera feed or captured photo. A scan line sweeps horizontally across the screen. When it crosses a position where an object exists on the staff, a musical note plays. Every scene becomes a unique composition.

**Tagline**: "Every moment has its melody"

## Target Platform

- **Primary**: Mobile browsers (iOS Safari, Android Chrome) — landscape & portrait
- **Secondary**: Desktop browsers
- **Delivery**: Single self-contained HTML file
- **CDN dependencies**: Tone.js (audio synthesis), OpenCV.js (edge detection)
- **Hosting**: Cloudflare Pages
- **URL**: `https://sound-of-life.phamhuutri.com`
- **Domain**: `phamhuutri.com` (already on Cloudflare)

## Architecture Overview

```
Single HTML file
├── Inline CSS (mobile-first responsive)
├── Inline JavaScript
│   ├── Camera Module (getUserMedia, photo capture)
│   ├── Detection Module (brightness analysis + OpenCV Canny edge detection)
│   ├── Audio Module (Tone.js — 4 instrument types, 3 scales)
│   ├── Staff Renderer (canvas overlay — treble clef, 5 lines, note positions)
│   ├── Scan Line Engine (adjustable speed, left→right sweep, loop)
│   ├── UI Controller (mode switching, settings panel, i18n)
│   └── i18n Module (English default, Vietnamese toggle)
└── External CDN
    ├── Tone.js (https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js)
    └── OpenCV.js (https://docs.opencv.org/4.9.0/opencv.js)
```

## Detailed Feature Specification

### 1. Two Operating Modes

#### PHOTO Mode
1. User taps "Capture" → camera takes a still photo
2. Photo displayed full-screen with staff overlay
3. Scan line sweeps left → right
4. At each X position, analyze vertical column for objects at each note position
5. When object detected at a note position → play that note
6. Scan line reaches right edge → loop back to left (or stop, user choice)
7. User can retake photo or switch to LIVE mode

#### LIVE Mode
1. Camera feed streams continuously in real-time
2. Staff overlay rendered on top of video feed
3. Scan line sweeps continuously left → right, looping
4. Detection runs in real-time on each frame at scan line position
5. Moving camera creates different melodies as scene changes
6. Higher performance demands — optimize detection for 15-24 fps

### 2. Object Detection (Dual Method)

Read `references/detection-algorithm.md` for the full algorithm specification.

**Summary**: Combine two methods for robust detection:

1. **Brightness Contrast Analysis** (fast, always-on):
   - Sample pixels at each note position along the scan line
   - Compute local average brightness in a small region around each position
   - Compare to the global average brightness of the frame
   - If difference exceeds threshold → object detected
   - Adaptive threshold based on scene contrast

2. **Canny Edge Detection** (OpenCV.js, more accurate):
   - Run Canny edge detection on the current frame (or captured photo)
   - At each note position along the scan line, check for edge pixels
   - Edge presence indicates object boundary → object detected
   - Combine with brightness for higher confidence

**Detection output**: For each of the 13 note positions, a boolean: object present or not.

### 3. Audio System

Read `references/audio-system.md` for full Tone.js implementation details.

**4 Instrument Types** (user-selectable):
- **Ambient Synth**: Soft sine wave with long reverb, ethereal feel
- **Piano**: AM Synth with fast attack, piano-like envelope
- **Marimba/Xylophone**: FM Synth with short decay, percussive
- **Kalimba**: Metal Synth or triangle wave with medium decay, metallic warmth

**3 Scale Options** (user-selectable):
- **Pentatonic** (default): C D E G A — always harmonious, no dissonance
- **Major**: C D E F G A B — bright, happy
- **Minor**: C D Eb F G Ab Bb — melancholic, contemplative

**Note mapping**: 13 vertical positions on the staff map to 13 notes spanning ~2 octaves (e.g., C3 to C5 for pentatonic extended).

**Note triggering rules**:
- A note only triggers once per scan line pass at a given position (debounce)
- Notes have natural attack/decay envelope — no abrupt cuts
- Multiple notes can play simultaneously (polyphonic)
- Volume scales with detection confidence (stronger detection = louder note)

### 4. Musical Staff Rendering

Read `references/staff-rendering.md` for canvas drawing specifications.

**Elements to draw on canvas overlay**:
- Treble clef (khóa Sol) on the left side
- 5 horizontal staff lines with proper spacing
- Ledger line positions above and below (for extended range)
- Note position indicators (small dots or circles) at intersection of scan line and staff positions — light up when object detected
- Scan line: vertical white/bright line, semi-transparent, sweeps left → right

**Visual style**:
- Staff lines: white with slight transparency (rgba 255,255,255,0.6)
- Treble clef: white, drawn via SVG path or pre-rendered
- Active notes: glow effect (bright circle with blur) when triggered
- Scan line: bright white with subtle glow, 2-3px wide

### 5. User Interface

Read `references/ui-design.md` for complete mobile-first UI specification.

**Mobile-first design priorities**:
- Full-screen camera/photo view — UI elements overlay on edges
- Bottom toolbar for primary actions (capture, play/pause, mode switch)
- Top-right settings gear icon → slide-out settings panel
- Touch-friendly: minimum 44px tap targets
- Dark theme to complement camera view
- No scrolling on main view — everything fits viewport

**UI Flow**:
```
Splash Screen ("Sound of Life" branding, start button)
    ↓ tap "Start" / "Bắt đầu"
Mode Selection (PHOTO | LIVE)
    ↓
Camera View + Staff Overlay
    ├── Bottom bar: [Capture/⏸️] [▶️ Play] [🔄 Mode] [⚙️ Settings]
    └── Settings Panel (slide from right):
        ├── Instrument: [Ambient] [Piano] [Marimba] [Kalimba]
        ├── Scale: [Pentatonic] [Major] [Minor]
        ├── Scan Speed: [slider: slow ↔ fast]
        ├── Detection Sensitivity: [slider: low ↔ high]
        ├── Language: [EN / VI]
        └── Camera: [Front / Back]
```

### 6. Internationalization (i18n)

**Default**: English
**Toggle**: Vietnamese (Tiếng Việt)

All UI strings stored in a single i18n object. Key translations:

| English | Vietnamese |
|---------|-----------|
| Sound of Life | Âm Thanh Cuộc Sống |
| Capture | Chụp |
| Play | Phát |
| Pause | Dừng |
| Settings | Cài đặt |
| Instrument | Nhạc cụ |
| Scale | Thang âm |
| Scan Speed | Tốc độ quét |
| Sensitivity | Độ nhạy |
| Language | Ngôn ngữ |
| Photo Mode | Chế độ Ảnh |
| Live Mode | Chế độ Trực tiếp |
| Camera | Máy ảnh |
| Front | Trước |
| Back | Sau |
| Retake | Chụp lại |
| Every moment has its melody | Mỗi khoảnh khắc đều có giai điệu |
| Ambient | Không gian |
| Piano | Piano |
| Marimba | Marimba |
| Kalimba | Kalimba |
| Pentatonic | Ngũ cung |
| Major | Trưởng |
| Minor | Thứ |
| Slow | Chậm |
| Fast | Nhanh |
| Low | Thấp |
| High | Cao |
| Start | Bắt đầu |
| Loading... | Đang tải... |
| Camera access required | Cần quyền truy cập camera |
| Tap anywhere to begin | Chạm để bắt đầu |

## Implementation Order

Build in this sequence to have a working prototype at each step:

1. **HTML scaffold + CSS** — splash screen, camera view layout, bottom bar, settings panel (all mobile-first)
2. **Camera module** — getUserMedia, video feed, photo capture, front/back toggle
3. **Staff renderer** — canvas overlay, draw 5 lines + treble clef + note positions
4. **Scan line engine** — animated vertical line sweeping left→right, adjustable speed
5. **Detection module (brightness)** — analyze pixels at note positions along scan line
6. **Audio module** — Tone.js setup, 4 instruments, 3 scales, note triggering
7. **Wire detection → audio** — object detected → play note with correct instrument/scale
8. **Detection module (OpenCV edge)** — load OpenCV.js, run Canny, combine with brightness
9. **LIVE mode** — real-time detection on video frames
10. **Settings panel** — instrument picker, scale picker, speed slider, sensitivity slider
11. **i18n** — language toggle, all strings
12. **Polish** — animations, transitions, loading states, error handling

## Critical Technical Notes

### Camera on Mobile
- MUST use `playsinline` attribute on video element for iOS
- MUST handle both `facingMode: "environment"` (back) and `"user"` (front)
- Request camera with `{ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } }`
- Handle permission denial gracefully with user-friendly message

### Canvas Overlay
- Use a `<canvas>` element positioned absolutely on top of the `<video>` element
- Canvas size must match video display size (use ResizeObserver)
- Draw staff lines, treble clef, scan line, and note indicators on this canvas
- Clear and redraw each animation frame

### OpenCV.js Loading
- OpenCV.js is ~8MB — show loading indicator while it loads
- Load asynchronously: `<script async src="...opencv.js" onload="onOpenCVReady()">`
- App should work with brightness-only detection while OpenCV loads
- Set a global flag `cvReady` when OpenCV is loaded

### Tone.js Audio Context
- Web browsers require user gesture before audio can play
- On splash screen tap or first interaction, call `await Tone.start()`
- Create synths lazily after Tone.start()

### Performance (LIVE mode)
- Don't run detection on every frame — target 15fps for detection
- Use `requestAnimationFrame` for scan line animation (60fps visual)
- Run detection in a separate timing loop (every ~66ms)
- Downsample the detection region — don't analyze full-resolution pixels
- For OpenCV: process a downscaled version of the frame (e.g., 320x240)

### Single HTML File Structure
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Sound of Life</title>
  <style>
    /* All CSS here — mobile-first */
  </style>
</head>
<body>
  <!-- Splash screen -->
  <!-- Camera view + canvas overlay -->
  <!-- Bottom toolbar -->
  <!-- Settings panel -->

  <!-- CDN Scripts -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js"></script>
  <script async src="https://docs.opencv.org/4.9.0/opencv.js" onload="onOpenCVReady()"></script>
  
  <script>
    // All JavaScript here
  </script>
</body>
</html>
```

## Design Aesthetic

**Mood**: Cinematic, contemplative, poetic — matching the concept of "hearing nature's music"

**Color palette**:
- Background: deep black/dark slate for camera frame
- UI elements: translucent dark panels with subtle blur (backdrop-filter)
- Accent: warm gold (#D4A574) for active states and branding
- Staff lines: soft white with transparency
- Active notes: warm glow effect (gold → white radial gradient)
- Text: off-white (#F0EDE8) for readability

**Typography**:
- App title/branding: serif font — "Playfair Display" or "Cormorant Garamond" (from Google Fonts CDN)
- UI labels: system font stack for performance (-apple-system, etc.)

**Animations**:
- Splash screen: title fades in with subtle upward drift
- Note triggers: small burst/glow animation at note position
- Settings panel: slide in from right with ease-out
- Mode switch: smooth crossfade

## File Structure for Development

When developing locally with VS Code:
```
sound-of-life/
├── index.html          ← the single deliverable file (deployed to Cloudflare Pages)
├── _headers            ← Cloudflare Pages headers config (optional, for camera permissions)
├── dev/                ← development aids (not deployed)
│   ├── test-images/    ← sample photos for testing detection
│   └── notes.md        ← development log
└── SKILL.md            ← this file (for Claude Code reference, not deployed)
```

## Deployment

**Host**: Cloudflare Pages → `https://sound-of-life.phamhuutri.com`

Read `references/deployment.md` for complete step-by-step setup:
- GitHub repo connected to Cloudflare Pages for auto-deploy on push
- Custom subdomain `sound-of-life.phamhuutri.com` via CNAME to `sound-of-life.pages.dev`
- HTTPS auto-provisioned (required for camera API)
- Free tier: unlimited bandwidth

**Quick deploy workflow**:
1. Edit `index.html`
2. `git add . && git commit -m "message" && git push`
3. Auto-deploys in ~30 seconds

## Reference Files

For detailed implementation specifications, read the reference files:
- `references/detection-algorithm.md` — Full detection algorithm with code patterns
- `references/audio-system.md` — Tone.js instrument definitions and note mapping
- `references/staff-rendering.md` — Canvas drawing code for musical staff
- `references/ui-design.md` — Complete mobile-first UI/CSS specification
- `references/deployment.md` — Cloudflare Pages deploy + custom subdomain setup