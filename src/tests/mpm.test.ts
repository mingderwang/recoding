import { expect, test } from 'bun:test';
import { DEFAULT_MPM_OPTIONS, estimatePitch } from '../lib/dsp/mpm';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS } from '../lib/dsp/frames';
import { hzToMidi, smoothTrack, type F0Point } from '../lib/dsp/smooth';

const SAMPLE_RATE = 44100;

function sine(freq: number, samples: number, amplitude = 0.5, harmonics = 1): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) {
      // Voice-like rolloff: stronger upper partials, as in a sung vowel.
      v += (amplitude / h) * Math.sin((2 * Math.PI * freq * h * i) / SAMPLE_RATE);
    }
    out[i] = v;
  }
  return out;
}

function centsOff(expected: number, actual: number): number {
  return Math.abs(1200 * Math.log2(actual / expected));
}

// Measured worst case for the rectangular-window MPM over 82-880 Hz is ~12
// cents at the 4096-sample window. The residual comes from the window not
// holding an integer number of 2f cycles; Hann and Hamming windowing were both
// tried and made it worse (24-30 cents), so the window stays rectangular. 12
// cents is an eighth of a semitone, and it disappears entirely once the pitch
// is quantised to a scale.
const TOLERANCE_CENTS = 20;

test('detects a pure tone accurately across the sung range', () => {
  for (const freq of [82, 98, 110, 146.83, 196, 220, 261.63, 329.63, 392, 440, 659.25, 880]) {
    const result = estimatePitch(sine(freq, 4096, 0.5, 1), { ...DEFAULT_MPM_OPTIONS, sampleRate: SAMPLE_RATE });
    expect(result.hz).toBeGreaterThan(0);
    expect(centsOff(freq, result.hz)).toBeLessThan(TOLERANCE_CENTS);
  }
});

test('detects a harmonically rich tone closely enough to notate', () => {
  // A sung vowel is not a sine, and the harmonic comb pulls the peak off the
  // true period. ~15 cents is a tenth of a semitone, so the detected pitch
  // always lands on the same note once it is quantised.
  for (const freq of [98, 146.83, 220, 329.63, 440, 880]) {
    const result = estimatePitch(sine(freq, 4096, 0.5, 3), { ...DEFAULT_MPM_OPTIONS, sampleRate: SAMPLE_RATE });
    expect(result.hz).toBeGreaterThan(0);
    expect(centsOff(freq, result.hz)).toBeLessThan(TOLERANCE_CENTS);
  }
});

test('clarity rises with harmonic content, and stays in range', () => {
  const pure = estimatePitch(sine(440, 4096, 0.5, 1), { ...DEFAULT_MPM_OPTIONS, sampleRate: SAMPLE_RATE });
  const rich = estimatePitch(sine(440, 4096, 0.5, 3), { ...DEFAULT_MPM_OPTIONS, sampleRate: SAMPLE_RATE });
  for (const result of [pure, rich]) {
    expect(result.clarity).toBeGreaterThan(0);
    expect(result.clarity).toBeLessThanOrEqual(1);
  }
  expect(rich.clarity).toBeGreaterThan(0.85);
});

test('does not halve the pitch on a harmonically rich tone', () => {
  // This is the classic autocorrelation failure mode: a strong second harmonic
  // makes the true period look like a multiple of itself.
  const result = estimatePitch(sine(196, 4096, 0.5, 2), { ...DEFAULT_MPM_OPTIONS, sampleRate: SAMPLE_RATE });
  expect(centsOff(196, result.hz)).toBeLessThan(15);
  expect(result.hz).toBeGreaterThan(180);
});

test('rejects silence and near-silence', () => {
  expect(estimatePitch(new Float32Array(4096), { ...DEFAULT_MPM_OPTIONS, sampleRate: SAMPLE_RATE }).hz).toBe(0);
  const quiet = sine(440, 4096, 0.0005);
  expect(estimatePitch(quiet, { ...DEFAULT_MPM_OPTIONS, sampleRate: SAMPLE_RATE }).hz).toBe(0);
});

test('rejects noise', () => {
  const noise = new Float32Array(4096);
  let seed = 12345;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed / 0x3fffffff - 1) * 0.5;
  }
  const result = estimatePitch(noise, { ...DEFAULT_MPM_OPTIONS, sampleRate: SAMPLE_RATE });
  // Noise has no periodicity, so any detection must be low-confidence.
  expect(result.clarity).toBeLessThan(0.9);
});

test('analyzeTrack covers the signal at the expected frame rate', () => {
  const signal = sine(440, SAMPLE_RATE, 0.5, 2);
  const frames = analyzeTrack(signal, { ...DEFAULT_TRACK_OPTIONS, sampleRate: SAMPLE_RATE });
  const expected = Math.floor((signal.length - DEFAULT_TRACK_OPTIONS.windowSize) / DEFAULT_TRACK_OPTIONS.hopSize) + 1;
  expect(frames.length).toBe(expected);
  expect(frames[0].time).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(centsOff(440, frame.hz)).toBeLessThan(10);
  }
});

test('analyzeTrack reports progress monotonically to 1', () => {
  const signal = sine(330, SAMPLE_RATE * 2, 0.5, 2);
  const seen: number[] = [];
  analyzeTrack(signal, { ...DEFAULT_TRACK_OPTIONS, sampleRate: SAMPLE_RATE }, (f) => seen.push(f));
  expect(seen.length).toBeGreaterThan(1);
  expect(seen[seen.length - 1]).toBe(1);
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
});

test('octave correction folds a half-frequency glitch back up', () => {
  const points: F0Point[] = [
    { time: 0, hz: 440, voiced: 1 },
    { time: 0.1, hz: 220, voiced: 1 }, // dropped an octave for one frame
    { time: 0.2, hz: 440, voiced: 1 },
  ];
  const fixed = smoothTrack(points, { medianRadius: 0, octaveTolerance: 0.75 });
  expect(hzToMidi(fixed[1].hz)).toBeCloseTo(69, 1);
});

test('median filter removes an isolated outlier', () => {
  const points: F0Point[] = [440, 441, 439, 220, 440, 441, 439].map((hz, i) => ({
    time: i * 0.1,
    hz,
    voiced: 1,
  }));
  const fixed = smoothTrack(points, { medianRadius: 2, octaveTolerance: 0.75 });
  for (const point of fixed) {
    expect(hzToMidi(point.hz)).toBeGreaterThan(68.5);
    expect(hzToMidi(point.hz)).toBeLessThan(69.5);
  }
});
