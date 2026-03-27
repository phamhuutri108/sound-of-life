import * as Tone from 'tone';

export let audioReady = false;
export const instruments = { ambient: null, piano: null, marimba: null, kalimba: null };
export let currentInstrument = 'ambient';
export let currentScale = 'pentatonic';

export const SCALES = {
  pentatonic: { notes: ['C3','D3','E3','G3','A3','C4','D4','E4','G4','A4','C5','D5','E5'] },
  major:      { notes: ['C3','D3','E3','F3','G3','A3','B3','C4','D4','E4','F4','G4','A4'] },
  minor:      { notes: ['C3','D3','Eb3','F3','G3','Ab3','Bb3','C4','D4','Eb4','F4','G4','Ab4'] },
};

function createAmbientSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.15, decay: 0.4, sustain: 0.5, release: 2.0 },
    volume: -14,
  });
  const reverb = new Tone.Freeverb({ roomSize: 0.8, dampening: 4000 });
  reverb.wet.value = 0.5;
  const delay = new Tone.FeedbackDelay('8n', 0.2);
  delay.wet.value = 0.15;
  synth.chain(delay, reverb, Tone.Destination);
  return synth;
}

function createPianoSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.01, decay: 0.6, sustain: 0.2, release: 1.2 },
    volume: -10,
  });
  const reverb = new Tone.Freeverb({ roomSize: 0.5, dampening: 3000 });
  reverb.wet.value = 0.25;
  synth.connect(reverb);
  reverb.toDestination();
  return synth;
}

function createMarimbaSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.4, sustain: 0.01, release: 0.5 },
    volume: -8,
  });
  const reverb = new Tone.Freeverb({ roomSize: 0.4, dampening: 5000 });
  reverb.wet.value = 0.2;
  synth.connect(reverb);
  reverb.toDestination();
  return synth;
}

function createKalimbaSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle8' },
    envelope: { attack: 0.005, decay: 0.6, sustain: 0.1, release: 1.5 },
    volume: -10,
  });
  const reverb = new Tone.Freeverb({ roomSize: 0.65, dampening: 2500 });
  reverb.wet.value = 0.35;
  synth.connect(reverb);
  reverb.toDestination();
  return synth;
}

export function setupInstruments() {
  instruments.ambient  = createAmbientSynth();
  instruments.piano    = createPianoSynth();
  instruments.marimba  = createMarimbaSynth();
  instruments.kalimba  = createKalimbaSynth();
}

export function initAudio() {
  if (audioReady) return;
  // Must be called synchronously within user gesture (iOS Safari requirement)
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
    synth.triggerAttackRelease(note, '8n', Tone.now(), velocity);
  }
}

export function getNoteForPosition(idx) {
  const notes = SCALES[currentScale].notes;
  return notes[Math.min(idx, notes.length - 1)];
}

export function confidenceToVelocity(conf) {
  return 0.3 + conf * 0.6;
}

export function releaseAllInstruments() {
  Object.values(instruments).forEach(s => s && s.releaseAll());
}

export function isAudioReady() {
  return audioReady;
}
