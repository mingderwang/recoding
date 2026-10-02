import { hzToMidi, medianFilter, type F0Point } from '../dsp/smooth';

export interface DetectedNote {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** Fractional MIDI value before key snapping. */
  midi: number;
  /** 0..1, share of frames in the note that were clearly voiced. */
  confidence: number;
}

export interface SegmentOptions {
  /** Frame spacing in seconds, derived from the analysis hop size. */
  frameDuration: number;
  /** Bridge unvoiced gaps up to this long (vibrato troughs, breath). */
  maxGapSeconds: number;
  /** Discard notes shorter than this. */
  minDurationSeconds: number;
  /** Pitch move that starts a new note, in semitones. */
  splitSemitones: number;
  /** Merge neighbouring notes that differ by less than this. */
  mergeSemitones: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  frameDuration: 512 / 44100,
  maxGapSeconds: 0.045,
  minDurationSeconds: 0.07,
  splitSemitones: 0.85,
  mergeSemitones: 0.4,
};

interface Run {
  startFrame: number;
  endFrame: number;
}

/** Group voiced frames into runs, bridging short unvoiced gaps. */
function findRuns(track: F0Point[], maxGapFrames: number): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  let gap = 0;

  for (let i = 0; i < track.length; i++) {
    if (track[i].voiced === 1) {
      if (current && i - current.endFrame <= maxGapFrames + 1) {
        current.endFrame = i;
      } else {
        current = { startFrame: i, endFrame: i };
        runs.push(current);
      }
      gap = 0;
    } else if (current) {
      gap++;
      if (gap > maxGapFrames) current = null;
    }
  }
  return runs;
}

/**
 * Turn a continuous f0 track into discrete note events.
 *
 * Within each voiced run the local median of the pitch is compared against the
 * median of the note being accumulated; a sustained move larger than
 * `splitSemitones` opens a new note. Using a local median as the reference
 * means vibrato and scoop-into-note do not cause spurious splits, while a real
 * leap does.
 */
export function segmentNotes(
  track: F0Point[],
  options: SegmentOptions = DEFAULT_SEGMENT_OPTIONS,
): DetectedNote[] {
  const { frameDuration, maxGapSeconds, minDurationSeconds, splitSemitones, mergeSemitones } = options;
  const maxGapFrames = Math.max(1, Math.round(maxGapSeconds / frameDuration));
  const medianRadius = 3;

  const raw: DetectedNote[] = [];
  for (const run of findRuns(track, maxGapFrames)) {
    const length = run.endFrame - run.startFrame + 1;
    if (length < 1) continue;

    const indices: number[] = [];
    for (let i = run.startFrame; i <= run.endFrame; i++) {
      if (track[i].voiced === 1) indices.push(i);
    }
    if (indices.length === 0) continue;

    const values = indices.map((i) => hzToMidi(track[i].hz));
    const localMedian = medianFilter(values, medianRadius);

    let noteStart = 0;
    let accumulator: number[] = [];
    const flush = (uptoExclusive: number) => {
      if (accumulator.length === 0) return;
      const sorted = accumulator.slice().sort((a, b) => a - b);
      const midi = sorted[sorted.length >> 1];
      const start = indices[noteStart];
      const last = indices[Math.min(uptoExclusive, indices.length) - 1];
      const startTime = track[start].time;
      const endTime = track[last].time + frameDuration;
      const confidence =
        accumulator.length / Math.max(1, Math.min(uptoExclusive, indices.length) - noteStart);
      raw.push({ start: startTime, end: endTime, midi, confidence: Math.min(1, confidence) });
      accumulator = [];
    };

    for (let k = 0; k < values.length; k++) {
      accumulator.push(values[k]);
      const noteMedian = medianOf(accumulator);
      if (
        accumulator.length > medianRadius &&
        Math.abs(localMedian[k] - noteMedian) > splitSemitones
      ) {
        flush(k);
        noteStart = k;
        accumulator.push(values[k]);
      }
    }
    flush(values.length);
  }

  const kept = raw.filter((n) => n.end - n.start >= minDurationSeconds);
  return snapBoundaries(mergeAdjacent(kept, mergeSemitones));
}

/**
 * Pull note boundaries onto the median onset spacing.
 *
 * Short notes are detected unreliably: an analysis window is longer than a
 * sixteenth note, so its centre can fall on either side of a real note change
 * and a note's measured start or end can be off by tens of milliseconds. Left
 * alone, those errors jitter the onsets enough to mislead the tempo search —
 * a run of even eighths comes out with intervals of 163, 209 and 244ms
 * instead of a constant 213, and the search reads that as a faster, uneven
 * tempo.
 *
 * Replacing each boundary with the median interval between its neighbours, and
 * keeping the midpoint of the original and the snapped value, removes the
 * jitter while staying anchored to the audio. Boundaries with no neighbour to
 * learn a spacing from are left alone.
 */
function snapBoundaries(notes: DetectedNote[], limit = 0.35): DetectedNote[] {
  if (notes.length < 3) return notes;
  const out = notes.map((n) => ({ ...n }));

  const onsets = notes.map((n) => n.start);
  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const delta = onsets[i] - onsets[i - 1];
    if (delta > 0.01) intervals.push(delta);
  }
  if (intervals.length < 2) return notes;
  const spacing = median(intervals);

  // A wildly different spacing means the phrase changed character (a rest, a
  // held note); trust the audio rather than smearing across the change.
  const stable = intervals.filter((v) => Math.abs(v - spacing) / spacing <= limit);
  if (stable.length < intervals.length / 2) return notes;
  const localSpacing = median(stable);

  for (let i = 1; i < out.length; i++) {
    out[i].start = out[i].start + (out[i - 1].start + localSpacing - out[i].start) * 0.5;
  }
  for (let i = 0; i < out.length - 1; i++) {
    out[i].end = out[i].end + (out[i + 1].start - out[i].end) * 0.5;
  }
  // Snapping must not invert or invert into a neighbour.
  for (let i = 0; i < out.length; i++) {
    if (out[i].end < out[i].start) out[i].end = out[i].start;
    if (i > 0 && out[i].start < out[i - 1].start) out[i].start = out[i - 1].start + 0.01;
  }
  return out;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function medianOf(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Weld neighbouring notes that are the same pitch separated by a hairline gap. */
function mergeAdjacent(notes: DetectedNote[], threshold: number): DetectedNote[] {
  const out: DetectedNote[] = [];
  for (const note of notes) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(note.midi - prev.midi) < threshold && note.start - prev.end < 0.06) {
      prev.end = note.end;
      prev.midi = (prev.midi + note.midi) / 2;
      prev.confidence = Math.max(prev.confidence, note.confidence);
      continue;
    }
    out.push({ ...note });
  }
  return out;
}
