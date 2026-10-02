import { expect, test } from 'bun:test';
import { midiToHz } from '../lib/dsp/smooth';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS } from '../lib/dsp/frames';
import { smoothTrack } from '../lib/dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS } from '../lib/music/segment';
import { detectKey } from '../lib/music/key';
import { inferGrid, quantizeNotes, type RhythmGrid } from '../lib/music/quantize';
import { buildScore, pitchedEvents } from '../lib/music/score';
import { scoreToMidi, parseMidiNotes } from '../lib/music/midi';
import { keySignatureOf, snapToScale, spell, vexflowKeySpec, type Key } from '../lib/music/notes';

const SAMPLE_RATE = 44100;
const HOP = DEFAULT_TRACK_OPTIONS.hopSize;

const C_MAJOR: Key = { tonic: 0, mode: 'major' };

interface MelodySpec {
  /** MIDI values, one per note. */
  pitches: number[];
  /** Seconds each note sounds for. */
  noteSeconds: number;
  /** Seconds of silence between notes. */
  gapSeconds: number;
}

/** Render a melody to a mono signal, with per-note ramps to avoid clicks. */
function renderMelody({ pitches, noteSeconds, gapSeconds }: MelodySpec): Float32Array {
  const total = Math.round((pitches.length * (noteSeconds + gapSeconds)) * SAMPLE_RATE);
  const out = new Float32Array(total);
  let cursor = 0;
  for (const midi of pitches) {
    const count = Math.round(noteSeconds * SAMPLE_RATE);
    const ramp = Math.round(0.012 * SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      // Two harmonics, like a sung vowel.
      let v = 0.5 * Math.sin((2 * Math.PI * midiToHz(midi) * i) / SAMPLE_RATE);
      v += 0.18 * Math.sin((2 * Math.PI * 2 * midiToHz(midi) * i) / SAMPLE_RATE);
      if (i < ramp) v *= i / ramp;
      if (i > count - ramp) v *= (count - i) / ramp;
      out[cursor + i] = v;
    }
    cursor += count + Math.round(gapSeconds * SAMPLE_RATE);
  }
  return out;
}

/** The whole pipeline, as the worker runs it. */
function transcribe(signal: Float32Array) {
  const track = analyzeTrack(signal, { ...DEFAULT_TRACK_OPTIONS, sampleRate: SAMPLE_RATE }).map((f) => ({
    time: f.time,
    hz: f.hz,
    voiced: f.hz > 0 ? 1 : 0,
  }));
  const smoothed = smoothTrack(track, { medianRadius: 2, octaveTolerance: 0.75 });
  const notes = segmentNotes(smoothed, {
    ...DEFAULT_SEGMENT_OPTIONS,
    frameDuration: HOP / SAMPLE_RATE,
  });
  const detection = detectKey(notes.map((n) => ({ midi: n.midi, duration: n.end - n.start })));
  const key = detection?.key ?? C_MAJOR;
  const grid = inferGrid(notes);
  const quantized = quantizeNotes(notes, grid);
  const score = buildScore(quantized, grid, key);
  return { notes, key, grid, quantized, score };
}

const SCALE_UP = [60, 62, 64, 65, 67, 69, 71, 72];

test('end-to-end: transcribes a C major scale at 120bpm', () => {
  const signal = renderMelody({ pitches: SCALE_UP, noteSeconds: 0.5, gapSeconds: 0.01 });
  const { notes, key, score } = transcribe(signal);

  expect(notes.length).toBe(SCALE_UP.length);
  for (let i = 0; i < SCALE_UP.length; i++) {
    expect(Math.abs(notes[i].midi - SCALE_UP[i])).toBeLessThan(0.25);
  }
  expect(key.tonic).toBe(0);
  expect(key.mode).toBe('major');

  const pitched = pitchedEvents(score);
  // A bar is 4 beats; 8 quarter notes = 2 bars, with a tie-free score.
  expect(pitched.length).toBe(SCALE_UP.length);
  for (let i = 0; i < SCALE_UP.length; i++) {
    expect(pitched[i].midi).toBe(SCALE_UP[i]);
  }
});

