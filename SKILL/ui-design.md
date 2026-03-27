# UI Design — Sound of Life

## Mobile-First Philosophy

This app is primarily used on phones. Every design decision starts with mobile:
- Touch targets minimum 44×44px
- No hover states as primary interaction (use as enhancement only)
- Full-screen experience — no browser chrome distraction
- Portrait AND landscape support (camera works in both)
- Avoid text-heavy UI — use icons with labels
- Settings panel slides over content (not a separate page)
- Bottom toolbar for thumb-reachable actions

## Viewport & Meta Tags

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0a0a0f">
```

## Color System

```css
:root {
  /* Core */
  --bg-deep: #0a0a0f;
  --bg-panel: rgba(15, 15, 25, 0.85);
  --bg-panel-solid: #0f0f19;
  
  /* Text */
  --text-primary: #f0ede8;
  --text-secondary: rgba(240, 237, 232, 0.6);
  --text-muted: rgba(240, 237, 232, 0.35);
  
  /* Accent */
  --accent-gold: #d4a574;
  --accent-gold-bright: #e8c49a;
  --accent-gold-dim: rgba(212, 165, 116, 0.3);
  
  /* Functional */
  --border-subtle: rgba(255, 255, 255, 0.08);
  --border-active: rgba(212, 165, 116, 0.4);
  
  /* Staff */
  --staff-line: rgba(255, 255, 255, 0.55);
  --scan-line: rgba(255, 255, 255, 0.9);
  --note-glow: rgba(212, 165, 116, 0.8);
  --note-active: rgba(255, 240, 220, 0.9);
}
```

## Typography

```css
/* Load via Google Fonts CDN */
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap');

:root {
  --font-display: 'Cormorant Garamond', 'Georgia', serif;
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
```

## Screen Layouts

### 1. Splash Screen

Full-screen centered branding. Dark background with subtle atmosphere.

```
┌──────────────────────┐
│                      │
│                      │
│    Sound of Life     │  ← Cormorant Garamond, 36px, gold
│                      │
│  Every moment has    │  ← Cormorant Garamond italic, 16px, muted
│    its melody        │
│                      │
│                      │
│   [ ▶ Start ]        │  ← pill button, gold border, 48px tall
│                      │
│                      │
│  🌐 EN | VI          │  ← language toggle, bottom
└──────────────────────┘
```

```css
.splash {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg-deep);
  z-index: 100;
}

.splash-title {
  font-family: var(--font-display);
  font-size: clamp(28px, 8vw, 48px);
  color: var(--accent-gold);
  letter-spacing: 0.05em;
  animation: fadeInUp 1.2s ease-out;
}

.splash-subtitle {
  font-family: var(--font-display);
  font-style: italic;
  font-size: clamp(14px, 3.5vw, 18px);
  color: var(--text-muted);
  margin-top: 12px;
  animation: fadeInUp 1.2s ease-out 0.3s both;
}

.splash-start-btn {
  margin-top: 48px;
  padding: 14px 48px;
  border: 1.5px solid var(--accent-gold);
  border-radius: 100px;
  background: transparent;
  color: var(--accent-gold);
  font-family: var(--font-ui);
  font-size: 16px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.3s ease;
  animation: fadeInUp 1.2s ease-out 0.6s both;
}

.splash-start-btn:active {
  background: var(--accent-gold);
  color: var(--bg-deep);
}

@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
```

### 2. Mode Selection

After splash, brief mode selection. Can be skipped (default to PHOTO).

```
┌──────────────────────┐
│                      │
│   Choose your mode   │
│                      │
│  ┌────────────────┐  │
│  │   📸 PHOTO     │  │  ← card, full width
│  │   Capture &    │  │
│  │   compose      │  │
│  └────────────────┘  │
│                      │
│  ┌────────────────┐  │
│  │   🎬 LIVE      │  │  ← card, full width
│  │   Real-time    │  │
│  │   melody       │  │
│  └────────────────┘  │
│                      │
└──────────────────────┘
```

### 3. Main Camera View

Full-screen camera with overlay UI:

```
┌──────────────────────────────┐
│ ⚙️                    🔄    │  ← top bar (settings, camera flip)
│                              │
│                              │
│    ═══════════════════       │  ← staff line 5
│                              │
│    ═══════════════════       │  ← staff line 4
│     │                        │  ← scan line (vertical)
│  𝄞  ═══════════════════     │  ← staff line 3 + treble clef
│     │  ●                     │  ← detected note (glow)
│    ═══════════════════       │  ← staff line 2
│     │                        │
│    ═══════════════════       │  ← staff line 1
│                              │
│                              │
│                              │
│──────────────────────────────│
│  [📸 Capture]  [▶ Play]  [≡]│  ← bottom toolbar
└──────────────────────────────┘
```

```css
.camera-view {
  position: fixed;
  inset: 0;
  background: black;
  overflow: hidden;
}

