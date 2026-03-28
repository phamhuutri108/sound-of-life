import * as Tone from 'tone';

export let audioReady = false;
export const instruments = { ambient: null, piano: null, marimba: null, kalimba: null, flute: null, pluck: null, harpsichord: null, vibraphone: null, pad: null, wanderer: null };

// Mobile detection — used to reduce DSP load (reverb wet/roomSize) and lower lookAhead
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');

// On mobile, reduce reverb wetness and room size to cut CPU load significantly.
// On very low-end mobile (< 4 cores) skip reverb entirely.
const mobileReverbScale = (navigator.hardwareConcurrency || 4) < 4 ? 0 : 0.32; // 0.32 = lighter reverb tail
function _rv(roomSize, wet, dampening) {
  const r = new Tone.Freeverb({
    roomSize: isMobile ? Math.min(roomSize * 0.40, 0.22) : roomSize, // smaller room = fewer comb filter ops
    dampening: isMobile ? Math.min(dampening * 1.4, 7000) : dampening,
  });
  r.wet.value = isMobile ? wet * mobileReverbScale : wet;
  return r;
}
function _poly(mobile, desktop) { return isMobile ? mobile : desktop; }

// How long each note gate stays open — affects sustained instruments most
const INSTRUMENT_NOTE_DURATIONS = {
  theremin: '4n',  // long sustain notes slide into each other
  pad:      '2n',  // needs time for attack (0.4 s) to bloom
};

// Minimum note duration per instrument — must be ≥ attack time so the note
// is audible before the envelope releases. Short runs on slow-attack instruments
// were previously silent because Math.max(0.08, dur) < attack time.
const INSTRUMENT_MIN_DURATION = {
  pad:      0.18,  // attack 0.10 — give a bit of sustain headroom
  theremin: 0.25,  // attack 0.15
  ambient:  0.22,  // attack 0.12
};
export let currentInstrument = 'wanderer';
export let currentScale = 'major';

export const SCALES = {
  major: { notes: ['C4','D4','E4','F4','G4','A4','B4','C5','D5','E5','F5','G5','A5'] },
};

// Master bus: compressor + limiter prevents clipping/distortion
let masterBus = null;

function createMasterBus() {
  // Lower threshold so compressor catches dynamics before makeup gain amplifies them
  const comp = new Tone.Compressor({ threshold: -24, ratio: 5, attack: 0.005, release: 0.1 });
  // Makeup gain boosts overall loudness for outdoor/speaker use
  const makeupGain = new Tone.Volume(10);
  // Limiter raised to -1 dB — lets signal go louder while still preventing clipping
  const limiter = new Tone.Limiter(-1);
  comp.chain(makeupGain, limiter, Tone.getDestination());
  return comp; // connect instruments → comp
}

function createAmbientSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.03, decay: 0.3, sustain: 0.5, release: 2.0 },
    volume: -8,
  });
  synth.maxPolyphony = _poly(2, 4);
  const reverb = _rv(0.75, 0.45, 4000);
  synth.chain(reverb, masterBus);
  return synth;
}

function createPianoSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.01, decay: 0.5, sustain: 0.15, release: 0.8 },
    volume: -8,
  });
  synth.maxPolyphony = _poly(2, 4);
  const reverb = _rv(0.4, 0.2, 3500);
  synth.chain(reverb, masterBus);
  return synth;
}

function createMarimbaSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.35, sustain: 0.0, release: 0.4 },
    volume: -6,
  });
  synth.maxPolyphony = _poly(2, 4);
  const reverb = _rv(0.35, 0.15, 5000);
  synth.chain(reverb, masterBus);
  return synth;
}

function createKalimbaSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle8' },
    envelope: { attack: 0.005, decay: 0.5, sustain: 0.05, release: 1.2 },
    volume: -5,
  });
  synth.maxPolyphony = _poly(2, 4);
  const reverb = _rv(0.55, 0.3, 2500);
  synth.chain(reverb, masterBus);
  return synth;
}

function createFluteSynth() {
  // Ghibli-style pan flute: soft sine + vibrato + airy reverb
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.12, decay: 0.1, sustain: 0.75, release: 1.2 },
    volume: -5,
  });
  synth.maxPolyphony = _poly(2, 3);
  const reverb = _rv(0.72, 0.42, 1800);
  // Skip Vibrato on mobile — adds DSP overhead with minimal audible benefit at low polyphony
  if (isMobile) {
    synth.chain(reverb, masterBus);
  } else {
    const vibrato = new Tone.Vibrato({ frequency: 5.5, depth: 0.09, type: 'sine' });
    synth.chain(vibrato, reverb, masterBus);
  }
  return synth;
}

