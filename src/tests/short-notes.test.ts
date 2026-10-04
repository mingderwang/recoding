/**
 * Short notes in context must survive.
 *
 * A user reported "I think you sampling to slow" and was right. This is the
 * regression that guards it.
 *
 * The failure it pins down: the analysis window was 4096 samples (93ms), so a
 * window had to fit *inside* a note for the NSDF to see one pitch. A 125ms note
 * has only about three frames that do not straddle a boundary, and three frames
 * at an 11.6ms hop is a 35ms run — which segmentation then discarded as too
 * short. On a melodic figure of 125ms notes, half were lost outright and three
 * more came back at the wrong pitch.
 *
 * Why a synthetic fixture is legitimate here, when it has been the source of
 * earlier mistakes: this is the one property that cannot be observed without a
 * known answer. A recording of a real singer cannot tell us how many notes were
 * missed, only that the result looks wrong. A figure of known pitch and known
 * length can. What the synthetic signal must not be allowed to imply is that
 * clean tones represent real audio — which is why the fixture carries noise and
 * reverb, and why the low-frequency cost of a short window is tested separately
 * in `window.test.ts`.
 */
import { expect, test } from 'bun:test';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS, windowSizeForFloor } from '../lib/dsp/frames';
import { smoothTrack } from '../lib/dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS } from '../lib/music/segment';
import { VOICE_RANGES } from '../lib/music/voice-range';

const SAMPLE_RATE = 44100;

/** Deterministic noise, so a failure is reproducible and configs compare fairly. */
function makeNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

/**
 * Three harmonics with a 1/h rolloff, roughly a sung vowel — the same shape the
 * demo melody uses.
 */
function tone(hz: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    out[i] =
      0.5 * Math.sin(2 * Math.PI * hz * t) +
      0.2 * Math.sin(2 * Math.PI * 2 * hz * t) +
      0.08 * Math.sin(2 * Math.PI * 3 * hz * t);
  }
  return out;
}

const LEAD_IN = 0.2;
const TAIL = 0.3;

/**
 * A figure of notes butted together, with no gaps — the case that failed. The
 * shape alternates a held note with moving notes, and every note is followed
 * immediately by a different pitch, so each boundary is a hard pitch change.
 */
const FIGURE = [220.0, 261.6, 220.0, 329.6, 293.7, 261.6, 246.9, 329.6];

interface Built {
  samples: Float32Array;
  expected: number[];
  onsets: number[];
}

function buildFigure(noteSeconds: number, noiseLevel: number, reverb: number): Built {
  // The lead-in must be REAL silence in the buffer, not just bookkeeping.
  // Leaving it out shifts every expected onset later than the audio, so each
  // note is matched against its neighbour's slot — which made a perfect 9/9
  // pipeline look like 1/8 until the harness itself was debugged.
  const parts: Float32Array[] = [new Float32Array(Math.round(LEAD_IN * SAMPLE_RATE))];
  const expected: number[] = [];
  const onsets: number[] = [];
  let cursor = LEAD_IN;

  for (const hz of FIGURE) {
    parts.push(tone(hz, noteSeconds));
    expected.push(hz);
    onsets.push(cursor);
    cursor += noteSeconds;
  }
  parts.push(tone(FIGURE[0], TAIL));
  expected.push(FIGURE[0]);
  onsets.push(cursor);

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const dry = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    dry.set(part, offset);
    offset += part.length;
  }

  const wet = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    let value = dry[i];
    const tap1 = i - Math.round(0.018 * SAMPLE_RATE);
    const tap2 = i - Math.round(0.037 * SAMPLE_RATE);
    if (tap1 >= 0) value += dry[tap1] * reverb * 0.6;
    if (tap2 >= 0) value += dry[tap2] * reverb * 0.3;
    wet[i] = value;
  }

  const noise = makeNoise(12345);
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) out[i] = wet[i] + noise() * noiseLevel;
  return { samples: out, expected, onsets };
}

/**
 * `windowSize` and `minDurationSeconds` are both overridable so the test can
 * reproduce the old configuration exactly. Changing one at a time would not:
 * lowering the minimum note length alone already recovers most of the loss, and
 * would make the old window look innocent.
 */
