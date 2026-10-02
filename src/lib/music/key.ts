import type { Key, Mode } from './notes';

/**
 * Krumhansl-Schmuckler key-finding: correlate a duration-weighted pitch-class
 * histogram against the classic major and minor profiles, rotated to each of
 * the twelve possible tonics.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - meanA;
    const y = b[i] - meanB;
    num += x * y;
    denA += x * x;
    denB += y * y;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

export interface WeightedPitch {
  /** Fractional MIDI value. */
  midi: number;
  /** Duration in seconds, used as the histogram weight. */
  duration: number;
}

export interface KeyDetection {
  key: Key;
  /** Correlation score, roughly -1..1. */
  score: number;
  /** Runner-up key, for the "did you mean" hint in the UI. */
  alternative: Key;
  alternativeScore: number;
}

/** Build a duration-weighted pitch-class histogram. */
export function pitchClassHistogram(items: WeightedPitch[]): number[] {
  const hist = new Array<number>(12).fill(0);
  for (const item of items) {
    const pc = ((Math.round(item.midi) % 12) + 12) % 12;
    hist[pc] += item.duration;
  }
  return hist;
}

export function detectKey(items: WeightedPitch[]): KeyDetection | null {
  const hist = pitchClassHistogram(items);
  const total = hist.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;

  const results: Array<{ key: Key; score: number }> = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = hist.map((_, pc) => hist[(pc + tonic) % 12]);
    results.push({ key: { tonic, mode: 'major' }, score: correlate(rotated, MAJOR_PROFILE) });
    results.push({ key: { tonic, mode: 'minor' }, score: correlate(rotated, MINOR_PROFILE) });
  }
  results.sort((a, b) => b.score - a.score);

  const best = results[0];
  const second = results[1] ?? best;
  return {
    key: best.key,
    score: best.score,
    alternative: second.key,
    alternativeScore: second.score,
  };
}

/** Fallback used when there is not enough signal to call a key. */
export const DEFAULT_KEY: Key = { tonic: 0, mode: 'major' };

export function sameKey(a: Key, b: Key): boolean {
  return a.tonic === b.tonic && (a.mode as Mode) === (b.mode as Mode);
}
