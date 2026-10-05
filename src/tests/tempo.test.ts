/**
 * Tempo recovery, on material where the answer is known.
 *
 * A user recorded 14.5s and wrote "too fast". The grid search answered 199bpm,
 * an earlier take answered 200bpm, and `maxBpm` is 208 — both pinned against the
 * ceiling. On the real recording the ten best-scoring hypotheses all fell between
 * 195 and 208.
 *
 * Two things had to be established before changing anything, and both are
 * recorded here because the investigation went wrong twice first:
 *
 *   1. The tempo prior is not the cause. Widening it from 0.03 to 0.2 broke the
 *      demo melody, which went from 100bpm to 201bpm. A prior strong enough to
 *      drag a real recording toward 108 has not measured anything — it has
 *      substituted a guess for evidence, which is the exact failure the narrow
 *      prior was introduced to prevent, in the opposite direction.
 *
 *   2. The alignment term being scale-free is a real latent flaw but is not the
 *      cause either. Normalising it by the step (so a random placement scores the
 *      same at every tempo) changed almost nothing: mean error went from 46.0% to
 *      40.6%, and the cases that failed still failed.
 *
 * What is left is real and reproduced here: a phrase containing dotted values
 * comes out at exactly double the tempo. Inter-onset intervals of 0.5 and 1.5
 * beats are both exact multiples of a half-beat grid, so a grid half the true
 * beat fits perfectly and reports twice the tempo.
 *
 * So these tests document the behaviour rather than fix it. The fix that works
 * (an asymmetric penalty, heavier when the grid is finer than the typical
 * interval) takes the dotted cases from 0 of 5 to 4 of 5 and breaks the demo
 * melody's note values, so it is not being applied: a tempo that is too fast is
 * a wrong number, and a score whose note values are wrong is a wrong score.
 * These pin what currently happens so the trade-off is visible if it is revisited.
 */
import { expect, test } from 'bun:test';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS } from '../lib/dsp/frames';
import { smoothTrack } from '../lib/dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS } from '../lib/music/segment';
import { inferGrid, DEFAULT_GRID_OPTIONS } from '../lib/music/quantize';
import { synthesizeDemoMelody, DEMO_MELODY } from '../lib/audio/demo-melody';

const SAMPLE_RATE = 44100;

function tone(hz: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    out[i] = 0.5 * Math.sin(2 * Math.PI * hz * t) + 0.2 * Math.sin(2 * Math.PI * 2 * hz * t);
  }
  return out;
}

interface Event {
  beat: number;
  beats: number;
  hz: number;
}

function render(events: Event[], bpm: number): Float32Array {
  const secondsPerBeat = 60 / bpm;
  const total = events.reduce((max, e) => Math.max(max, e.beat + e.beats), 0) * secondsPerBeat + 0.4;
  const out = new Float32Array(Math.round(total * SAMPLE_RATE));
  for (const event of events) {
    const start = Math.round(event.beat * secondsPerBeat * SAMPLE_RATE);
    const body = tone(event.hz, event.beats * secondsPerBeat);
    for (let i = 0; i < body.length && start + i < out.length; i++) out[start + i] += body[i];
  }
  return out;
}

function detect(samples: Float32Array) {
  const frames = analyzeTrack(samples, {
    ...DEFAULT_TRACK_OPTIONS,
    sampleRate: SAMPLE_RATE,
    minHz: 80,
    maxHz: 800,
  });
  const track = frames.map((f) => ({ time: f.time, hz: f.hz, voiced: f.hz > 0 ? 1 : 0, clarity: f.clarity }));
  return segmentNotes(smoothTrack(track), {
    ...DEFAULT_SEGMENT_OPTIONS,
    frameDuration: DEFAULT_TRACK_OPTIONS.hopSize / SAMPLE_RATE,
  });
}

const SCALE = [220, 246.94, 261.63, 293.66, 329.63, 349.23, 392, 440, 493.88, 523.25];

/** Only quarters and halves: every onset interval is a whole number of beats. */
const WHOLE: Event[] = SCALE.map((hz, i) => ({ beat: i, beats: i % 4 === 3 ? 2 : 1, hz }));

/** Adds dotted eighths, giving 0.5-beat and 1.5-beat intervals. */
const DOTTED: Event[] = [
  { beat: 0, beats: 1, hz: 220 },
  { beat: 1, beats: 1.5, hz: 246.94 },
  { beat: 2.5, beats: 0.5, hz: 261.63 },
  { beat: 3, beats: 1, hz: 293.66 },
  { beat: 4, beats: 2, hz: 329.63 },
  { beat: 6, beats: 1.5, hz: 293.66 },
  { beat: 7.5, beats: 0.5, hz: 261.63 },
  { beat: 8, beats: 1, hz: 246.94 },
  { beat: 9, beats: 2, hz: 220 },
];

