import {
  measurePlausibility,
  SINGLE_VOICE_MAX_LEAP_FRACTION,
  SINGLE_VOICE_MAX_SPAN,
  type PlausibilityMetrics,
} from './plausibility';
import type { VoiceRange } from './voice-range';

/**
 * Whether an input looks like one voice, or like several sources at once.
 *
 * The app is a monophonic pitch tracker: at any moment it reports whichever
 * periodic pitch is locally strongest. Handed a recording with accompaniment,
 * that means the answer follows the loudest source, changing whenever another
 * one overtakes it. The result is not a slightly wrong melody, it is a line
 * that jumps around and cannot be read.
 *
 * That is worth saying out loud. Printing a confident-looking score full of
 * leaps tells the user nothing about why it is unusable, and they reasonably
 * conclude the app is broken rather than that the input was unsuitable.
 *
 * The tests below are shaped by a real failure: a tenor recording with
 * accompaniment produced a 44-semitone span with 55% of consecutive intervals
 * larger than an octave. A single voice spans about 19 semitones and is
 * overwhelmingly stepwise.
 */
export interface Suitability {
  ok: boolean;
  /** One short sentence for the UI. */
  message: string;
  /** What to try instead, when there is something useful to suggest. */
  suggestion?: string;
  metrics: PlausibilityMetrics;
}

export interface AssessOptions {
  range?: VoiceRange;
}

export function assessInput(pitches: number[], options: AssessOptions = {}): Suitability {
  const metrics = measurePlausibility(pitches);
  const range = options.range;

  if (metrics.noteCount === 0) {
    return {
      ok: false,
      message: 'No clear pitch was found. Nothing in this recording has a steady enough pitch to read.',
      metrics,
    };
  }

  const tooWide = metrics.span > SINGLE_VOICE_MAX_SPAN;
  const tooLeapy = metrics.leapFraction > SINGLE_VOICE_MAX_LEAP_FRACTION;
  const outOfRange = range
    ? (metrics.lowest < range.lowMidi - 3 || metrics.highest > range.highMidi + 3)
    : false;

  if (!tooWide && !tooLeapy && !outOfRange) {
    return { ok: true, message: 'This reads like a single voice.', metrics };
  }

  // Nudge toward a range change when that is the likeliest lever, since it is
  // the one that measurably helps.
  if (tooWide && range && range.id !== 'auto') {
    return {
      ok: false,
      message:
        `The notes span ${Math.round(metrics.span)} semitones, which is wider than one voice can sing. ` +
        'This looks like more than one thing sounding at once.',
      suggestion: 'Try "Any voice" or a wider range, or record a passage with no accompaniment.',
      metrics,
    };
  }

  if (tooLeapy) {
    return {
      ok: false,
      message:
        `${Math.round(metrics.leapFraction * 100)}% of consecutive notes jump by more than an octave. ` +
        'One voice does not move like that — this is more than one source being tracked.',
      suggestion:
        'Record a cappella, or a single unaccompanied note at a time. Picking a narrower ' +
        'voice range also helps.',
      metrics,
    };
  }

  if (outOfRange && range) {
    return {
      ok: false,
      message: `Some notes fall outside ${range.label.toLowerCase()}.`,
      suggestion: 'Try a different voice range.',
      metrics,
    };
  }

  return { ok: true, message: 'This reads like a single voice.', metrics };
}