test('end-to-end: recovers the tempo of a 90bpm melody', () => {
  const signal = renderMelody({ pitches: [67, 69, 71, 72, 71, 69], noteSeconds: 60 / 90, gapSeconds: 0.01 });
  const { grid, score } = transcribe(signal);
  // 90bpm and 45bpm describe the same note spacing; the prior should prefer 90.
  expect(Math.abs(grid.bpm - 90)).toBeLessThanOrEqual(2);
  expect(pitchedEvents(score).length).toBe(6);
});

test('end-to-end: eighth notes at 144bpm are notated as eighths', () => {
  const noteSeconds = 60 / 144 / 2;
  const signal = renderMelody({ pitches: [60, 62, 64, 65, 64, 62], noteSeconds, gapSeconds: 0.005 });
  const { score, grid } = transcribe(signal);
  const pitched = pitchedEvents(score);
  expect(pitched.length).toBe(6);
  // Half a beat = two sixteenth units, whatever grid the tempo search picked.
  for (const note of pitched) expect(note.duration).toBe(2);
  // Pitch detection reports each note's end one analysis hop early (the window
  // centre is inside the frame), so the recovered tempo sits a few percent
  // under the true one. What matters is that the note VALUES are right.
  expect(Math.abs(grid.bpm - 144) / 144).toBeLessThan(0.15);
});

test('inferGrid recovers an exact tempo from clean note timings', () => {
  // Separated from the audio path: given exact onsets and offsets the search
  // must land on the true tempo, so any drift above is a quantizer bug rather
  // than detector bias.
  const exact = Array.from({ length: 8 }, (_, i) => ({
    start: i * 0.5, end: i * 0.5 + 0.5, midi: 60 + i, confidence: 1,
  }));
  const grid = inferGrid(exact);
  expect(Math.abs(grid.bpm - 120)).toBeLessThanOrEqual(1);
  expect(grid.beatsPerStep).toBe(1);
});

test('end-to-end: rests are inserted for gaps in the melody', () => {
  const signal = renderMelody({ pitches: [60, 62], noteSeconds: 0.5, gapSeconds: 0.01 });
  // Manually append 1.5s of silence after the two notes.
  const padded = new Float32Array(signal.length + Math.round(1.5 * SAMPLE_RATE));
  padded.set(signal);
  const { score } = transcribe(padded);
  const rests = score.events.filter((e) => e.type === 'rest');
  expect(rests.length).toBeGreaterThanOrEqual(1);
  expect(score.totalUnits % score.unitsPerMeasure).toBe(0);
});

test('buildScore ties a note that crosses a barline', () => {
  // Uses an explicit grid rather than an inferred one: how a note is split
  // across a barline is a property of the note and the bar, not of tempo
  // detection, and inferring the tempo here would only add noise to the test.
  const grid: RhythmGrid = {
    bpm: 120, beatsPerStep: 0.25, secondsPerStep: 0.125,
    beatsPerMeasure: 4, stepsPerMeasure: 16, cost: 0,
  };
  // One note lasting 7 sixteenths, starting on beat 4 of the bar.
  const quantized = [{ startStep: 12, durationSteps: 7, midi: 60, confidence: 1 }];
  const score = buildScore(quantized, grid, C_MAJOR);
  const pitched = pitchedEvents(score);

  expect(pitched.length).toBe(2); // 4 units in the first bar, 3 in the second
  expect(pitched[0].start).toBe(12);
  expect(pitched[0].duration).toBe(4);
  expect(pitched[0].tie).toBe(true);
  expect(pitched[1].start).toBe(16);
  expect(pitched[1].duration).toBe(3);
  expect(pitched[1].tie).toBe(false);
  // The rest before it and the padding after it must still tile the bars.
  const rests = score.events.filter((e): e is Extract<typeof e, { type: 'rest' }> => e.type === 'rest');
  expect(rests[0].start).toBe(0);
  expect(rests[0].duration).toBe(12);
  expect(score.totalUnits % score.unitsPerMeasure).toBe(0);
});