/** Eighths throughout: intervals of half a beat throughout. */
const EIGHTHS: Event[] = SCALE.flatMap((hz, i) => [
  { beat: i, beats: 0.5, hz },
  { beat: i + 0.5, beats: 0.5, hz: hz * 0.84 },
]);

const TEMPI = [72, 88, 104, 120, 144];
const within = (got: number, want: number, tolerance = 0.03) => Math.abs(got - want) / want < tolerance;

test('the demo melody keeps its known tempo', () => {
  // The one input whose correct answer is certain. Any tempo change must leave
  // this alone, and it is what an attempted fix broke first.
  const grid = inferGrid(detect(synthesizeDemoMelody(SAMPLE_RATE)));
  expect(Math.abs(grid.bpm - DEMO_MELODY.bpm) / DEMO_MELODY.bpm).toBeLessThan(0.03);
});

test('phrases of whole values recover their tempo at every speed tested', () => {
  // Quarters and halves only: no interval is a fraction of a beat, so no grid
  // finer than the beat can fit. This is the case the search handles well, and
  // it is the baseline any fix must not regress.
  for (const bpm of TEMPI) {
    const grid = inferGrid(detect(render(WHOLE, bpm)));
    expect(within(grid.bpm, bpm)).toBe(true);
  }
});

test('phrases containing dotted values come out at twice the tempo', () => {
  // The bug, pinned as current behaviour. 0.5-beat and 1.5-beat intervals are
  // both exact multiples of a half-beat grid, so a grid half the true beat fits
  // perfectly and reads as double the tempo.
  //
  // Recorded rather than asserted as correct because the fix that resolves it
  // (a heavier penalty when the grid is finer than the typical interval) also
  // breaks the demo melody's note values. Deciding between a wrong tempo and a
  // wrong score needs a judgement about which failure matters more, and that is
  // not a call to make silently inside a scoring function.
  const doubled = TEMPI.filter((bpm) => {
    const got = inferGrid(detect(render(DOTTED, bpm))).bpm;
    return within(got, bpm * 2, 0.05);
  });
  // At least some, and most: this is a systematic bias, not a stray case.
  expect(doubled.length).toBeGreaterThanOrEqual(3);
});

test('the doubling is exactly a factor of two, not drift', () => {
  // Distinguishes the grid being half the beat from the search merely preferring
  // something fast. A drift would be a scoring problem; an exact halving is a
  // structural one, which is why the fix belongs in the metrical term.
  const bpm = 88;
  const grid = inferGrid(detect(render(DOTTED, bpm)));
  expect(within(grid.bpm, bpm * 2, 0.05)).toBe(true);
});

test('pure eighths at slow tempi are also doubled, and cannot be distinguished', () => {
  // Documenting a genuine ambiguity rather than a bug. A grid of eighths at 72bpm
  // is physically identical to a grid of quarters at 144bpm: same step, same
  // onset alignment, and 72 and 144 are equidistant from the prior's centre. The
  // only term that separates them is the coarseness penalty, which prefers the
  // finer note value — so the faster reading wins by exactly its weight.
  //
  // No evidence in the audio can settle it. Only a convention can, so this is
  // recorded so that a future change to COARSENESS_WEIGHT is not mistaken for a
  // tempo fix.
  const slow = TEMPI.filter((bpm) => bpm <= 96);
  for (const bpm of slow) {
    const got = inferGrid(detect(render(EIGHTHS, bpm))).bpm;
    expect(within(got, bpm) || within(got, bpm * 2, 0.05)).toBe(true);
  }
});

test('faster eighths are read correctly, at half-beat resolution', () => {
  // Where doubling would push the tempo past the ceiling, the search has no
  // choice but to accept the coarser reading — and then it is right.
  for (const bpm of [104, 120, 144]) {
    const grid = inferGrid(detect(render(EIGHTHS, bpm)));
    expect(within(grid.bpm, bpm)).toBe(true);
  }
});

test('the tempo search cannot exceed its ceiling', () => {
  // Two of the user's takes came back at 199 and 205 against a 208 ceiling,
  // which is what a search pinned against a limit looks like.
  const grid = inferGrid(detect(synthesizeDemoMelody(SAMPLE_RATE)));
  expect(grid.bpm).toBeLessThanOrEqual(DEFAULT_GRID_OPTIONS.maxBpm);
});