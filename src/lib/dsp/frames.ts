import { DEFAULT_MPM_OPTIONS, estimatePitch, type MpmOptions, type PitchEstimate } from './mpm';

/** One analysed window of the signal. */
export interface PitchFrame {
  /** Window centre, in seconds from the start of the signal. */
  time: number;
  /** Fundamental frequency in Hz, or 0 when unvoiced. */
  hz: number;
  clarity: number;
  rms: number;
}

export interface TrackOptions extends MpmOptions {
  /**
   * Analysis window in samples. Measured worst-case pitch error across 82-880 Hz
   * is ~28 cents at 2048, ~12 cents at 4096 and ~8 cents at 8192, because the
   * window has to hold enough cycles for the endpoint residual to average out.
   * 4096 (93ms) is the sweet spot: sub-semitone accuracy at a cost that keeps a
   * ten-second recording under a second of analysis.
   */
  windowSize: number;
  /** Advance between windows in samples. 512 @ 44.1kHz ≈ 11.6ms. */
  hopSize: number;
}

export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
  ...DEFAULT_MPM_OPTIONS,
  windowSize: 4096,
  hopSize: 512,
};

/**
 * How many periods of the lowest fundamental a window must hold.
 *
 * The NSDF is a time-domain periodicity measure, so its reliability is
 * governed by how many cycles the window contains, not by FFT bin width. Four
 * is where measurement stopped showing octave errors; at 2048 samples and a
 * 55Hz floor it is only 2.6 periods and nothing below 82Hz is detected at all.
 */
const MIN_PERIODS_PER_WINDOW = 4;

/** The shortest window that resolves pitch usefully; below this, accuracy falls apart. */
const MIN_WINDOW_SIZE = 2048;
/** The longest window worth using; past this, short notes stop being detectable. */
const MAX_WINDOW_SIZE = 4096;

/**
 * Pick an analysis window from the lowest pitch that will be searched.
 *
 * A user reported "I think you sampling to slow", and the measurement agreed
 * while being more specific than that. On a melodic figure with notes butted
 * together, noise and reverb, notes of 125ms:
 *
 *   window 4096 (93ms)   4 of 8 correct, 3 at the wrong pitch
 *   window 2048 (46ms)   9 of 9 correct, none wrong
 *
 * A 93ms window needs to fit inside the note, so a 125ms note only has about
 * three frames that do not straddle a boundary — and three frames is a 35ms run,
 * which segmentation then discards as too short. That is where the notes went.
 *
 * But a shorter window is not free: below 82Hz, 2048 detects nothing at all,
 * because 55Hz gives only 2.6 cycles per window. So the window is derived from
 * the voice range instead of being a constant — a bass keeps 4096, everyone
 * above E2 gets 2048. Raising `minHz` and shortening the window are the same
 * decision, which is why this reads the range rather than a separate setting.
 */
export function windowSizeForFloor(minHz: number, sampleRate = DEFAULT_MPM_OPTIONS.sampleRate): number {
  if (!(minHz > 0)) return MAX_WINDOW_SIZE;
  const needed = Math.ceil((MIN_PERIODS_PER_WINDOW / minHz) * sampleRate);
  const bounded = Math.min(MAX_WINDOW_SIZE, Math.max(MIN_WINDOW_SIZE, needed));
  // A power of two keeps the FFT in the autocorrelation at its cheapest size.
  let size = 1;
  while (size < bounded) size *= 2;
  return Math.min(MAX_WINDOW_SIZE, size);
}

/**
 * Run the detector across a whole mono signal and return one entry per window.
 *
 * The caller runs this off the main thread; `yieldEvery` exists purely so the
 * worker can post progress without the analysis itself being interruptible.
 */
export function analyzeTrack(
  signal: Float32Array,
  options: TrackOptions = DEFAULT_TRACK_OPTIONS,
  onProgress?: (fraction: number) => void,
): PitchFrame[] {
  const { windowSize, hopSize, ...mpmOptions } = options;
  const frames: PitchFrame[] = [];
  if (signal.length < windowSize) return frames;

  const window = new Float64Array(windowSize);
  const lastStart = signal.length - windowSize;
  let lastReported = -1;

  for (let start = 0; start <= lastStart; start += hopSize) {
    for (let i = 0; i < windowSize; i++) window[i] = signal[start + i];
    const estimate = estimatePitch(window, mpmOptions);
    frames.push(toFrame(estimate, start + windowSize / 2, mpmOptions.sampleRate));
    if (onProgress) {
      const fraction = Math.round((start / lastStart) * 50);
      if (fraction !== lastReported) {
        lastReported = fraction;
        onProgress(fraction / 100);
      }
    }
  }
  if (onProgress) onProgress(1);
  return frames;
}

/** Analyse a single window — used by the live meter while recording. */
export function analyzeWindow(
  window: Float32Array | Float64Array,
  options: TrackOptions = DEFAULT_TRACK_OPTIONS,
): PitchEstimate {
  const { windowSize: _w, hopSize: _h, ...mpmOptions } = options;
  return estimatePitch(window, mpmOptions);
}

function toFrame(estimate: PitchEstimate, time: number, sampleRate: number): PitchFrame {
  return {
    time: time / sampleRate,
    hz: estimate.hz,
    clarity: estimate.clarity,
    rms: estimate.rms,
  };
}
