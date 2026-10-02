import { FFT } from './fft';

/** Result of one pitch estimate. `hz` is 0 when nothing was detected. */
export interface PitchEstimate {
  /** Fundamental frequency in Hz, or 0 when the frame is unvoiced. */
  hz: number;
  /** Normalised square difference in [0, 1]. 1 = perfectly periodic. */
  clarity: number;
  /** Root mean square amplitude of the frame. */
  rms: number;
}

export interface MpmOptions {
  sampleRate: number;
  /** Lowest frequency the detector will consider. */
  minHz: number;
  /** Highest frequency the detector will consider. */
  maxHz: number;
  /** Peak must exceed `threshold * globalMax` to be accepted. */
  threshold: number;
  /** RMS below this counts as silence. */
  rmsFloor: number;
}

export const DEFAULT_MPM_OPTIONS: MpmOptions = {
  sampleRate: 44100,
  minHz: 60,
  maxHz: 1200,
  threshold: 0.88,
  rmsFloor: 0.008,
};

const EPS = 1e-12;

/** A frame whose best NSDF peak is below this is treated as unvoiced. */
const MIN_CLARITY = 0.55;

/**
 * McLeod Pitch Method (Schloss 1986) on a single analysis frame.
 *
 * Plain autocorrelation is prone to octave-down errors on voice because a
 * human voice has a strong second harmonic. MPM's normalised square difference
 * function plus "choose the *first* qualifying peak" rule avoids that, which
 * makes it the right choice for the monophonic singing-voice case.
 */
export function estimatePitch(
  frame: Float64Array | Float32Array,
  options: MpmOptions = DEFAULT_MPM_OPTIONS,
): PitchEstimate {
  const { sampleRate, minHz, maxHz, threshold, rmsFloor } = options;
  const n = frame.length;

  // Energy of the frame, reused for both the RMS gate and NSDF normalisation.
  let sumSquares = 0;
  for (let i = 0; i < n; i++) sumSquares += frame[i] * frame[i];
  const energy = sumSquares / n;
  const rms = Math.sqrt(energy);
  if (rms < rmsFloor || sumSquares < EPS) {
    return { hz: 0, clarity: 0, rms };
  }

  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxTau = Math.min(n - 2, Math.ceil(sampleRate / minHz));
  if (maxTau <= minTau) {
    return { hz: 0, clarity: 0, rms };
  }

  // Zero-pad to 2N so the circular autocorrelation equals the linear one over
  // the lag range we care about.
  const fftSize = nextPowerOfTwo(2 * n);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < n; i++) re[i] = frame[i];
  const fft = new FFT(fftSize);
  fft.forward(re, im);
  for (let i = 0; i < fftSize; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft.inverse(re, im);
  // `re` now holds the raw autocorrelation r(tau).

  // NSDF: n(tau) = 2 r(tau) / m(tau), with m(tau) the window energy plus the
  // energy of the tail that lags behind it (Schloss 1986, eq. 6). A prefix sum
  // makes the tail term O(1) per lag.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + frame[i] * frame[i];
  const totalEnergy = prefix[n];

  const nsdf = new Float64Array(maxTau + 1);
  for (let tau = 0; tau <= maxTau; tau++) {
    const tail = totalEnergy - prefix[n - tau];
    const m = totalEnergy + tail;
    // Scaled by 0.5 so a perfectly periodic frame peaks at 1.0 rather than 2.0,
    // which keeps `clarity` directly interpretable as a 0..1 confidence.
    nsdf[tau] = m < EPS ? 0 : re[tau] / m;
  }

  // A "key maximum" is a local peak of the NSDF. The acceptance bar is set by
  // the tallest key maximum, NOT the tallest value anywhere in the range: for a
  // low note the NSDF is still climbing through the small lags, so the max
  // overall can sit at a lag that is not a peak at all and would swamp the
  // real one.
  const peaks: number[] = [];
  for (let tau = minTau + 1; tau < maxTau; tau++) {
    if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1]) peaks.push(tau);
  }
  if (peaks.length === 0) {
    return { hz: 0, clarity: 0, rms };
  }

  let tallestPeak = 0;
  for (const tau of peaks) {
    if (nsdf[tau] > tallestPeak) tallestPeak = nsdf[tau];
  }
  // An absolute floor, so a frame with no real periodicity is rejected outright.
  if (tallestPeak < MIN_CLARITY) {
    return { hz: 0, clarity: 0, rms };
  }

  // The first key maximum clearing the bar wins; taking the first is what keeps
  // a strong second harmonic from dragging the result an octave down.
  const cutoff = tallestPeak * threshold;
  let bestTau = -1;
  for (const tau of peaks) {
    if (nsdf[tau] >= cutoff) {
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) {
    return { hz: 0, clarity: 0, rms };
  }

  // Parabolic interpolation around the peak for sub-sample precision.
  let tau = bestTau;
  const y0 = nsdf[bestTau - 1];
  const y1 = nsdf[bestTau];
  const y2 = nsdf[bestTau + 1];
  const denom = 2 * (2 * y1 - y0 - y2);
  if (Math.abs(denom) > EPS) {
    const shift = (y2 - y0) / denom;
    if (Number.isFinite(shift) && Math.abs(shift) <= 1) tau = bestTau + shift;
  }

  const hz = sampleRate / tau;
  if (hz < minHz || hz > maxHz) {
    return { hz: 0, clarity: 0, rms };
  }
  return { hz, clarity: Math.min(1, Math.max(0, y1)), rms };
}

export function nextPowerOfTwo(value: number): number {
  let n = 1;
  while (n < value) n *= 2;
  return n;
}
