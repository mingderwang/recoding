import { expect, test } from 'bun:test';
import { buildScore, type Score } from '../lib/music/score';
import type { RhythmGrid } from '../lib/music/quantize';
import { midiToHz } from '../lib/dsp/smooth';
import { UNITS_PER_BEAT } from '../lib/music/score';

const C_MAJOR = { tonic: 0, mode: 'major' } as const;

function grid(bpm: number): RhythmGrid {
  return {
    bpm,
    beatsPerStep: 0.25,
    secondsPerStep: (60 / bpm) * 0.25,
    beatsPerMeasure: 4,
    stepsPerMeasure: 16,
    cost: 0,
  };
}

/**
 * The player itself needs a live AudioContext, which is not available here, so
 * these tests pin the timing contract it depends on: how a score's unit
 * positions map onto seconds. A mistake there is inaudible in a unit test and
 * very audible in the browser, where notes would drift or overlap.
 */
function secondsPerUnit(score: Score): number {
  return 60 / score.grid.bpm / UNITS_PER_BEAT;
}

test('a quarter note lasts exactly one beat', () => {
  const score = buildScore([{ startStep: 0, durationSteps: 4, midi: 60, confidence: 1 }], grid(120), C_MAJOR);
  const per = secondsPerUnit(score);
  const note = score.events.find((e) => e.type === 'note');
  expect(note).toBeDefined();
  // 4 sixteenth units = one quarter = 0.5s at 120bpm
  expect((note as { duration: number }).duration * per).toBeCloseTo(0.5, 6);
});

test('tempo scales the duration as expected', () => {
  for (const bpm of [60, 90, 120, 150, 200]) {
    const score = buildScore([{ startStep: 0, durationSteps: 4, midi: 60, confidence: 1 }], grid(bpm), C_MAJOR);
    const note = score.events.find((e) => e.type === 'note') as { duration: number };
    expect(note.duration * secondsPerUnit(score)).toBeCloseTo(60 / bpm, 6);
  }
});

test('playback length covers the whole score including the final rest', () => {
  // Ten quarter notes fill two and a half bars, so the score is three bars.
  const score = buildScore(
    [60, 62, 64, 65, 67, 69, 67, 65, 64, 62].map((midi, i) => ({
      startStep: i * 4, durationSteps: 4, midi, confidence: 1,
    })),
    grid(150),
    C_MAJOR,
  );
  const per = secondsPerUnit(score);
  // 48 sixteenth units at 150bpm = 48 * 0.1 = 4.8s
  expect(score.totalUnits).toBe(48);
  expect(score.totalUnits * per).toBeCloseTo(4.8, 6);
});

test('note onsets map to non-overlapping, ordered times', () => {
  const score = buildScore(
    [60, 62, 64, 65].map((midi, i) => ({ startStep: i * 4, durationSteps: 4, midi, confidence: 1 })),
    grid(120),
    C_MAJOR,
  );
  const per = secondsPerUnit(score);
  const notes = score.events.filter((e) => e.type === 'note') as Array<{
    start: number; duration: number;
  }>;

  let previousEnd = 0;
  for (const note of notes) {
    const start = note.start * per;
    const end = (note.start + note.duration) * per;
    // No overlap: each note starts at or after the previous one ended. Without
    // this the synthesiser would smear two notes into one.
    expect(start).toBeGreaterThanOrEqual(previousEnd - 1e-9);
    expect(end).toBeGreaterThan(start);
    previousEnd = end;
  }
});

test('rests are silent spans, not notes', () => {
  const score = buildScore(
    [
      { startStep: 0, durationSteps: 4, midi: 60, confidence: 1 },
      // A gap of two beats before the next note.
      { startStep: 12, durationSteps: 4, midi: 62, confidence: 1 },
    ],
    grid(120),
    C_MAJOR,
  );
  const rests = score.events.filter((e) => e.type === 'rest') as Array<{ start: number; duration: number }>;
  expect(rests.length).toBeGreaterThan(0);
  // Every rest sits between two notes, not on top of one.
  const notes = score.events.filter((e) => e.type === 'note') as Array<{ start: number; duration: number }>;
  for (const rest of rests) {
    for (const note of notes) {
      const overlaps = rest.start < note.start + note.duration && note.start < rest.start + rest.duration;
      expect(overlaps).toBe(false);
    }
  }
});

test('tied notes are adjacent and the same pitch, so they sound as one', () => {
  const score = buildScore(
    [{ startStep: 12, durationSteps: 14, midi: 64, confidence: 1 }],
    grid(120),
    C_MAJOR,
  );
  const halves = score.events.filter((e) => e.type === 'note') as Array<{
    start: number; duration: number; midi: number; tie: boolean;
  }>;
  expect(halves.length).toBe(2);
  expect(halves[0].tie).toBe(true);
  expect(halves[1].tie).toBe(false);
  expect(halves[0].midi).toBe(halves[1].midi);
  // The second half begins exactly where the first ends.
  expect(halves[1].start).toBe(halves[0].start + halves[0].duration);
});

test('every pitch a score can contain maps to an audible frequency', () => {
  // The player clamps to MIDI 21..108; check those bounds are inaudible or near
  // inaudible rather than a silent or shrill artefact.
  expect(midiToHz(21)).toBeGreaterThan(25);
  expect(midiToHz(108)).toBeLessThan(5000);
  // A plausible sung range sits well inside the clamp.
  for (const midi of [36, 48, 60, 72, 84]) {
    const hz = midiToHz(midi);
    expect(hz).toBeGreaterThan(20);
    expect(hz).toBeLessThan(10000);
  }
});
