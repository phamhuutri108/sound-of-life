# Audio System — Sound of Life

## Tone.js Setup

Load from CDN: `https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js`

### Initialization

Audio context MUST be started after a user gesture (browser requirement):

```javascript
let audioReady = false;

async function initAudio() {
  await Tone.start();
  audioReady = true;
  setupInstruments();
}

// Call on first user tap (splash screen button, etc.)
document.getElementById('startBtn').addEventListener('click', async () => {
  await initAudio();
});
```

## Instrument Definitions

### 1. Ambient Synth
Soft, atmospheric, nature-like. Long release, reverb-heavy.

```javascript
function createAmbientSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 13,
    voice: Tone.Synth,
    options: {
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.15,
        decay: 0.4,
        sustain: 0.5,
        release: 2.0,
      },
      volume: -14,
    },
  });

  const reverb = new Tone.Reverb({ decay: 4, wet: 0.5 });
  const delay = new Tone.FeedbackDelay('8n', 0.2);
  delay.wet.value = 0.15;

  synth.chain(delay, reverb, Tone.Destination);
  return synth;
}
```

### 2. Piano
AM synthesis for piano-like timbre. Fast attack, moderate decay.

```javascript
function createPianoSynth() {
  const synth = new Tone.PolySynth(Tone.AMSynth, {
    maxPolyphony: 13,
    voice: Tone.AMSynth,
    options: {
      harmonicity: 2,
      oscillator: { type: 'triangle' },
      envelope: {
        attack: 0.01,
        decay: 0.8,
        sustain: 0.2,
        release: 1.0,
      },
      modulation: { type: 'square' },
      modulationEnvelope: {
        attack: 0.5,
        decay: 0.1,
        sustain: 0.3,
        release: 0.5,
      },
      volume: -10,
    },
  });

  const reverb = new Tone.Reverb({ decay: 2, wet: 0.25 });
  synth.connect(reverb);
  reverb.toDestination();
  return synth;
}
```

### 3. Marimba / Xylophone
FM synthesis for percussive, wooden tone. Very short decay.

```javascript
function createMarimbaSynth() {
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    maxPolyphony: 13,
    voice: Tone.FMSynth,
    options: {
      harmonicity: 3.5,
      modulationIndex: 10,
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.001,
        decay: 0.4,
        sustain: 0.01,
        release: 0.5,
      },
      modulation: { type: 'triangle' },
      modulationEnvelope: {
        attack: 0.001,
        decay: 0.2,
        sustain: 0.01,
        release: 0.3,
      },
      volume: -8,
    },
  });

  const reverb = new Tone.Reverb({ decay: 1.5, wet: 0.2 });
  synth.connect(reverb);
  reverb.toDestination();
  return synth;
}
```

### 4. Kalimba
Metal synth or triangle wave with characteristic metallic warmth.

```javascript
function createKalimbaSynth() {
  const synth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 13,
    voice: Tone.Synth,
    options: {
      oscillator: { type: 'triangle8' },
      envelope: {
        attack: 0.005,
        decay: 0.6,
        sustain: 0.1,
        release: 1.5,
      },
      volume: -10,
    },
  });

  const reverb = new Tone.Reverb({ decay: 2.5, wet: 0.35 });
  const chorus = new Tone.Chorus(4, 2.5, 0.5).start();
  chorus.wet.value = 0.15;

  synth.chain(chorus, reverb, Tone.Destination);
  return synth;
}
```

## Instrument Manager

```javascript
const instruments = {
  ambient: null,
  piano: null,
  marimba: null,
  kalimba: null,
};

let currentInstrument = 'ambient';

function setupInstruments() {
  instruments.ambient = createAmbientSynth();
  instruments.piano = createPianoSynth();
  instruments.marimba = createMarimbaSynth();
  instruments.kalimba = createKalimbaSynth();
}

function switchInstrument(name) {
  // Release any playing notes on current instrument
  if (instruments[currentInstrument]) {
    instruments[currentInstrument].releaseAll();
  }
  currentInstrument = name;
}

function playNote(note, duration = '8n', velocity = 0.7) {
  const synth = instruments[currentInstrument];
  if (synth && audioReady) {
    synth.triggerAttackRelease(note, duration, Tone.now(), velocity);
  }
}
```

## Scale Definitions

```javascript
const SCALES = {
  pentatonic: {
    // C pentatonic: C D E G A — extended over 2+ octaves
    notes: ['C3','D3','E3','G3','A3','C4','D4','E4','G4','A4','C5','D5','E5'],
    label: { en: 'Pentatonic', vi: 'Ngũ cung' },
  },
  major: {
    // C major: C D E F G A B
    notes: ['C3','D3','E3','F3','G3','A3','B3','C4','D4','E4','F4','G4','A4'],
    label: { en: 'Major', vi: 'Trưởng' },
  },
  minor: {
    // C natural minor: C D Eb F G Ab Bb
    notes: ['C3','D3','Eb3','F3','G3','Ab3','Bb3','C4','D4','Eb4','F4','G4','Ab4'],
    label: { en: 'Minor', vi: 'Thứ' },
  },
};

let currentScale = 'pentatonic';

function getCurrentNotes() {
  return SCALES[currentScale].notes;
}
```

## Note Position Mapping

13 note positions on the staff (bottom to top) map to 13 notes in the chosen scale.
Position 0 = bottom = lowest note. Position 12 = top = highest note.

```javascript
function getNoteForPosition(positionIndex) {
  const notes = getCurrentNotes();
  return notes[Math.min(positionIndex, notes.length - 1)];
}
```

## Volume by Confidence

Detection confidence (0-1) maps to velocity:

```javascript
function confidenceToVelocity(confidence) {
  // Map 0-1 confidence to 0.3-0.9 velocity
  return 0.3 + confidence * 0.6;
}
```

## Cleanup

When switching modes or leaving the app:

```javascript
function cleanupAudio() {
  Object.values(instruments).forEach(synth => {
    if (synth) synth.releaseAll();
  });
}
```
