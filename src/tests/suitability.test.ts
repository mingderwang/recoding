/**
 * The two ways an input can be unsuitable.
 *
 * `measurePlausibility` judges the notes that came out. `assessSource` judges
 * the frames that went in, and it exists because a user's take came back
 * looking implausible with no explanation attached — and because the one signal
 * that would have explained it, that the recording never goes quiet, was being
 * computed for the funnel and then thrown away.
 */
import { describe, expect, test } from 'bun:test';
import { assessInput } from '../lib/music/suitability';
import { assessSource } from '../lib/music/suitability';
import { VOICE_RANGES } from '../lib/music/voice-range';

describe('assessSource', () => {
  /** The user's take, verbatim from the feedback report. */
  const reported = {
    windows: 2868,
    tooQuiet: 0,
    detected: 2387,
    durationSeconds: 33.5,
  };

  test('flags the take that was reported as having missing notes', () => {
    const verdict = assessSource(reported);
    expect(verdict.continuous).toBe(true);
    expect(verdict.quietFraction).toBe(0);
    expect(verdict.pitchedFraction).toBeCloseTo(0.832, 2);
    expect(verdict.message).toBeTruthy();
  });

  test('the message names the likely cause rather than saying "wrong notes"', () => {
    // "Notes are missing" was the complaint. A message that does not point at a
    // second source sends the user hunting for missing notes that were never
    // lost.
    //
    // The numbers here are the ones the report claimed, including a quiet count
    // of 0 that was in fact a constant. The check is still worth pinning, but
    // what it is pinned against is the shape of a continuous recording, not
    // proof that this take had one.
    const { message } = assessSource(reported);
    expect(message).toContain('never pauses');
    expect(message as string).toContain('backing track');
  });

  test('does not flag a single source with real gaps', () => {
    // Measured: 42.5% of windows below the floor, with clean silence between
    // notes; 58.0% with a room noise floor.
    for (const tooQuiet of [57, 152, 58]) {
      const verdict = assessSource({
        windows: 264,
        tooQuiet,
        detected: 106,
        durationSeconds: 6,
      });
      expect(verdict.continuous).toBe(false);
    }
  });

  test('does not flag a single source playing with no gap at all', () => {
    // The false-positive risk, measured at 5.1% quiet. If the threshold were set
    // above this, a legitimate legato performance would be rejected.
    const verdict = assessSource({ windows: 548, tooQuiet: 28, detected: 519, durationSeconds: 6.4 });
    expect(verdict.quietFraction).toBeCloseTo(0.051, 2);
    expect(verdict.continuous).toBe(false);
  });

  test('needs several seconds before an absence of gaps means anything', () => {
    const short = assessSource({ windows: 60, tooQuiet: 0, detected: 60, durationSeconds: 0.7 });
    expect(short.continuous).toBe(false);
  });

  test('does not flag silence that is simply very quiet', () => {
    // No pitch found everywhere is a quiet recording, not a crowded one.
    const verdict = assessSource({ windows: 1000, tooQuiet: 900, detected: 100, durationSeconds: 12 });
    expect(verdict.continuous).toBe(false);
  });

  test('survives an empty analysis', () => {
    const verdict = assessSource({ windows: 0, tooQuiet: 0, detected: 0, durationSeconds: 0 });
    expect(verdict.continuous).toBe(false);
    expect(verdict.quietFraction).toBe(0);
    expect(verdict.message).toBeUndefined();
  });
});

describe('assessInput wording', () => {
  const spread = [34, 40, 45, 52, 60, 64, 70, 78, 84, 90, 100, 106];

  test('a six-octave result is rejected', () => {
    expect(assessInput(spread, { range: VOICE_RANGES.piano }).ok).toBe(false);
  });

  test('does not tell a piano player that one voice cannot cover the ground', () => {
    // "wider than one voice can sing" is simply wrong for an instrument.
    const { message } = assessInput(spread, { range: VOICE_RANGES.piano });
    expect(message).not.toContain('one voice can sing');
    expect(message).not.toContain('One voice');
    expect(message).toContain('A single line');
  });

  test('does not suggest widening the range when the cause is a second source', () => {
    // The old advice was actively wrong here: widening the band cannot fix a
    // second instrument, and it makes octave confusion more likely.
    const { suggestion } = assessInput(spread, { range: VOICE_RANGES.piano });
    expect(suggestion).not.toContain('wider range');
  });

  test('a normal single line passes', () => {
    const line = [55, 57, 59, 60, 62, 64, 62, 60, 59, 57, 55, 57, 59];
    expect(assessInput(line, { range: VOICE_RANGES.tenor }).ok).toBe(true);
  });
});