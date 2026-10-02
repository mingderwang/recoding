/** A single point in the fundamental-frequency track. */
export interface F0Point {
  time: number;
  /** 0 when the frame is unvoiced. */
  hz: number;
  /** 1 when voiced. */
  voiced: number;
  /**
   * Detector confidence, 0..1. Undefined where not measured.
   *
   * This is what separates a real sustained note from an artefact. At a note
   * boundary an analysis window straddles two notes, and the pitch it reports
   * is usually both wrong and less certain about it: measured on the demo
   * phrase, frames inside a note scored 0.94-0.96 while the three boundary
   * frames that read two octaves low scored 0.73.
   */
  clarity?: number;
}

/** Converts a pitch track to MIDI-number space, which is where the rest of the
 *  pipeline does its arithmetic (octave jumps become plain integer errors). */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * How much less certain a new pitch may be than the one it replaces and still
 * be believed.
 *
 * This is a RATIO, not an absolute level, and that distinction matters. An
 * absolute floor tuned on a synthesised tone (which scores 0.94-0.96) threw
 * away 96% of real microphone input, which on a typical recording has a median
 * clarity of 0.65 — every frame was below the bar and the app found no notes
 * at all. Comparing against the surrounding frames instead is scale-free: a
 * window-straddling artefact is far worse than the note either side of it
 * (0.73 against 0.95 on the demo, and the same relative drop on real audio),
 * so the ratio separates them without assuming anything about the recording.
 */
const MIN_CLARITY_RETENTION = 0.9;

/** Running median filter — kills isolated octave errors without smearing vibrato. */
export function medianFilter(values: number[], radius: number): number[] {
  if (radius < 1 || values.length === 0) return values.slice();
  const out = new Array<number>(values.length);
  const window: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length - 1, i + radius);
    window.length = 0;
    for (let j = lo; j <= hi; j++) window.push(values[j]);
    window.sort((a, b) => a - b);
    out[i] = window[window.length >> 1];
  }
  return out;
}

/**
 * Folds obviously-wrong octave jumps back onto the previous note.
 *
 * A drop of roughly one octave between consecutive frames is almost always a
 * detector error rather than a real leap, so we pull it back to the nearest
 * octave of the running value.
 */
/**
 * Fold octave errors back onto the running pitch.
 *
 * A drop of roughly one octave between consecutive frames is almost always a
 * detector error rather than a real leap, so it is folded down.
 *
 * The correction only applies when the new pitch PERSISTS for a few frames.
 * That condition is the whole point: a single spurious frame can otherwise
 * take over the track. A walk that trusts every frame is a chain, so one bad
 * reading becomes the reference for everything after it — measured on the demo
 * phrase, one frame reporting 48.0 instead of 72.0 dragged the entire
 * following note down two octaves, and nothing ever pulled it back. Requiring
 * the new pitch to hold means an isolated outlier is ignored while a genuine
 * octave error, which lasts for as long as the note does, is still corrected.
 */
export function correctOctaveJumps(
  track: F0Point[],
  toleranceSemitones = 0.75,
  persistenceFrames = 3,
): F0Point[] {
  const out = track.map((p) => ({ ...p }));

  /** Length of the constant-pitch run beginning at `from`. */
  const runLength = (from: number): number => {
    const start = hzToMidi(out[from].hz);
    let count = 0;
    for (let j = from; j < out.length; j++) {
      if (out[j].hz <= 0) break;
      if (Math.abs(hzToMidi(out[j].hz) - start) > toleranceSemitones) break;
      count++;
    }
    return count;
  };

  let i = 1;
  while (i < out.length) {
    if (out[i].hz <= 0) {
      i++;
      continue;
    }
    if (out[i - 1].hz <= 0) {
      i++;
      continue;
    }

    const reference = hzToMidi(out[i - 1].hz);
    const current = hzToMidi(out[i].hz);
    if (Math.abs(current - reference) <= toleranceSemitones) {
      i++;
      continue;
    }

    // A whole run is corrected at once, not frame by frame. Correcting
    // individually leaves the run half-folded: the first frame moves an octave,
    // so the next frame no longer looks like a jump from its uncorrected
    // neighbour, and the run ends up as a staircase instead of one pitch.
    const length = runLength(i);
    if (length < persistenceFrames) {
      i++;
      continue;
    }

    // A boundary artefact is also LESS CERTAIN than the note before it, which
    // is what separates it from a real sustained note. Real frames score
    // 0.94-0.96; window-straddling artefacts score around 0.73.
    const clarityHere = out[i].clarity;
    const clarityBefore = out[i - 1].clarity;
    if (clarityHere !== undefined && clarityBefore !== undefined) {
      if (clarityHere < clarityBefore * MIN_CLARITY_RETENTION) {
        i++;
        continue;
      }
    }

    let shift = 0;
    for (const candidate of [12, -12, 24, -24]) {
      if (Math.abs(current - candidate - reference) <= toleranceSemitones) {
        shift = candidate;
        break;
      }
    }
    if (shift !== 0) {
      for (let j = i; j < i + length; j++) {
        out[j].hz = midiToHz(hzToMidi(out[j].hz) - shift);
      }
    }
    i += length;
  }
  return out;
}