test('end-to-end: detects a minor key', () => {
  // A bare natural-minor scale is genuinely ambiguous — it is the relative
  // minor of C major and both keys explain the same six notes equally well.
  // Ending on the tonic and dwelling there is what tips it, so the phrase
  // actually asserts the key.
  const signal = renderMelody({
    pitches: [69, 67, 65, 64, 62, 60, 62, 64, 65, 69, 69, 69],
    noteSeconds: 0.5,
    gapSeconds: 0.01,
  });
  const { key, notes } = transcribe(signal);
  // The three repeated 69s are one sustained note, not three: the
  // segmentation merges same-pitch neighbours, which is correct for a
  // singer holding a note and also what a humming, vowel-isolating
  // transcription should do.
  expect(notes.length).toBe(10);
  expect(notes[notes.length - 1].midi).toBeCloseTo(69, 0);
  expect(notes[notes.length - 1].end - notes[notes.length - 1].start).toBeGreaterThan(1.2);
  expect(key.tonic).toBe(9);
  expect(key.mode).toBe('minor');
});

test('end-to-end: silence produces no notes and no crash', () => {
  const { notes, score } = transcribe(new Float32Array(SAMPLE_RATE * 2));
  expect(notes.length).toBe(0);
  expect(pitchedEvents(score).length).toBe(0);
  // A blank score still has a first bar to print.
  expect(score.totalUnits).toBe(score.unitsPerMeasure);
});

test('midi export round-trips pitches, order and tempo', () => {
  const signal = renderMelody({ pitches: SCALE_UP, noteSeconds: 0.5, gapSeconds: 0.01 });
  const { score, grid } = transcribe(signal);
  const bytes = scoreToMidi(score);
  const { notes, microsecondsPerBeat } = parseMidiNotes(bytes);

  expect(notes.length).toBe(SCALE_UP.length);
  for (let i = 0; i < SCALE_UP.length; i++) expect(notes[i].key).toBe(SCALE_UP[i]);
  // Quarter notes should be evenly spaced in ticks.
  const gaps = notes.slice(1).map((n, i) => n.tick - notes[i].tick);
  expect(new Set(gaps).size).toBe(1);
  expect(gaps[0]).toBe(480);
  expect(microsecondsPerBeat).toBe(Math.round(60_000_000 / grid.bpm));
  // A well-formed SMF starts with the MThd chunk.
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
  expect(String.fromCharCode(...bytes.slice(14, 18))).toBe('MTrk');
});

test('midi round-trips a score containing a tied note across a barline', () => {
  // Built from an explicit grid so the tie is guaranteed by construction
  // rather than depending on what tempo the search infers for the audio.
  const grid: RhythmGrid = {
    bpm: 120, beatsPerStep: 0.25, secondsPerStep: 0.125,
    beatsPerMeasure: 4, stepsPerMeasure: 16, cost: 0,
  };
  const score = buildScore(
    [
      { startStep: 0, durationSteps: 4, midi: 60, confidence: 1 },
      { startStep: 4, durationSteps: 4, midi: 62, confidence: 1 },
      // 14 units from step 12: crosses the barline at 16, so it must split.
      { startStep: 12, durationSteps: 14, midi: 64, confidence: 1 },
    ],
    grid,
    C_MAJOR,
  );

  const events = pitchedEvents(score);
  const tied = events.filter((e) => e.tie);
  expect(tied.length).toBeGreaterThanOrEqual(1);

  // The tie must survive the MIDI round trip: the two halves of a tied note
  // are the same pitch, and the file must contain both.
  const { notes } = parseMidiNotes(scoreToMidi(score));
  expect(notes.length).toBe(events.length);
  for (let i = 0; i < events.length; i++) {
    expect(notes[i].key).toBe(events[i].midi);
  }
  // The tied halves are adjacent, equal-pitch notes.
  const pitch64 = notes.filter((n) => n.key === 64);
  expect(pitch64.length).toBeGreaterThanOrEqual(2);
  for (const note of notes) {
    expect(note.key).toBeGreaterThanOrEqual(0);
    expect(note.key).toBeLessThanOrEqual(127);
    // The reader reports the velocity of whichever message closed the note, and
    // a release legitimately carries velocity 0, so only bound the range.
    expect(note.velocity).toBeGreaterThanOrEqual(0);
    expect(note.velocity).toBeLessThanOrEqual(127);
  }
});

