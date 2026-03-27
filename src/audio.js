import * as Tone from 'tone';

export let audioReady = false;
export const instruments = { ambient: null, piano: null, marimba: null, kalimba: null, flute: null };
export let currentInstrument = 'ambient';
export let currentScale = 'pentatonic';

export const SCALES = {
  pentatonic: { notes: ['C4','D4','E4','G4','A4','C5','D5','E5','G5','A5','C6','D6','E6'] },
  major:      { notes: ['C4','D4','E4','F4','G4','A4','B4','C5','D5','E5','F5','G5','A5'] },
  minor:      { notes: ['C4','D4','Eb4','F4','G4','Ab4','Bb4','C5','D5','Eb5','F5','G5','Ab5'] },
};

// Master bus: compressor + limiter prevents clipping/distortion
let masterBus = null;

function createMasterBus() {
  const comp = new Tone.Compressor({ threshold: -18, ratio: 4, attack: 0.005, release: 0.1 });
  const limiter = new Tone.Limiter(-3);
  comp.chain(limiter, Tone.getDestination());
  return comp; // connect instruments → comp
}

function createAmbientSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.2, decay: 0.3, sustain: 0.5, release: 2.0 },
    volume: -18,
  });
  synth.maxPolyphony = 4;
  const reverb = new Tone.Freeverb({ roomSize: 0.75, dampening: 4000 });
  reverb.wet.value = 0.45;
  synth.chain(reverb, masterBus);
  return synth;
}

function createPianoSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.01, decay: 0.5, sustain: 0.15, release: 0.8 },
    volume: -14,
  });
  synth.maxPolyphony = 4;
  const reverb = new Tone.Freeverb({ roomSize: 0.4, dampening: 3500 });
  reverb.wet.value = 0.2;
  synth.chain(reverb, masterBus);
  return synth;
}

function createMarimbaSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.35, sustain: 0.0, release: 0.4 },
    volume: -12,
  });
  synth.maxPolyphony = 4;
  const reverb = new Tone.Freeverb({ roomSize: 0.35, dampening: 5000 });
  reverb.wet.value = 0.15;
  synth.chain(reverb, masterBus);
  return synth;
}

function createKalimbaSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle8' },
    envelope: { attack: 0.005, decay: 0.5, sustain: 0.05, release: 1.2 },
    volume: -14,
  });
  synth.maxPolyphony = 4;
  const reverb = new Tone.Freeverb({ roomSize: 0.55, dampening: 2500 });
  reverb.wet.value = 0.3;
  synth.chain(reverb, masterBus);
  return synth;
}

function createFluteSynth() {
  // Ghibli-style pan flute: soft sine + vibrato + airy reverb
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.12, decay: 0.1, sustain: 0.75, release: 1.2 },
    volume: -15,
  });
  synth.maxPolyphony = 3;
  const vibrato = new Tone.Vibrato({ frequency: 5.5, depth: 0.09, type: 'sine' });
  const reverb = new Tone.Freeverb({ roomSize: 0.72, dampening: 1800 });
  reverb.wet.value = 0.42;
  synth.chain(vibrato, reverb, masterBus);
  return synth;
}

export function setupInstruments() {
  masterBus = createMasterBus();
  instruments.ambient  = createAmbientSynth();
  instruments.piano    = createPianoSynth();
  instruments.marimba  = createMarimbaSynth();
  instruments.kalimba  = createKalimbaSynth();
  instruments.flute    = createFluteSynth();
}

export function initAudio() {
  if (audioReady) return;
  Tone.start().then(() => {
    audioReady = true;
    setupInstruments();
  }).catch(err => console.warn('Audio init error:', err));
}

export function tryUnlockAudio() {
  if (!audioReady) {
    Tone.start().then(() => {
      audioReady = true;
      if (!instruments.ambient) setupInstruments();
    }).catch(() => {});
  }
}

export function switchInstrument(name) {
  if (instruments[currentInstrument]) instruments[currentInstrument].releaseAll();
  currentInstrument = name;
}

export function setInstrument(name) {
  switchInstrument(name);
  document.querySelectorAll('[id^="btn-inst-"]').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-inst-' + name).classList.add('active');
}

export function setScale(name) {
  currentScale = name;
  document.querySelectorAll('[id^="btn-scale-"]').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-scale-' + name).classList.add('active');
}

export function playNote(note, velocity = 0.7) {
  const synth = instruments[currentInstrument];
  if (synth && audioReady) {
    synth.triggerAttackRelease(note, '8n', Tone.now(), Math.min(0.85, velocity));
  }
}

export function getNoteForPosition(idx) {
  const notes = SCALES[currentScale].notes;
  return notes[Math.min(idx, notes.length - 1)];
}

export function confidenceToVelocity(conf) {
  return 0.35 + conf * 0.5;
}

export function releaseAllInstruments() {
  Object.values(instruments).forEach(s => s && s.releaseAll());
}

export function isAudioReady() {
  return audioReady;
}
