/**
 * What a shorter analysis window costs at the bottom of the range.
 *
 * `short-notes.test.ts` pins the gain: at 2048 samples instead of 4096, notes
 * down to 100ms are recovered from a melodic figure where half of them were
 * being lost. This file pins the price, because the two are not separable — a
 * change that fixes missing notes by introducing wrong ones is worse than the
 * bug, since a wrong note is silently plausible and a missing one is visible.
 *
 * The cost is at the low end. The NSDF measures periodicity in the time domain,
 * so its reliability is governed by how many cycles of the fundamental a window
 * contains. At 2048 samples and a 55Hz floor that is 2.6 cycles, and below
 * about 82Hz nothing is detected at all.
 *
 * So `windowSizeForFloor` derives the window from the range instead of using a
 * constant, and these tests are what justify the rule.
 */
import { describe, expect, test } from 'bun:test';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS, windowSizeForFloor } from '../lib/dsp/frames';
import { smoothTrack } from '../lib/dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS } from '../lib/music/segment';
import { VOICE_RANGES } from '../lib/music/voice-range';

const SAMPLE_RATE = 44100;

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

/**
 * A long sustained note, read back as a pitch.
 *
 * Long on purpose: this isolates frequency accuracy, so a failure here cannot
 * be blamed on the note being too short for the window — which is the confound
 * in the other direction.
 */
function measurePitch(hz: number, windowSize: number, minHz = 55): number | null {
  const body = tone(hz, 0.5);
  const lead = new Float32Array(Math.round(0.1 * SAMPLE_RATE));
  const samples = new Float32Array(lead.length + body.length + lead.length);
  samples.set(body, lead.length);

  const frames = analyzeTrack(samples, {
    ...DEFAULT_TRACK_OPTIONS,
    sampleRate: SAMPLE_RATE,
    windowSize,
    minHz,
    maxHz: 1100,
  });
  const track = frames.map((f) => ({ time: f.time, hz: f.hz, voiced: f.hz > 0 ? 1 : 0, clarity: f.clarity }));
  const notes = segmentNotes(smoothTrack(track), {
    ...DEFAULT_SEGMENT_OPTIONS,
    frameDuration: DEFAULT_TRACK_OPTIONS.hopSize / SAMPLE_RATE,
  });

  // The longest run is the note itself; shorter runs at the edges are attack
  // and release transients and would bias the result.
  const longest = notes.reduce<{ midi: number; len: number } | null>(
    (best, n) => {
      const len = n.end - n.start;
      return !best || len > best.len ? { midi: n.midi, len } : best;
    },
    null,
  );
  return longest ? longest.midi : null;
}

const cents = (measured: number, hz: number) => (measured - (69 + 12 * Math.log2(hz / 440))) * 100;

describe('windowSizeForFloor', () => {
  test('a bass range keeps the long window, because a short one detects nothing there', () => {
    expect(windowSizeForFloor(VOICE_RANGES.bass.minHz)).toBe(4096);
  });

  test('an unconstrained range keeps the long window, since its floor is 60Hz', () => {
    expect(windowSizeForFloor(VOICE_RANGES.auto.minHz)).toBe(4096);
  });

  test('tenor and above get the short window', () => {
    for (const id of ['tenor', 'alto', 'soprano'] as const) {
      expect(windowSizeForFloor(VOICE_RANGES[id].minHz)).toBe(2048);
    }
  });

  test('the piano range gets the long window, because A0 needs it', () => {
    // Four periods of 27.5Hz is 6415 samples, so 4096 holds only 2.5 and
    // detects nothing at all at the bottom of a piano.
    expect(windowSizeForFloor(VOICE_RANGES.piano.minHz)).toBe(8192);
  });

  test('always a power of two, so the autocorrelation FFT stays cheap', () => {
    for (let hz = 40; hz < 1200; hz += 7) {
      const size = windowSizeForFloor(hz);
      expect((size & (size - 1))).toBe(0);
    }
  });

  test('stays within the measured bounds for any input', () => {
    for (const hz of [0, -50, 20, 55, 95, 200, 5000, Number.NaN]) {
      const size = windowSizeForFloor(hz);
      expect(size).toBeGreaterThanOrEqual(2048);
      expect(size).toBeLessThanOrEqual(8192);
    }
  });
});

describe('the cost of the short window', () => {
  // The measured boundary: 2048 detects nothing at or below about 82Hz, which is
  // why the bass range must keep 4096. These are the two reasons the window is
  // derived rather than lowered globally.
  test('2048 detects nothing below about 82Hz', () => {
    expect(measurePitch(65.4, 2048)).toBeNull();
  });

  test('4096 still detects those low notes', () => {
    for (const hz of [55, 65.4, 82.4]) {
      const measured = measurePitch(hz, 4096);
      expect(measured).not.toBeNull();
      expect(Math.abs(cents(measured as number, hz))).toBeLessThan(50);
    }
  });

  test('above 82Hz both windows are accurate to well under a quarter tone', () => {
    for (const hz of [98, 130.8, 196, 261.6, 392, 523.3]) {
      for (const windowSize of [2048, 4096]) {
        const measured = measurePitch(hz, windowSize);
        expect(measured).not.toBeNull();
        expect(Math.abs(cents(measured as number, hz))).toBeLessThan(25);
      }
    }
  });

  test('the chosen window is accurate across the whole range it is chosen for', () => {
    // This is the assertion that ties the rule to its justification: for every
    // preset, the window `windowSizeForFloor` picks must resolve that preset's
    // own lowest note. Without it the rule could drift and nothing would notice
    // until a bass came out silent.
    for (const id of ['bass', 'tenor', 'alto', 'soprano', 'piano'] as const) {
      const range = VOICE_RANGES[id];
      const windowSize = windowSizeForFloor(range.minHz);
      const measured = measurePitch(range.minHz, windowSize, range.minHz);
      expect(measured).not.toBeNull();
      expect(Math.abs(cents(measured as number, range.minHz))).toBeLessThan(50);
    }
  });
});