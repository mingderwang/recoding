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

/**
 * What the frames themselves say about the input, independent of the notes that
 * came out.
 *
 * This catches a different failure from `measurePlausibility`. A wide, leaping
 * result is evidence *after* the fact; this is evidence *during* analysis.
 *
 * The reasoning is about gaps. A single source recorded in a room — someone
 * singing, or single notes on an instrument — has silence between notes. In a
 * room that silence is lifted off zero by ambient noise, but it stays below the
 * detector's floor. Measured on synthetic signals:
 *
 *   piano, clean silence between notes   42.5% of windows below the floor
 *   piano, room noise floor               58.0%
 *   piano, no gap at all (worst case)      5.1%
 *   piano and a bass line together        0.0%
 *   a held chord                          0.0%
 *
 * So a few per cent is reachable by a single source playing continuously, and
 * exactly zero over several seconds is not.
 *
 * A CAVEAT that matters more than the thresholds. These counters were reported
 * as 0 for every take until the reporting was fixed, because the worker declared
 * them and never incremented them. So this check has never actually run on real
 * input: the thresholds below are calibrated on synthetic signals only, and the
 * margin between "a single source with no gaps" (5.1%) and "several sources"
 * (0.0%) is narrow. It is reported as a suspicion, phrased as one, rather than
 * as a verdict.
 */
export interface SourceProfile {
  windows: number;
  /** Windows whose level was below the detector's silence floor. */
  tooQuiet: number;
  /** Windows in which a pitch was found. */
  detected: number;
  durationSeconds: number;
}

export interface SourceVerdict {
  /** True when the input looks like several sources sounding continuously. */
  continuous: boolean;
  /** Share of windows below the silence floor, 0..1. */
  quietFraction: number;
  /** Share of windows in which a pitch was found, 0..1. */
  pitchedFraction: number;
  message?: string;
  suggestion?: string;
}

/** Below this share of silent windows, the input has no gaps in it at all. */
const CONTINUOUS_QUIET_FRACTION = 0.01;
/** Corroborating condition: sound is present almost throughout. */
const CONTINUOUS_PITCHED_FRACTION = 0.8;
/** Below this length a recording is too short for the absence of gaps to mean much. */
const MIN_SECONDS_FOR_GAP_ANALYSIS = 3;

export function assessSource(profile: SourceProfile): SourceVerdict {
  const quietFraction = profile.windows > 0 ? profile.tooQuiet / profile.windows : 0;
  const pitchedFraction = profile.windows > 0 ? profile.detected / profile.windows : 0;

  const continuous =
    profile.windows > 0 &&
    profile.durationSeconds >= MIN_SECONDS_FOR_GAP_ANALYSIS &&
    quietFraction < CONTINUOUS_QUIET_FRACTION &&
    pitchedFraction > CONTINUOUS_PITCHED_FRACTION;

  if (!continuous) {
    return { continuous, quietFraction, pitchedFraction };
  }

  return {
    continuous,
    quietFraction,
    pitchedFraction,
    message:
      'This recording never pauses — there is no silence anywhere in it. A single voice ' +
      'or instrument normally leaves a gap between notes, so this looks like something ' +
      'else playing throughout: a backing track, or a phone or speaker in the room.',
    suggestion:
      'Record with nothing else playing, or use headphones so only your own sound reaches ' +
      'the microphone. What is printed below followed whichever source was loudest at each ' +
      'moment rather than following one line. This check is new and unproven on real ' +
      'recordings, so it may be wrong.',
  };
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
    return { ok: true, message: 'This reads like a single line.', metrics };
  }

  // "Sing" is wrong wording for a piano or any other instrument, and the
  // suggestion to widen the range is actively unhelpful when the problem is a
  // second source rather than a misplaced one.
  const singer = range?.id === 'piano' ? 'A single line' : 'One voice';

  if (tooWide) {
    return {
      ok: false,
      message:
        `The notes span ${Math.round(metrics.span)} semitones. ${singer} does not cover that much ` +
        'ground, so more than one thing was probably sounding at once.',
      suggestion:
        'Record something played or sung on its own. Widening the range will not help here — ' +
        'the problem is a second sound, not a misplaced one.',
      metrics,
    };
  }

  if (tooLeapy) {
    return {
      ok: false,
      message:
        `${Math.round(metrics.leapFraction * 100)}% of consecutive notes jump by more than an octave. ` +
        `${singer} does not move like that — this is more than one source being tracked.`,
      suggestion:
        'Record on its own, or one note at a time. Picking a narrower range helps only if the ' +
        'other sound sits outside it.',
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

  return { ok: true, message: 'This reads like a single line.', metrics };
}