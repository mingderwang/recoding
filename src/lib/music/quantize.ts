import type { DetectedNote } from './segment';

export interface RhythmGrid {
  /** Beats per minute, rounded to an integer. */
  bpm: number;
  /** Grid resolution in beats. 0.25 = a sixteenth note. */
  beatsPerStep: number;
  /** Seconds per grid step. */
  secondsPerStep: number;
  /** Time signature denominator — the note value that gets one beat. */
  beatsPerMeasure: number;
  /** How many grid steps fill one measure. */
  stepsPerMeasure: number;
  /** Lower is better; exposed for debugging. */
  cost: number;
}

export interface QuantizedNote {
  /** Position on the grid, counted from the first onset. */
  startStep: number;
  durationSteps: number;
  /** Fractional MIDI value, before key snapping. */
  midi: number;
  confidence: number;
}

export interface GridOptions {
  minBpm: number;
  maxBpm: number;
  /** Candidate grid resolutions, in beats. */
  candidates: number[];
  beatsPerMeasure: number;
}

export const DEFAULT_GRID_OPTIONS: GridOptions = {
  minBpm: 40,
  maxBpm: 208,
  candidates: [0.25, 0.5, 1],
  beatsPerMeasure: 4,
};

/** How strongly to prefer longer note values when several temnos fit equally. */
const COARSENESS_WEIGHT = 0.25;

/**
 * Strength of the "one note per beat" preference. Large enough to break the
 * ties that pure rhythm evidence cannot (a slow melody and the same melody at
 * double speed fit the samples identically), small enough that genuinely
 * detected subdivisions still win on alignment.
 */
const METRICAL_WEIGHT = 0.12;

/** Finest subdivision considered, in steps per inter-onset interval. */
const MAX_STEPS_PER_INTERVAL = 12;

/**
 * Search (tempo x grid resolution) for the rhythmic grid that best explains the
 * observed onsets and offsets.
 *
 * The score has three terms, and the first two are what make it work:
 *
 *  - `alignment`, the distance in *seconds* the onsets and offsets must move to
 *    land on the grid, weighted by note length. Measuring it in absolute time
 *    rather than in fractions of a step is essential: a fractional measure is
 *    scale-free, so a grid far too fine always looks near-perfect and a
 *    metronomic 0.5s beat would be "explained" by a 0.166s grid to within
 *    3 milliseconds.
 *  - `resolution`, a penalty proportional to the number of grid steps per
 *    inter-onset interval. This is what selects the *coarsest* grid that fits,
 *    so 0.5s beats are notated as quarter notes at 120bpm rather than as
 *    sixteenths at 240bpm, which fits them just as exactly.
 *  - `tempoCost`, a soft prior toward a comfortable singing range, narrow enough
 *    that it only breaks ties rather than over-riding the evidence.
 */
export function inferGrid(
  notes: DetectedNote[],
  options: GridOptions = DEFAULT_GRID_OPTIONS,
): RhythmGrid {
  const { minBpm, maxBpm, candidates, beatsPerMeasure } = options;
  if (notes.length === 0) return defaultGrid(beatsPerMeasure);

  const origin = Math.min(...notes.map((n) => n.start));
  const span = Math.max(...notes.map((n) => n.end)) - origin;

  // Typical spacing between onsets, used to score alignment in absolute time
  // and to judge how fine the grid is relative to the material.
  const onsets = notes.map((n) => n.start).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    if (onsets[i] - onsets[i - 1] > 0.01) intervals.push(onsets[i] - onsets[i - 1]);
  }
  const referenceInterval = intervals.length > 0 ? median(intervals) : span;

  if (span <= 0) return defaultGrid(beatsPerMeasure);

  let best: RhythmGrid | null = null;

  // Search over grid-step *durations* rather than over BPM. The candidates that
  // matter are the ones where a whole number of steps fills each observed onset
  // interval, so seeding from the real intervals lands on them directly. A flat
  // sweep over BPM would need a step small enough to hit the answer and still
  // be fine enough to be cheap, and a local refinement cannot recover from
  // missing it: sweeping 40-208 by 24 never tries 120 at all.
  const seeds = new Set<number>();
  for (const interval of intervals) {
    for (let k = 1; k <= MAX_STEPS_PER_INTERVAL; k++) {
      const sps = interval / k;
      if (sps > 0) seeds.add(sps);
    }
  }
  // Multiples of the reference interval, for sustained or isochronous material
  // where every interval is the same.
  for (let k = 1; k <= 4; k++) seeds.add(referenceInterval * k);
  // A coarse BPM sweep as a safety net, in case the material has no clear pulse.
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 8) seeds.add((60 / bpm) * 0.5);

  for (const secondsPerStep of seeds) {
    for (const beatsPerStep of candidates) {
      const secondsPerBeat = secondsPerStep / beatsPerStep;
      const bpm = 60 / secondsPerBeat;
      if (bpm < minBpm || bpm > maxBpm) continue;
      consider(Math.round(bpm), beatsPerStep);
    }
  }

  // No candidate survived: the material is too brief or too irregular to imply
  // a grid (a single click, two 10ms blips). Fall back to a plain 120bpm so
  // downstream code always receives a usable grid instead of null.
  return best ?? defaultGrid(beatsPerMeasure);

  function consider(bpm: number, beatsPerStep: number): void {
    const secondsPerBeat = 60 / bpm;
    const secondsPerStep = secondsPerBeat * beatsPerStep;
    // A grid much finer than the material is a bad hypothesis; a grid coarser
    // than the whole clip collapses everything into one note.
    if (secondsPerStep * 2 > span) return;

    let weighted = 0;
    let totalWeight = 0;
    let collapsed = 0;
    for (const note of notes) {
      const weight = 1 + Math.sqrt(note.end - note.start);
      const startDelta = Math.abs(roundToStep(note.start - origin, secondsPerStep) - (note.start - origin));
      const endDelta = Math.abs(roundToStep(note.end - origin, secondsPerStep) - (note.end - origin));
      weighted += (startDelta + endDelta) * weight;
      totalWeight += weight;
      const steps = (note.end - note.start) / secondsPerStep;
      if (steps < 0.5) collapsed++;
    }
    if (totalWeight === 0) return;

    // Absolute misalignment, in fractions of a typical onset interval, so it
    // is comparable across tempos without being scale-free.
    const alignment = weighted / totalWeight / referenceInterval;
    // How many grid steps fall in a typical inter-onset interval. One is the
    // natural reading: a note per beat. Values above one mean the notes are
    // being described as subdivisions of a slower beat, which would notate a
    // 90bpm melody as 180bpm because the two are physically identical.
    //
    // The penalty is two-sided in log space, so a grid far too COARSE (one
    // long note swallowing several detected onsets) is punished too.
    const stepsPerInterval = referenceInterval / secondsPerStep;
    const metricalPenalty = Math.abs(Math.log2(Math.max(1e-6, stepsPerInterval))) * METRICAL_WEIGHT;
    // One physical grid can be notated at several tempos (a 0.5s beat is half
    // notes at 60, quarters at 120, eighths at 240). Penalising finer note
    // values picks the idiomatic one: the same notes read better as quarters at
    // 120 than as halves at 60.
    const coarsenessPenalty = (1 / beatsPerStep - 1) * COARSENESS_WEIGHT;
    const tempoPrior = tempoCost(bpm);
    const collapsePenalty = (collapsed / notes.length) * 2;
    const cost =
      alignment + metricalPenalty + coarsenessPenalty + tempoPrior + collapsePenalty;

    if (!best || cost < best.cost) {
      best = {
        bpm: Math.round(bpm),
        beatsPerStep,
        secondsPerStep,
        beatsPerMeasure,
        stepsPerMeasure: Math.round(beatsPerMeasure / beatsPerStep),
        cost,
      };
    }
  }
}

