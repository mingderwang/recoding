/**
 * The funnel's quiet and no-pitch counters must be real.
 *
 * Both were declared in the worker, never incremented, and posted as 0. Every
 * report a user pasted therefore contained two rows of fiction, and one of them
 * was load-bearing: "too quiet 0 (0%)" across 33.5 seconds reads as continuous
 * multi-source audio, which was a conclusion drawn from a constant rather than a
 * measurement.
 *
 * So this checks them against signals whose structure is known exactly, and
 * checks the property that makes them trustworthy in combination: the three
 * counts must partition the frames, so a frame cannot be simultaneously silent,
 * unpitched and detected.
 */
import { expect, test } from 'bun:test';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS } from '../lib/dsp/frames';

const SR = 44100;
const FLOOR = DEFAULT_TRACK_OPTIONS.rmsFloor;

function tone(hz: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

const silence = (seconds: number) => new Float32Array(Math.round(seconds * SR));

function join(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The same derivation the worker now performs. */
function count(samples: Float32Array) {
  const frames = analyzeTrack(samples, {
    ...DEFAULT_TRACK_OPTIONS,
    sampleRate: SR,
    windowSize: 2048,
    minHz: 95,
    maxHz: 600,
  });
  return {
    total: frames.length,
    tooQuiet: frames.filter((f) => f.rms < FLOOR).length,
    noPitchFound: frames.filter((f) => f.rms >= FLOOR && f.hz <= 0).length,
    detected: frames.filter((f) => f.hz > 0).length,
  };
}

test('the three counts partition the frames exactly', () => {
  // The property that catches double-counting and silent omission, which is how
  // two always-zero counters survived: they summed to nothing and nothing
  // complained.
  for (const samples of [
    join([silence(1), tone(220, 0.6), silence(0.5), tone(262, 0.6), silence(1)]),
    join([tone(220, 3)]),
    silence(3),
  ]) {
    const c = count(samples);
    expect(c.tooQuiet + c.noPitchFound + c.detected).toBe(c.total);
  }
});

test('a recording with gaps reports the gaps', () => {
  const c = count(join([silence(1), tone(220, 0.6), silence(0.5), tone(262, 0.6), silence(1)]));
  expect(c.tooQuiet).toBeGreaterThan(100);
  expect(c.detected).toBeGreaterThan(50);
});

test('unbroken sound reports zero silent frames', () => {
  const c = count(join([tone(220, 3)]));
  expect(c.tooQuiet).toBe(0);
  expect(c.noPitchFound).toBe(0);
  expect(c.detected).toBe(c.total);
});

test('silence reports every frame silent and none detected', () => {
  const c = count(silence(3));
  expect(c.tooQuiet).toBe(c.total);
  expect(c.detected).toBe(0);
});

test('an audible but aperiodic frame is counted as no-pitch, not as quiet', () => {
  // White noise sits above the silence floor and has no periodicity. Lumping it
  // in with quiet would understate how much of a recording the detector actually
  // failed on, which is the number that distinguishes "too quiet to hear" from
  // "heard, but could not find a pitch".
  let state = 12345;
  const noise = new Float32Array(Math.round(3 * SR));
  for (let i = 0; i < noise.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    noise[i] = ((state / 4294967296) * 2 - 1) * 0.1;
  }
  const c = count(noise);
  expect(c.tooQuiet).toBe(0);
  expect(c.noPitchFound).toBeGreaterThan(0);
});