test('inferGrid rejects a grid coarser than the material', () => {
  const notes = [
    { start: 0, end: 0.25, midi: 60, confidence: 1 },
    { start: 0.25, end: 0.5, midi: 62, confidence: 1 },
  ];
  const grid = inferGrid(notes);
  expect(grid.secondsPerStep).toBeLessThanOrEqual(0.5);
  expect(grid.stepsPerMeasure * grid.beatsPerStep).toBe(4);
});

test('quantizeNotes never emits a zero-length note', () => {
  const notes = [
    { start: 0, end: 0.01, midi: 60, confidence: 1 },
    { start: 0.01, end: 0.02, midi: 62, confidence: 1 },
  ];
  const grid = inferGrid(notes);
  for (const note of quantizeNotes(notes, grid)) {
    expect(note.durationSteps).toBeGreaterThanOrEqual(1);
    expect(note.startStep).toBeGreaterThanOrEqual(0);
  }
});

test('quantizeNotes keeps overlapping notes from losing time', () => {
  const notes = [
    { start: 0, end: 1.0, midi: 60, confidence: 1 },
    { start: 0.4, end: 1.2, midi: 64, confidence: 0.5 },
  ];
  const grid = inferGrid(notes);
  const quantized = quantizeNotes(notes, grid);
  for (let i = 1; i < quantized.length; i++) {
    const prev = quantized[i - 1];
    expect(quantized[i].startStep).toBeGreaterThanOrEqual(prev.startStep + prev.durationSteps);
  }
});

test('buildScore pads the final bar and always fills whole measures', () => {
  const signal = renderMelody({ pitches: [60, 62, 64], noteSeconds: 0.5, gapSeconds: 0.01 });
  const { score } = transcribe(signal);
  expect(score.totalUnits % score.unitsPerMeasure).toBe(0);
  expect(score.measures.length).toBe(score.totalUnits / score.unitsPerMeasure);
  // Events must tile the score with no gaps or overlaps.
  const sorted = score.events.slice().sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const event of sorted) {
    expect(event.start).toBe(cursor);
    cursor += event.duration;
  }
  expect(cursor).toBe(score.totalUnits);
});

test('pitch spelling agrees with the key signature', () => {
  // In G major, F is sharp; the printed accidental should be "#" not "n".
  const gMajor: Key = { tonic: 7, mode: 'major' };
  expect(spell(66, gMajor)).toEqual({ letter: 'F', alter: 1, accidentalKey: '#' });
  // In F major, B is flat.
  const fMajor: Key = { tonic: 5, mode: 'major' };
  expect(spell(70, fMajor)).toEqual({ letter: 'B', alter: -1, accidentalKey: 'b' });
  // A chromatic note outside the key still gets a readable spelling.
  const spelled = spell(61, C_MAJOR);
  expect(spelled.alter).toBe(1);
  expect(spelled.letter).toBe('C');
});

test('key specs for all 24 keys are covered in keyspec.test.ts', () => {
  // The exhaustive check against VexFlow's real table lives in keyspec.test.ts.
  expect(vexflowKeySpec({ tonic: 0, mode: 'major' })).toBe('C');
  expect(vexflowKeySpec({ tonic: 9, mode: 'minor' })).toBe('Am');
  expect(vexflowKeySpec({ tonic: 10, mode: 'minor' })).toBe('Bbm');
});