export interface SmoothOptions {
  /** Median filter radius in frames. */
  medianRadius: number;
  octaveTolerance: number;
  /**
   * Absolute floor below which a frame is discarded regardless of its
   * neighbours. Only catches frames with no periodicity at all.
   */
  clarityFloor: number;
  /**
   * How much less certain than its neighbourhood a frame must be to be
   * discarded. This is the discriminating test; see `smoothTrack`.
   */
  clarityRetention: number;
}

/** Defaults shared by every caller, so the thresholds cannot drift apart. */
export const DEFAULT_SMOOTH_OPTIONS: SmoothOptions = {
  medianRadius: 2,
  octaveTolerance: 0.75,
  // Below the 0.49 floor the detector already applies, so this rarely fires.
  clarityFloor: 0.45,
  // Boundary artefacts score ~0.73 against neighbours at ~0.95 on the demo,
  // a ratio of 0.77. 0.9 sits clear of that and of the mild dips real audio
  // shows within a sustained note.
  clarityRetention: 0.9,
};

/** Median filter then octave repair, applied in place on a copy. */
export function smoothTrack(track: F0Point[], partial?: Partial<SmoothOptions>): F0Point[] {
  const options: SmoothOptions = { ...DEFAULT_SMOOTH_OPTIONS, ...partial };

  // Drop frames that are much less certain than the neighbourhood around them,
  // BEFORE the median filter. A window straddling a note boundary reports the
  // wrong pitch and is much less sure of it.
  //
  // The comparison is against the MEDIAN clarity of a wide window on both sides,
  // not against the immediately adjacent frame. At a boundary the frames just
  // before the change are transitional and also degraded, so comparing against
  // them hides the artefact: three consecutive bad frames then out-vote their
  // neighbours, and the octave corrector treats the corrupted run as real and
  // drags the whole note with it.
  //
  // An ABSOLUTE threshold cannot do this at all. A synthesised tone scores
  // 0.94-0.96, while real microphone input has a median of 0.65 — a floor
  // tuned on the demo discards 96% of a real recording and finds no notes at
  // all. This ratio is scale-free and holds for both.
  const confident = track.map((point, index) => {
    if (point.hz <= 0) return point;
    if (point.clarity === undefined) return point;
    if (point.clarity < options.clarityFloor) return { ...point, hz: 0, voiced: 0 };
    const neighbourhood = neighbourhoodClarity(track, index, options.medianRadius);
    if (neighbourhood === undefined) return point;
    if (point.clarity < neighbourhood * options.clarityRetention) {
      return { ...point, hz: 0, voiced: 0 };
    }
    return point;
  });

  const values = confident.map((point) => (point.hz > 0 ? hzToMidi(point.hz) : NaN));
  const smoothed = medianFilter(values, options.medianRadius);
  const patched = smoothed.map((v, i) =>
    Number.isNaN(v) ? { ...confident[i] } : { ...confident[i], hz: midiToHz(v) },
  );
  return correctOctaveJumps(patched, options.octaveTolerance);
}

/** Median clarity of a window around `index`, excluding the frame itself. */
function neighbourhoodClarity(track: F0Point[], index: number, radius: number): number | undefined {
  const values: number[] = [];
  for (let i = Math.max(0, index - radius - 1); i <= Math.min(track.length - 1, index + radius + 1); i++) {
    if (i === index) continue;
    const point = track[i];
    if (point.hz > 0 && point.clarity !== undefined) values.push(point.clarity);
  }
  if (values.length < 2) return undefined;
  return medianFilter(values, 0)[0];
}

/**
 * The detector's confidence for a frame, averaged over the frames that
 * contributed to its smoothed pitch. Undefined when no frame reported it.
 */
export function clarityAt(track: F0Point[], index: number, radius = 2): number | undefined {
  const values: number[] = [];
  for (let i = Math.max(0, index - radius); i <= Math.min(track.length - 1, index + radius); i++) {
    const clarity = track[i].clarity;
    if (clarity !== undefined) values.push(clarity);
  }
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
