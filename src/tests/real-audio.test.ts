import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readWavMono } from './lib/read-wav';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS } from '../lib/dsp/frames';
import { smoothTrack } from '../lib/dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS } from '../lib/music/segment';
import { inferGrid, quantizeNotes } from '../lib/music/quantize';
import { buildScore } from '../lib/music/score';

/**
 * A regression test for a bug that only real microphone input could reveal.
 *
 * The confidence floor in `smoothTrack` had been tuned on the synthesised demo
 * phrase, where every frame scores 0.94-0.96. Real recordings are nothing like
 * that: this one has a median frame clarity of 0.65, and a floor of 0.85 threw
 * away 96% of it. Every note was then shorter than the minimum duration, so
 * segmentation found NOTHING and the app reported no pitch at all. Reported by
 * a user singing into the microphone.
 *
 * The lesson is in the assertion names below: a threshold tuned on synthetic
 * fixtures can be catastrophic on real input, and no test built only from
 * synthetic material would ever have shown it.
 *
 * Skipped when the recording is absent.
 */
const WAV = join(process.cwd(), 'out', 'sample.wav');

function transcribe(samples: Float32Array, sampleRate: number) {
  const frames = analyzeTrack(samples, { ...DEFAULT_TRACK_OPTIONS, sampleRate });
  const track = frames.map((f) => ({
    time: f.time,
    hz: f.hz,
    voiced: f.hz > 0 ? 1 : 0,
    clarity: f.clarity,
  }));
  const smoothed = smoothTrack(track);
  const notes = segmentNotes(smoothed, {
    ...DEFAULT_SEGMENT_OPTIONS,
    frameDuration: DEFAULT_TRACK_OPTIONS.hopSize / sampleRate,
  });
  const grid = inferGrid(notes);
  const score = buildScore(quantizeNotes(notes, grid), grid, { tonic: 0, mode: 'major' });
  return { frames, smoothed, notes, grid, score };
}

test.skipIf(!existsSync(WAV))('real microphone audio yields notes, not silence', () => {
  const { samples, sampleRate } = readWavMono(WAV);
  const { frames, notes } = transcribe(samples, sampleRate);

  // The bug: every frame discarded, so segmentation found nothing.
  expect(notes.length).toBeGreaterThan(0);
  // And it should not be a token amount either.
  expect(notes.length).toBeGreaterThanOrEqual(5);
  // Voiced frames must survive the confidence filter.
  const voicedRatio = frames.filter((f) => f.hz > 0).length / frames.length;
  expect(voicedRatio).toBeGreaterThan(0.1);
});

test.skipIf(!existsSync(WAV))('real audio is kept despite much lower clarity than the demo', () => {
  const { samples, sampleRate } = readWavMono(WAV);
  const { frames, smoothed, notes } = transcribe(samples, sampleRate);

  // This is the core of the regression: the filter must not be calibrated to
  // synthetic tone.
  const clarities = frames.filter((f) => f.hz > 0).map((f) => f.clarity).sort((a, b) => a - b);
  const medianClarity = clarities[clarities.length >> 1];
  // A synthesised tone scores above 0.9. Real input is far below that, and the
  // filter has to cope.
  expect(medianClarity).toBeLessThan(0.85);

  // Yet notes still come out. Before the fix this was 11 voiced frames and 0
  // notes; the bar is set well above the broken behaviour so a regression to
  // "almost everything discarded" fails loudly.
  const surviving = smoothed.filter((p) => p.hz > 0).length;
  const detected = frames.filter((f) => f.hz > 0).length;
  expect(surviving / detected).toBeGreaterThan(0.5);
  expect(notes.length).toBeGreaterThanOrEqual(5);
});

test.skipIf(!existsSync(WAV))('real audio produces a score that can be exported', () => {
  const { samples, sampleRate } = readWavMono(WAV);
  const { score, notes } = transcribe(samples, sampleRate);
  // Everything downstream assumes a non-empty score: the renderer draws staves,
  // the MIDI writer emits note events, and the UI prints a note count.
  expect(notes.length).toBeGreaterThan(0);
  expect(score.measures.length).toBeGreaterThan(0);
  expect(score.totalUnits % score.unitsPerMeasure).toBe(0);
  expect(score.events.some((e) => e.type === 'note')).toBe(true);
});
