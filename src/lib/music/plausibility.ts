/**
 * Musical-plausibility metrics for a transcription.
 *
 * These do NOT measure accuracy — that needs the correct melody as ground truth,
 * which we do not have. They measure whether the output is even shaped like one
 * voice singing, which is the thing that broke on the real recording: the
 * detector was hopping between sources, so the line spanned 44 semitones (a
 * tenor spans about 19) and 25% of consecutive notes were leaps bigger than an
 * octave.
 */
export interface PlausibilityMetrics {
  noteCount: number;
  /** Highest minus lowest detected pitch, in semitones. */
  span: number;
  lowest: number;
  highest: number;
  /** Share of consecutive intervals larger than `leapThreshold`. */
  leapFraction: number;
  /** Share of notes inside `lo`..`hi`. */
  inRangeFraction: number;
  /** Consecutive notes repeating the same pitch; a real melody rarely does. */
  repeatFraction: number;
}

export interface PlausibilityOptions {
  lo?: number;
  hi?: number;
  leapThreshold?: number;
}

export function measurePlausibility(
  pitches: number[],
  options: PlausibilityOptions = {},
): PlausibilityMetrics {
  const { lo = 40, hi = 69, leapThreshold = 7 } = options;
  if (pitches.length === 0) {
    return {
      noteCount: 0, span: 0, lowest: 0, highest: 0,
      leapFraction: 0, inRangeFraction: 0, repeatFraction: 0,
    };
  }

  const lowest = Math.min(...pitches);
  const highest = Math.max(...pitches);

  let leaps = 0;
  let repeats = 0;
  for (let i = 1; i < pitches.length; i++) {
    const delta = Math.abs(pitches[i] - pitches[i - 1]);
    if (delta > leapThreshold) leaps++;
    if (delta < 0.5) repeats++;
  }
  const intervals = Math.max(1, pitches.length - 1);
  const inRange = pitches.filter((p) => p >= lo && p <= hi).length;

  return {
    noteCount: pitches.length,
    span: highest - lowest,
    lowest,
    highest,
    leapFraction: leaps / intervals,
    inRangeFraction: inRange / pitches.length,
    repeatFraction: repeats / intervals,
  };
}

/** A single voice spans about 19 semitones; a tenor sits near MIDI 40..69. */
export const SINGLE_VOICE_MAX_SPAN = 26;
export const SINGLE_VOICE_MAX_LEAP_FRACTION = 0.18;