function createPluckSynth() {
  // Synth pluck: electric-piano/bell-like, snappy and staccato
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'square4' },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0.0, release: 0.2 },
    volume: -8,
  });
  synth.maxPolyphony = _poly(2, 4);
  const reverb = _rv(0.15, 0.08, 8000);
  synth.chain(reverb, masterBus);
  return synth;
}

function createHarpsichordSynth() {
  // Harpsichord / pizzicato: bright sawtooth pluck, crisp and classical
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.005, decay: 0.45, sustain: 0.0, release: 0.15 },
    volume: -6,
  });
  synth.maxPolyphony = _poly(2, 4);
  const reverb = _rv(0.2, 0.1, 7000);
  synth.chain(reverb, masterBus);
  return synth;
}

function createVibraphoneSynth() {
  // Vibraphone: FM synthesis for metallic bell resonance
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 5,
    modulationIndex: 1.5,
    oscillator: { type: 'sine' },
    modulation: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.9, sustain: 0.08, release: 1.8 },
    modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0.0, release: 0.25 },
    volume: -8,
  });
  synth.maxPolyphony = _poly(2, 4);
  const reverb = _rv(0.65, 0.4, 2000);
  synth.chain(reverb, masterBus);
  return synth;
}

function createThereminSynth() {
  // Theremin: pure sine with vibrato + portamento for sliding feel
  const synth = new Tone.PolySynth(Tone.Synth, {
    portamento: 0.12,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.15, decay: 0.05, sustain: 0.9, release: 0.8 },
    volume: -5,
  });
  synth.maxPolyphony = 2;
  const reverb = _rv(0.5, 0.3, 2200);
  // Skip Vibrato on mobile
  if (isMobile) {
    synth.chain(reverb, masterBus);
  } else {
    const vibrato = new Tone.Vibrato({ frequency: 5.5, depth: 0.08, type: 'sine' });
    synth.chain(vibrato, reverb, masterBus);
  }
  return synth;
}

function createWandererSynth() {
  if (isMobile) {
    // Mobile: PolySynth with sine4 (4 partials via native OscillatorNode — no FM overhead).
    // Gives bright bell overtones without the carrier+modulator DSP cost of FMSynth.
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine4' },
      envelope: { attack: 0.001, decay: 0.45, sustain: 0.0, release: 1.5 },
      volume: -6,
    });
    synth.maxPolyphony = 2;
    const reverb = _rv(0.82, 0.58, 900);
    synth.chain(reverb, masterBus);
    return synth;
  }
  // Desktop: full FMSynth with high harmonicity for rich metallic ring.
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 5.1,
    modulationIndex: 10,
    oscillator: { type: 'sine' },
    modulation: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.5, sustain: 0.0, release: 1.8 },
    modulationEnvelope: { attack: 0.001, decay: 0.12, sustain: 0.0, release: 0.12 },
    volume: -6,
  });
  synth.maxPolyphony = 5;
  const reverb = _rv(0.88, 0.62, 900);
  synth.chain(reverb, masterBus);
  return synth;
}

function createPadSynth() {
  // Synth Pad: lush sawtooth + chorus + heavy reverb, spacious ambient
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sawtooth4' },
    envelope: { attack: 0.10, decay: 0.6, sustain: 0.7, release: 3.5 },
    volume: -8,
  });
  synth.maxPolyphony = _poly(2, 3);
  const reverb = _rv(0.9, 0.65, 1500);
  // Skip Chorus on mobile — it adds two delay lines and an LFO
  if (isMobile) {
    synth.chain(reverb, masterBus);
  } else {
    const chorus = new Tone.Chorus({ frequency: 2.5, delayTime: 3.5, depth: 0.7, wet: 0.5 });
    synth.chain(chorus, reverb, masterBus);
  }
  return synth;
}

const _instrumentFactories = {
  wanderer:    createWandererSynth,
  ambient:     createAmbientSynth,
  piano:       createPianoSynth,
  marimba:     createMarimbaSynth,
  kalimba:     createKalimbaSynth,
  flute:       createFluteSynth,
  pluck:       createPluckSynth,
  harpsichord: createHarpsichordSynth,
  vibraphone:  createVibraphoneSynth,
  pad:         createPadSynth,
};

// Ensure the instrument for `name` exists; create it lazily if not.
function ensureInstrument(name) {
  if (!instruments[name] && _instrumentFactories[name]) {
    instruments[name] = _instrumentFactories[name]();
  }
}

