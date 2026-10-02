/**
 * Minimal iterative radix-2 FFT, in place, with precomputed twiddles.
 *
 * We only need forward transforms (for the power spectrum that feeds the
 * autocorrelation in `mpm.ts`) and one inverse transform, so this stays
 * deliberately small rather than pulling in a dependency.
 */
export class FFT {
  readonly n: number;
  private readonly levels: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${n}`);
    }
    this.n = n;
    this.levels = Math.log2(n) | 0;
    this.rev = new Uint32Array(n);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n; i++) {
      // Reads rev[i >> 1], already computed, so each step shifts the reversed
      // index down by one bit. Using `i >> 1` here would not be a reversal.
      this.rev[i] = i === 0 ? 0 : ((this.rev[i >> 1] >> 1) | ((i & 1) << (this.levels - 1)));
    }
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** Forward transform. */
  forward(re: Float64Array, im: Float64Array): void {
    this.run(re, im, false);
  }

  /** Inverse transform (includes the 1/N scaling). */
  inverse(re: Float64Array, im: Float64Array): void {
    this.run(re, im, true);
  }

  private run(re: Float64Array, im: Float64Array, invert: boolean): void {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          // Forward twiddle is cos - i*sin; the inverse conjugates it.
          const tre = invert ? re[l] * cos[k] - im[l] * sin[k] : re[l] * cos[k] + im[l] * sin[k];
          const tim = invert ? re[l] * sin[k] + im[l] * cos[k] : -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
    if (invert) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}
