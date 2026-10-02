/**
 * The demo melody, synthesised to samples.
 *
 * Kept out of the page controller so the tests can run it through the real
 * analysis pipeline and assert the transcription, rather than leaving the demo
 * as an unverified path that can drift into looking broken.
 */

/** Pitch and duration of the demo phrase, in MIDI and seconds. */
export const DEMO_MELODY = {
  /** C major, up and back down. No two adjacent notes share a pitch: a repeated
   *  pitch is indistinguishable from a held note and the pipeline merges them. */
  notes: [60, 62, 64, 65, 67, 69, 67, 65, 64, 62],
  /** 0.4s per note is exactly 150bpm quarter notes, so the tempo the search
   *  reports can be checked against a known value. */
  noteSeconds: 0.4,
} as const;

/** What the demo melody should transcribe to, used as a reference in tests. */
export const DEMO_EXPECTED = {
  bpm: 150,
  key: { tonic: 0, mode: 'major' } as const,
  pitches: DEMO_MELODY.notes,
};

export function synthesizeDemoMelody(sampleRate: number): Float32Array {
  const { notes, noteSeconds } = DEMO_MELODY;
  const total = Math.round(notes.length * noteSeconds * sampleRate);
  const out = new Float32Array(total);
  const ramp = Math.round(0.02 * sampleRate);

  let cursor = 0;
  for (const midi of notes) {
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    const count = Math.round(noteSeconds * sampleRate);
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      // Three harmonics with a 1/h rolloff, roughly a sung vowel.
      let value = 0.5 * Math.sin(2 * Math.PI * frequency * t);
      value += 0.2 * Math.sin(2 * Math.PI * 2 * frequency * t);
      value += 0.08 * Math.sin(2 * Math.PI * 3 * frequency * t);
      // Ramp in and out so note boundaries are clean, not clicks.
      if (i < ramp) value *= i / ramp;
      if (i > count - ramp) value *= (count - i) / ramp;
      out[cursor + i] = value;
    }
    cursor += count;
  }
  return out;
}