let _keepAlive = null;
function _startKeepAlive() {
  if (_keepAlive) return;
  try {
    // A sub-audio-frequency silent oscillator keeps the iOS AudioContext in 'running'
    // state — without it iOS suspends the context after ~30 s of silence.
    _keepAlive = new Tone.Oscillator(1, 'sine'); // 1 Hz — completely inaudible
    _keepAlive.volume.value = -Infinity;
    _keepAlive.toDestination();
    _keepAlive.start();
  } catch (_) {}
}

export function setupInstruments() {
  masterBus = createMasterBus();
  // On mobile: only create the default instrument now — others are created on first use.
  // On desktop: create all upfront for zero latency when switching.
  if (isMobile) {
    ensureInstrument(currentInstrument);
  } else {
    Object.keys(_instrumentFactories).forEach(n => ensureInstrument(n));
  }
  _startKeepAlive();
}

export function initAudio() {
  if (audioReady) return;
  Tone.start().then(() => {
    // Reduce scheduling look-ahead on mobile: default 0.1 s adds 100 ms of extra latency.
    // 0.05 s is still safe (2–3 audio buffer lengths) and halves perceived delay.
    if (isMobile) Tone.getContext().lookAhead = 0.002;
    audioReady = true;
    setupInstruments();
  }).catch(err => console.warn('Audio init error:', err));
}

export function tryUnlockAudio() {
  if (!audioReady) {
    Tone.start().then(() => {
      if (isMobile) Tone.getContext().lookAhead = 0.002;
      audioReady = true;
      if (!masterBus) setupInstruments();
    }).catch(() => {});
  }
}

export function switchInstrument(name) {
  const prev = currentInstrument;
  if (instruments[prev]) instruments[prev].releaseAll();
  currentInstrument = name;
  // Lazy-create the instrument if not yet built (mobile path)
  if (masterBus) ensureInstrument(name);

  // On mobile: dispose the previous instrument's entire Web Audio subgraph after its
  // release envelope finishes. Without this, every switch leaves a Freeverb chain
  // (8 comb + 4 allpass filters) running silently → CPU/heat builds up → crackling.
  // 4 s covers the longest release envelope (pad: 3.5 s).
  if (isMobile && prev !== name) {
    const stale = instruments[prev];
    if (stale) {
      instruments[prev] = null; // next ensureInstrument() recreates fresh
      setTimeout(() => { try { stale.dispose(); } catch (_) {} }, 4000);
    }
  }
}

export function setInstrument(name) {
  switchInstrument(name);
  document.querySelectorAll('[id^="btn-inst-"]').forEach(b => b.classList.remove('active'));
  const instBtn = document.getElementById('btn-inst-' + name);
  if (instBtn) instBtn.classList.add('active');
}

export function setScale(name) {
  currentScale = name;
  document.querySelectorAll('[id^="btn-scale-"]').forEach(b => b.classList.remove('active'));
  const scaleBtn = document.getElementById('btn-scale-' + name);
  if (scaleBtn) scaleBtn.classList.add('active');
}

/** Resume context if suspended — call from animation loop or on touch events. */
export function resumeAudioIfSuspended() {
  if (!audioReady) return;
  const state = Tone.getContext().state;
  if (state === 'suspended' || state === 'interrupted') {
    Tone.getContext().resume().catch(() => {});
  }
}

/**
 * @param {string}      note        - Tone.js pitch string, e.g. "C4"
 * @param {number}      velocity    - 0–1
 * @param {number|null} durationSecs - if provided, note holds for this many seconds
 *                                    (object-width derived); otherwise uses instrument default
 */
export function playNote(note, velocity = 0.7, durationSecs = null) {
  const synth = instruments[currentInstrument];
  if (!synth || !audioReady) return;
  // iOS can suspend the AudioContext after inactivity; resume and drop this note
  // (context will be running for the next detection cycle ~300 ms later).
  if (Tone.getContext().state !== 'running') {
    Tone.getContext().resume().catch(() => {});
    return;
  }
  const minDur = INSTRUMENT_MIN_DURATION[currentInstrument] ?? 0.08;
  const dur = durationSecs != null
    ? Math.max(minDur, durationSecs) + 's'
    : (INSTRUMENT_NOTE_DURATIONS[currentInstrument] || '8n');
  synth.triggerAttackRelease(note, dur, Tone.now(), Math.min(1.0, velocity));
}

export function getNoteForPosition(idx) {
  const notes = SCALES[currentScale].notes;
  return notes[Math.min(idx, notes.length - 1)];
}

export function confidenceToVelocity(conf) {
  return 0.42 + conf * 0.38;
}

export function releaseAllInstruments() {
  Object.values(instruments).forEach(s => s && s.releaseAll());
}

export function isAudioReady() {
  return audioReady;
}
