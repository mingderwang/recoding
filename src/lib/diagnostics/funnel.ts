/**
 * Where notes are lost, counted at each stage of the pipeline.
 *
 * This exists because "too many missing notes" has several completely different
 * causes — a detector that never finds the pitch, a filter that throws good
 * frames away, or a segmenter that discards short notes as blips — and they
 * need different fixes. Guessing from the symptom is how the previous bugs
 * happened.
 *
 * It is cheap: every number here is already computed while the audio is being
 * analysed.
 */
export interface FunnelStats {
  /** Analysis windows produced. */
  windows: number;
  /** Windows too quiet to consider. */
  tooQuiet: number;
  /** Audible windows where no pitch was found. */
  noPitchFound: number;
  /** Windows where a pitch was found. */
  detected: number;

  /** Detected frames dropped by the absolute clarity floor. */
  droppedClarityFloor: number;
  /** Detected frames dropped for being much less certain than their neighbours. */
  droppedClarityRatio: number;
  /** Detected frames surviving smoothing. */
  afterSmoothing: number;

  /** Contiguous runs of voiced frames. */
  voicedRuns: number;
  /** Runs discarded for being shorter than the minimum note duration. */
  runsTooShort: number;
  /** Their durations in milliseconds, shortest first, for diagnosis. */
  tooShortDurations: number[];
  /** Notes produced by segmentation. */
  notes: number;

  /** Note pitches as MIDI values. */
  pitches: number[];
  /** Median clarity of detected frames, 0..1. */
  medianClarity: number;
  /** Window size in ms; a note shorter than this cannot be detected at all. */
  windowMs: number;
  /** Minimum note duration in ms that segmentation will keep. */
  minNoteMs: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Compact, human-readable summary of where the notes went. */
export function summariseFunnel(stats: FunnelStats): string {
  const pct = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(0) + '%' : '-');
  return [
    `windows           ${stats.windows}`,
    `  too quiet       ${stats.tooQuiet} (${pct(stats.tooQuiet, stats.windows)})`,
    `  no pitch        ${stats.noPitchFound} (${pct(stats.noPitchFound, stats.windows)})`,
    `  detected        ${stats.detected} (${pct(stats.detected, stats.windows)})`,
    `  dropped floor   ${stats.droppedClarityFloor}`,
    `  dropped ratio   ${stats.droppedClarityRatio}`,
    `  survived        ${stats.afterSmoothing} (${pct(stats.afterSmoothing, stats.detected)})`,
    `voiced runs       ${stats.voicedRuns}`,
    `  too short       ${stats.runsTooShort} (<${stats.minNoteMs}ms)`,
    `notes             ${stats.notes}`,
    `median clarity    ${stats.medianClarity.toFixed(2)}`,
    `window            ${stats.windowMs.toFixed(0)}ms`,
  ].join('\n');
}