/**
 * Soft prior, centred on 108bpm. Its range is deliberately narrow (0.15-0.40)
 * so it only breaks ties between grids that the onsets fit about equally well.
 * A wider prior will happily override real evidence: on a metronomically even
 * phrase, several (tempo x resolution) pairs fit perfectly, and a strong prior
 * picks the comfortable one rather than the true one.
 */
function tempoCost(bpm: number): number {
  const z = (bpm - 108) / 70;
  // The range is deliberately narrow. It was 0.15-0.40, which spanned 0.25 —
  // more than the alignment evidence can overcome. A phrase written at 100bpm
  // was then transcribed at 204bpm, because the prior liked 204 more than 100
  // by a wider margin than 100 fitted the onsets better.
  //
  // It now spans 0.06, so it can only break a genuine tie and never overrule
  // the audio. Alignment differences between neighbouring tempi are of order
  // 0.1-0.3 here, which is more than enough for the evidence to dominate.
  return 0.03 + 0.03 * Math.exp(-0.5 * z * z);
}

/** Plain 120bpm, used when there is no material to infer anything from. */
function defaultGrid(beatsPerMeasure: number): RhythmGrid {
  const beatsPerStep = 0.5;
  return {
    bpm: 120,
    beatsPerStep,
    secondsPerStep: (60 / 120) * beatsPerStep,
    beatsPerMeasure,
    stepsPerMeasure: Math.round(beatsPerMeasure / beatsPerStep),
    cost: 0,
  };
}

function roundToStep(value: number, secondsPerStep: number): number {
  return Math.round(value / secondsPerStep) * secondsPerStep;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Snap detected notes onto a grid, dropping and growing notes as needed. */
export function quantizeNotes(notes: DetectedNote[], grid: RhythmGrid): QuantizedNote[] {
  if (notes.length === 0) return [];
  const origin = Math.min(...notes.map((n) => n.start));
  const sps = grid.secondsPerStep;

  const snapped = notes
    .map((note) => {
      const startStep = Math.max(0, Math.round((note.start - origin) / sps));
      let endStep = Math.max(0, Math.round((note.end - origin) / sps));
      if (endStep <= startStep) endStep = startStep + 1;
      return {
        startStep,
        durationSteps: endStep - startStep,
        midi: note.midi,
        confidence: note.confidence,
      };
    })
    .sort((a, b) => a.startStep - b.startStep);

  // Two notes can round onto the same step. Keep the louder one and let the
  // other extend past it, so a held note is not clipped by its neighbour.
  const resolved: QuantizedNote[] = [];
  for (const note of snapped) {
    const prev = resolved[resolved.length - 1];
    if (prev && note.startStep < prev.startStep + prev.durationSteps) {
      const prevEnd = prev.startStep + prev.durationSteps;
      if (note.confidence > prev.confidence) {
        prev.durationSteps = Math.max(1, note.startStep - prev.startStep);
        resolved.push({ ...note });
        prev.durationSteps = Math.max(1, prevEnd - note.startStep);
      } else {
        prev.durationSteps = Math.max(prev.durationSteps, prevEnd - note.startStep);
        prev.durationSteps = Math.max(prev.durationSteps, note.startStep + note.durationSteps - prev.startStep);
      }
      continue;
    }
    resolved.push({ ...note });
  }
  return resolved;
}
