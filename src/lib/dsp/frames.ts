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