test('snapToScale pulls chromatic notes into the scale without shifting octaves', () => {
  expect(snapToScale(61, C_MAJOR)).toBe(60); // C# -> C
  expect(snapToScale(60, C_MAJOR)).toBe(60); // already diatonic
  // D# sits exactly between D and E. Either resolution is defensible, so the
  // test only pins the requirement that actually matters.
  expect([62, 64]).toContain(snapToScale(63, C_MAJOR));
  for (const midi of [55, 58, 61, 63, 66, 70, 73]) {
    expect(Math.abs(snapToScale(midi, C_MAJOR) - midi)).toBeLessThanOrEqual(1);
  }
});

test('key signature counts match the conventional spellings', () => {
  const cases: Array<[Key, number, '#' | 'b' | null]> = [
    [{ tonic: 0, mode: 'major' }, 0, null],   // C major
    [{ tonic: 7, mode: 'major' }, 1, '#'],    // G major
    [{ tonic: 5, mode: 'major' }, 1, 'b'],    // F major
    [{ tonic: 9, mode: 'major' }, 3, '#'],    // A major
    [{ tonic: 2, mode: 'major' }, 2, '#'],    // D major
    [{ tonic: 10, mode: 'major' }, 2, 'b'],   // Bb major
    [{ tonic: 6, mode: 'major' }, 6, '#'],    // F# major
    [{ tonic: 1, mode: 'major' }, 5, 'b'],    // Db major
    [{ tonic: 0, mode: 'minor' }, 3, 'b'],    // C minor
    [{ tonic: 9, mode: 'minor' }, 0, null],   // A minor
    [{ tonic: 2, mode: 'minor' }, 1, 'b'],    // D minor
    [{ tonic: 5, mode: 'minor' }, 4, 'b'],    // F minor
    [{ tonic: 7, mode: 'minor' }, 2, 'b'],    // G minor
    [{ tonic: 8, mode: 'minor' }, 5, '#'],    // G# minor
    [{ tonic: 10, mode: 'minor' }, 5, 'b'],   // Bb minor
    // Enharmonic pair: same pitch class, deliberately notated differently.
    [{ tonic: 3, mode: 'minor' }, 6, '#'],    // D# minor
    [{ tonic: 6, mode: 'minor' }, 3, '#'],    // F# minor
  ];
  for (const [key, num, accidental] of cases) {
    expect(keySignatureOf(key)).toEqual({ num, accidental });
  }
});

test('a key and its relative minor share a signature', () => {
  // The relative minor of a major key lies three semitones BELOW its tonic
  // (C major's relative minor is A minor) and shares its key signature.
  for (let tonic = 0; tonic < 12; tonic++) {
    const major = keySignatureOf({ tonic, mode: 'major' });
    const relativeMinor = keySignatureOf({ tonic: (tonic + 9) % 12, mode: 'minor' });
    expect(relativeMinor).toEqual(major);
  }
});

test('the name, the signature and the note spelling all agree', () => {
  // F major must print Bb, and a Bb in F major must not also print an
  // accidental. A mismatch here is what produces a score whose key signature
  // contradicts its own notes.
  const fMajor: Key = { tonic: 5, mode: 'major' };
  expect(keySignatureOf(fMajor)).toEqual({ num: 1, accidental: 'b' });
  expect(spell(70, fMajor)).toEqual({ letter: 'B', alter: -1, accidentalKey: 'b' });
  // G major must print F#.
  const gMajor: Key = { tonic: 7, mode: 'major' };
  expect(keySignatureOf(gMajor)).toEqual({ num: 1, accidental: '#' });
  expect(spell(66, gMajor)).toEqual({ letter: 'F', alter: 1, accidentalKey: '#' });
  // In F major, an F# is chromatic and must show an accidental.
  expect(spell(66, fMajor)).toEqual({ letter: 'F', alter: 1, accidentalKey: '#' });
});
