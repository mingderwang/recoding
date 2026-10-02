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
 * Real notes score 0.94-0.96; the window-straddling artefacts that read an
 * octave out score around 0.73, which is 0.78 of the real value. A threshold of
 * 0.9 sits comfortably between those.
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
   * Frames below this detector confidence are discarded as unvoiced.
   *
   * Measured on the demo phrase: frames inside a sustained note score
   * 0.94-0.96, and the three that straddle a note boundary and read two octaves
   * low score 0.73. A floor of 0.85 sits in the gap.
   */
  clarityFloor: number;
}

/** Defaults shared by every caller, so the two thresholds cannot drift apart. */
export const DEFAULT_SMOOTH_OPTIONS: SmoothOptions = {
  medianRadius: 2,
  octaveTolerance: 0.75,
  clarityFloor: 0.85,
};

/** Median filter then octave repair, applied in place on a copy. */
export function smoothTrack(track: F0Point[], partial?: Partial<SmoothOptions>): F0Point[] {
  const options: SmoothOptions = { ...DEFAULT_SMOOTH_OPTIONS, ...partial };
  // Drop low-confidence frames BEFORE the median filter. A window that straddles
  // a note boundary reports the wrong pitch and is less certain about it, so
  // comparing each frame against its neighbours throws those away. Filtering
  // first and trusting afterwards does not work: three consecutive bad frames
  // out-vote their neighbours, and then the octave corrector treats the
  // corrupted run as real and drags the whole note with it.
  const confident = track.map((point) =>
    point.hz > 0 && point.clarity !== undefined && point.clarity < options.clarityFloor
      ? { ...point, hz: 0, voiced: 0 }
      : point,
  );

  const values = confident.map((point) => (point.hz > 0 ? hzToMidi(point.hz) : NaN));
  const smoothed = medianFilter(values, options.medianRadius);
  const patched = smoothed.map((v, i) =>
    Number.isNaN(v) ? { ...confident[i] } : { ...confident[i], hz: midiToHz(v) },
  );
  return correctOctaveJumps(patched, options.octaveTolerance);
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