.camera-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.staff-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* Photo preview */
.photo-preview {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
}
```

### 4. Bottom Toolbar

```css
.bottom-toolbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 12px 16px;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  background: var(--bg-panel);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid var(--border-subtle);
  z-index: 50;
}

.toolbar-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 16px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: 11px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.2s;
}

.toolbar-btn.active {
  color: var(--accent-gold);
}

.toolbar-btn-icon {
  font-size: 24px;
  line-height: 1;
}

/* Capture button — special large circular button */
.capture-btn {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 3px solid var(--text-primary);
  background: transparent;
  position: relative;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.capture-btn::after {
  content: '';
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  background: var(--text-primary);
  transition: transform 0.15s;
}

.capture-btn:active::after {
  transform: scale(0.85);
}
```

### 5. Settings Panel

Slides in from the right side:

```css
.settings-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(320px, 85vw);
  background: var(--bg-panel-solid);
  border-left: 1px solid var(--border-subtle);
  transform: translateX(100%);
  transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 60;
  overflow-y: auto;
  padding: 20px;
  padding-top: max(20px, env(safe-area-inset-top));
}

.settings-panel.open {
  transform: translateX(0);
}

.settings-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.35s;
  z-index: 55;
}

.settings-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}
```

#### Settings Controls

**Instrument Picker** — horizontal segmented control:

```css
.setting-group {
  margin-bottom: 24px;
}

.setting-label {
  font-family: var(--font-ui);
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 10px;
}

.segment-control {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 10px;
  padding: 4px;
}

.segment-btn {
  padding: 10px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  -webkit-tap-highlight-color: transparent;
}

.segment-btn.active {
  background: var(--accent-gold-dim);
  color: var(--accent-gold-bright);
}
```

**Slider Controls** (speed, sensitivity):

```css
.slider-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.slider-control input[type="range"] {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  outline: none;
}

.slider-control input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent-gold);
  cursor: pointer;
}

.slider-label-left,
.slider-label-right {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 32px;
}
```

### 6. Top Bar (minimal overlay)

```css
.top-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  padding-top: max(12px, env(safe-area-inset-top));
  z-index: 40;
}

.top-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
  color: var(--text-primary);
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
```

### 7. Loading / OpenCV Status

Small indicator showing OpenCV load status:

```css
.opencv-status {
  position: fixed;
  top: max(16px, env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 100px;
  background: var(--bg-panel);
  backdrop-filter: blur(10px);
  font-family: var(--font-ui);
  font-size: 11px;
  color: var(--text-muted);
  z-index: 45;
  transition: opacity 0.5s;
}

.opencv-status.loaded {
  opacity: 0;
  pointer-events: none;
}
```

## Responsive Breakpoints

```css
/* Landscape phone */
@media (orientation: landscape) and (max-height: 500px) {
  .bottom-toolbar {
    /* Move to right side in landscape */
    bottom: auto;
    right: 0;
    top: 0;
    left: auto;
    width: 72px;
    height: 100%;
    flex-direction: column;
    padding: 16px 8px;
    border-top: none;
    border-left: 1px solid var(--border-subtle);
  }
  
  .capture-btn {
    width: 52px;
    height: 52px;
  }
}

/* Tablet / Desktop */
@media (min-width: 768px) {
  .settings-panel {
    width: 360px;
  }
  
  .splash-title {
    font-size: 56px;
  }
}
```

## Animations

```css
/* Note trigger pulse */
@keyframes notePulse {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.5); opacity: 0.7; }
  100% { transform: scale(2); opacity: 0; }
}

/* Scan line glow */
@keyframes scanGlow {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

/* Settings slide in */
@keyframes slideInRight {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

/* Mode card entrance */
@keyframes cardEnter {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
```

## Safe Area Handling (iPhone notch)

```css
/* Already handled via env(safe-area-inset-*) in toolbar and top bar */
/* Ensure body fills viewport */
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-deep);
  color: var(--text-primary);
  font-family: var(--font-ui);
  -webkit-font-smoothing: antialiased;
}

/* Prevent pull-to-refresh on mobile */
body {
  overscroll-behavior: none;
  touch-action: manipulation;
}

/* Prevent text selection on UI elements */
button, .toolbar-btn, .segment-btn, .top-btn {
  -webkit-user-select: none;
  user-select: none;
}
```
