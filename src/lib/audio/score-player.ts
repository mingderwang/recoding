import { UNITS_PER_BEAT, type Score } from '../music/score';
import { midiToHz } from '../dsp/smooth';

/**
 * Plays a transcribed score back as sound.
 *
 * This synthesises the notes directly rather than decoding the exported MIDI,
 * so what you hear is exactly what the score model says — including the ties
 * and rests — and it needs no MIDI parser in the browser.
 *
 * The timbre is a plain decaying sine with a couple of quiet harmonics,
 * chosen to be obviously synthetic. Aiming for a realistic instrument tone
 * would imply a fidelity the transcription does not have; the point is to let
 * you check the notes and the rhythm against what you sang.
 */

export interface PlaybackOptions {
  /** Semitone offset, for transposing a difficult range. */
  transpose?: number;
  /** 0..1. */
  gain?: number;
  /** Short attack in seconds, to avoid a click. */
  attack?: number;
  /** Note release in seconds. */
  release?: number;
  /** Called each animation frame with playback position in seconds. */
  onProgress?: (seconds: number) => void;
  /** Called when playback reaches the end. */
  onEnd?: () => void;
}

const DEFAULTS = {
  transpose: 0,
  gain: 0.22,
  attack: 0.01,
  release: 0.12,
};

export class ScorePlayer {
  private context: AudioContext | null = null;
  private sources: Array<OscillatorNode & { stop: (when?: number) => void }> = [];
  private master: GainNode | null = null;
  private startedAt = 0;
  private duration = 0;
  private frame = 0;
  private stopped = false;

  get isPlaying(): boolean {
    return this.context !== null && !this.stopped;
  }

  /** Total length in seconds, at the score's own tempo. */
  get length(): number {
    return this.duration;
  }

  async play(score: Score, options: PlaybackOptions = {}): Promise<void> {
    this.stop();
    const settings = { ...DEFAULTS, ...options };

    const context = new AudioContext();
    // Browsers start audio contexts suspended until a user gesture; the click
    // that got us here counts, but this makes it explicit and safe to await.
    if (context.state === 'suspended') await context.resume();
    this.context = context;
    this.stopped = false;

    const master = context.createGain();
    master.gain.value = settings.gain;
    // A gentle low-pass takes the edge off the synthetic tone.
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 4200;
    filter.Q.value = 0.4;
    master.connect(filter).connect(context.destination);
    this.master = master;

    const secondsPerBeat = 60 / Math.max(1, score.grid.bpm);
    const secondsPerUnit = secondsPerBeat / UNITS_PER_BEAT;
    this.duration = score.totalUnits * secondsPerUnit;
    this.startedAt = context.currentTime + 0.05;

    for (const event of score.events) {
      if (event.type !== 'note') continue;
      const key = clampMidi(event.midi + settings.transpose);

      const start = this.startedAt + event.start * secondsPerUnit;
      const end = this.startedAt + (event.start + event.duration) * secondsPerUnit;
      const hold = Math.max(0.02, end - start);
      const frequency = midiToHz(key);

      // Fundamental plus two quiet harmonics, so the note is legible as a pitch
      // rather than a pure sine that is hard to track by ear.
      const partials: Array<[number, number]> = [
        [1, 1],
        [2, 0.28],
        [3, 0.1],
      ];

      for (const [multiple, level] of partials) {
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency * multiple;

        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(level, start + settings.attack);
        // Decay through the note, then release, so repeated notes re-articulate
        // instead of running into each other.
        envelope.gain.setTargetAtTime(level * 0.55, start + settings.attack, hold * 0.6);
        envelope.gain.setTargetAtTime(0, start + hold, settings.release / 3);

        oscillator.connect(envelope).connect(master);
        oscillator.start(start);
        oscillator.stop(start + hold + settings.release + 0.05);
        this.sources.push(oscillator);
      }
    }

    this.tick(settings.onProgress, options.onEnd);
  }

  private tick(onProgress?: (seconds: number) => void, onEnd?: () => void): void {
    if (!this.context || this.stopped) return;
    const elapsed = this.context.currentTime - this.startedAt;
    onProgress?.(Math.max(0, elapsed));

    if (elapsed >= this.duration) {
      this.finish(onEnd);
      return;
    }
    this.frame = requestAnimationFrame(() => this.tick(onProgress, onEnd));
  }

  private finish(onEnd?: () => void): void {
    const context = this.context;
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    // Let the release tails finish before tearing the graph down.
    window.setTimeout(() => void context?.close(), 400);
    this.context = null;
    this.sources = [];
    this.master = null;
    onEnd?.();
  }

  stop(): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    // Ramp the master down rather than cutting, so nothing clicks.
    this.master?.gain.cancelScheduledValues(now);
    this.master?.gain.setValueAtTime(this.master.gain.value, now);
    this.master?.gain.linearRampToValueAtTime(0, now + 0.04);
    for (const source of this.sources) {
      try {
        source.stop(now + 0.06);
      } catch {
        // Already stopped; nothing to do.
      }
    }
    this.finish();
  }
}

function clampMidi(midi: number): number {
  return Math.max(21, Math.min(108, Math.round(midi)));
}