function transcribe(
  noteSeconds: number,
  windowSize = windowSizeForFloor(VOICE_RANGES.tenor.minHz),
  minDurationSeconds = DEFAULT_SEGMENT_OPTIONS.minDurationSeconds,
) {
  const noiseLevel = 0.02;
  const reverb = 0.35;
  const { samples, expected, onsets } = buildFigure(noteSeconds, noiseLevel, reverb);

  const frames = analyzeTrack(samples, {
    ...DEFAULT_TRACK_OPTIONS,
    sampleRate: SAMPLE_RATE,
    windowSize,
    minHz: VOICE_RANGES.tenor.minHz,
    maxHz: VOICE_RANGES.tenor.maxHz,
  });
  const track = frames.map((f) => ({ time: f.time, hz: f.hz, voiced: f.hz > 0 ? 1 : 0, clarity: f.clarity }));
  const notes = segmentNotes(smoothTrack(track), {
    ...DEFAULT_SEGMENT_OPTIONS,
    frameDuration: DEFAULT_TRACK_OPTIONS.hopSize / SAMPLE_RATE,
    minDurationSeconds,
  });

  const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
  const correct: boolean[] = expected.map(() => false);
  const wrongPitch: number[] = [];
  const taken = new Set<number>();

  for (let i = 0; i < expected.length; i++) {
    // A note must sit where it was sung. Matching on pitch alone would credit a
    // merged run for whichever of its two pitches came closer, and then report
    // the loss as a success.
    const from = onsets[i] - 0.02;
    const to = onsets[i] + noteSeconds + 0.02;
    const candidates = notes
      .map((note, index) => ({ note, index }))
      .filter(({ note }) => note.start >= from && note.start < to);

    let best: { index: number; cents: number } | null = null;
    for (const candidate of candidates) {
      if (taken.has(candidate.index)) continue;
      const cents = Math.abs(candidate.note.midi - midiOf(expected[i]));
      if (!best || cents < best.cents) best = { index: candidate.index, cents };
    }
    if (!best) continue;
    taken.add(best.index);
    // Within half a semitone is the same note; anything wider is a real error
    // and must not be counted as a recovery.
    if (best.cents < 0.5) correct[i] = true;
    else wrongPitch.push(i);
  }

  return { correct, wrongPitch, noteCount: notes.length };
}

test('the old configuration loses half the notes in a 125ms figure', () => {
  // The bug, pinned so the fix cannot be silently reverted. Both old settings at
  // once — a 93ms window and a 70ms minimum note — which measured 4 of 9 notes
  // correct with 3 more at the wrong pitch.
  const old = transcribe(0.125, 4096, 0.07);
  expect(old.correct.filter(Boolean).length).toBeLessThanOrEqual(5);
  expect(old.wrongPitch.length).toBeGreaterThan(0);
});

test('each change alone helps, so neither is load-bearing on its own', () => {
  // Attribution, so a future edit that reverts one of them is visible as a
  // partial regression rather than an unexplained total.
  const old = transcribe(0.125, 4096, 0.07).correct.filter(Boolean).length;
  const shorterMinNote = transcribe(0.125, 4096, 0.05).correct.filter(Boolean).length;
  const shorterWindow = transcribe(0.125, 2048, 0.07).correct.filter(Boolean).length;
  expect(shorterMinNote).toBeGreaterThan(old);
  expect(shorterWindow).toBeGreaterThanOrEqual(shorterMinNote);
});

test('every note of a 125ms figure is recovered at the derived window', () => {
  const { correct, wrongPitch } = transcribe(0.125);
  expect(wrongPitch).toEqual([]);
  expect(correct.every(Boolean)).toBe(true);
});

test('every note of a 100ms figure is recovered at the derived window', () => {
  // 100ms is a sixteenth note at 150bpm. Ordinary in a sung phrase, and it was
  // the worst case measured: 3 of 8 before, 9 of 9 after.
  const { correct, wrongPitch } = transcribe(0.1);
  expect(wrongPitch).toEqual([]);
  expect(correct.every(Boolean)).toBe(true);
});

test('no spurious notes appear between the notes of the figure', () => {
  // Lowering the minimum note length risks admitting one-frame blips, which
  // would inflate the note count and print a score full of stutters.
  const { noteCount } = transcribe(0.125);
  expect(noteCount).toBeLessThanOrEqual(FIGURE.length + 1);
});