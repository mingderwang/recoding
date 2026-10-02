/** A single point in the fundamental-frequency track. */
export interface F0Point {
  time: number;
  /** 0 when the frame is unvoiced. */
  hz: number;
  /** 1 when voiced. */
  voiced: number;
}

/** Converts a pitch track to MIDI-number space, which is where the rest of the
 *  pipeline does its arithmetic (octave jumps become plain integer errors). */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

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
export function correctOctaveJumps(track: F0Point[], toleranceSemitones = 0.75): F0Point[] {
  const out = track.map((p) => ({ ...p }));
  for (let i = 1; i < out.length; i++) {
    if (out[i].hz <= 0 || out[i - 1].hz <= 0) continue;
    const a = hzToMidi(out[i - 1].hz);
    const b = hzToMidi(out[i].hz);
    const delta = b - a;
    for (const shift of [12, -12, 24, -24]) {
      const corrected = b - shift;
      if (Math.abs(corrected - a) <= toleranceSemitones) {
        out[i].hz = midiToHz(corrected);
        break;
      }
    }
  }
  return out;
}

export interface SmoothOptions {
  /** Median filter radius in frames. */
  medianRadius: number;
  octaveTolerance: number;
}

/** Median filter then octave repair, applied in place on a copy. */
export function smoothTrack(track: F0Point[], options: SmoothOptions): F0Point[] {
  const indices = track.map((_, i) => i);
  const values = indices.map((i) => (track[i].hz > 0 ? hzToMidi(track[i].hz) : NaN));
  const smoothed = medianFilter(values, options.medianRadius);
  const patched = smoothed.map((v, i) => (Number.isNaN(v) ? { ...track[i] } : { ...track[i], hz: midiToHz(v) }));
  return correctOctaveJumps(patched, options.octaveTolerance);
}
