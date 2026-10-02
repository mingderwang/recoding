import { snapToScale, type Key } from './notes';
import type { QuantizedNote, RhythmGrid } from './quantize';

/** Everything below is measured in sixteenth-note units, independent of the
 *  grid resolution that produced it. */
export const UNITS_PER_BEAT = 4;

export type ScoreEvent =
  | { type: 'note'; start: number; duration: number; midi: number; tie: boolean; confidence: number }
  | { type: 'rest'; start: number; duration: number };

export interface Measure {
  index: number;
  start: number;
  units: number;
}

export interface Score {
  key: Key;
  grid: RhythmGrid;
  events: ScoreEvent[];
  /** Total length in sixteenth units, rounded up to whole measures. */
  totalUnits: number;
  unitsPerMeasure: number;
  measures: Measure[];
}

export interface BuildScoreOptions {
  /** Snap pitches to the key's scale. */
  snapToKey: boolean;
  /** Extend the final measure to a full bar. */
  padToFullMeasure: boolean;
}

export const DEFAULT_BUILD_OPTIONS: BuildScoreOptions = {
  snapToKey: true,
  padToFullMeasure: true,
};

/** Convert grid steps to sixteenth units. */
export function stepsToUnits(steps: number, grid: RhythmGrid): number {
  return steps * grid.beatsPerStep * UNITS_PER_BEAT;
}

/**
 * Assemble the engraved score: place notes on a bar grid, insert rests for
 * gaps, split anything that crosses a barline into tied notes, and pad the
 * last bar so the phrase ends cleanly.
 */
export function buildScore(
  notes: QuantizedNote[],
  grid: RhythmGrid,
  key: Key,
  options: BuildScoreOptions = DEFAULT_BUILD_OPTIONS,
): Score {
  const unitsPerMeasure = Math.max(1, Math.round(grid.beatsPerMeasure * UNITS_PER_BEAT));
  const placed = notes
    .map((note) => ({
      start: stepsToUnits(note.startStep, grid),
      duration: Math.max(1, stepsToUnits(note.durationSteps, grid)),
      midi: options.snapToKey ? snapToScale(note.midi, key) : Math.round(note.midi),
      confidence: note.confidence,
    }))
    .sort((a, b) => a.start - b.start);

  // Fill the gaps between onsets with rests.
  const withRests: Array<{
    type: 'note' | 'rest';
    start: number;
    duration: number;
    midi?: number;
    confidence: number;
  }> = [];
  let cursor = 0;
  for (const note of placed) {
    const start = Math.max(cursor, note.start);
    if (start - cursor >= 1) {
      withRests.push({ type: 'rest', start: cursor, duration: start - cursor, confidence: 1 });
    }
    withRests.push({ type: 'note', start, duration: note.duration, midi: note.midi, confidence: note.confidence });
    cursor = start + note.duration;
  }

  const contentEnd = cursor;
  const totalUnits = options.padToFullMeasure
    ? Math.max(unitsPerMeasure, Math.ceil(contentEnd / unitsPerMeasure) * unitsPerMeasure)
    : Math.max(1, contentEnd);
  if (totalUnits - contentEnd >= 1) {
    withRests.push({ type: 'rest', start: contentEnd, duration: totalUnits - contentEnd, confidence: 1 });
  }

  // Split at barlines, marking the left half of each split as tied.
  const events: ScoreEvent[] = [];
  for (const event of withRests) {
    let remainingStart = event.start;
    let remaining = event.duration;
    while (remaining > 0) {
      const barEnd = (Math.floor(remainingStart / unitsPerMeasure) + 1) * unitsPerMeasure;
      const chunk = Math.min(remaining, barEnd - remainingStart);
      if (event.type === 'rest') {
        events.push({ type: 'rest', start: remainingStart, duration: chunk });
      } else {
        events.push({
          type: 'note',
          start: remainingStart,
          duration: chunk,
          midi: event.midi as number,
          tie: remaining > chunk,
          confidence: event.confidence,
        });
      }
      remainingStart += chunk;
      remaining -= chunk;
    }
  }

  const measures: Measure[] = [];
  for (let i = 0; i < totalUnits / unitsPerMeasure; i++) {
    measures.push({ index: i, start: i * unitsPerMeasure, units: unitsPerMeasure });
  }

  return { key, grid, events, totalUnits, unitsPerMeasure, measures };
}

/** Note events only, in time order. */
export function pitchedEvents(score: Score): Array<Extract<ScoreEvent, { type: 'note' }>> {
  return score.events.filter((e): e is Extract<ScoreEvent, { type: 'note' }> => e.type === 'note');
}
