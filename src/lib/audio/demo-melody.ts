/**
 * The demo melody, synthesised to samples.
 *
 * Kept out of the page controller so the tests can run it through the real
 * analysis pipeline and assert the transcription, rather than leaving the demo
 * as an unverified path that can drift into looking broken.
 *
 * It is deliberately more than a scale. A full phrase exercises the parts of
 * the pipeline a bare scale never touches: a held note, a rest, a leap, and
 * two different note values in one bar. That makes the printed score a more
 * honest picture of what the app does, and it gives the tests something that
 * can actually fail.
 */

/** One event in the demo phrase. */
export interface DemoNote {
  /** MIDI note number. */
  midi: number;
  /** Length in beats. */
  beats: number;
}

/**
 * An eight-bar phrase in C major, 4/4.
 *
 * Built from what the pipeline handles well — a clear fundamental, a steady
 * pulse, and no two adjacent notes on the same pitch — so that a failure in the
 * tests points at the algorithm rather than at an ambiguous input. (A repeated
 * pitch is indistinguishable from a held note and gets merged; a voice singing
 * two identical notes in a row is genuinely undecidable from pitch alone.)
 */
export const DEMO_MELODY: { notes: DemoNote[]; bpm: number; beatsPerMeasure: number } = {
  bpm: 100,
  beatsPerMeasure: 4,
  notes: [
    // Bar 1 — rising, all quarters. C D E F
    { midi: 60, beats: 1 },
    { midi: 62, beats: 1 },
    { midi: 64, beats: 1 },
    { midi: 65, beats: 1 },
    // Bar 2 — a leap of a sixth up to the octave, then step down. G C B A
    { midi: 67, beats: 1 },
    { midi: 72, beats: 1 },
    { midi: 71, beats: 1 },
    { midi: 69, beats: 1 },
    // Bar 3 — a HELD note (two beats) then two quarters. G(half) F E
    { midi: 67, beats: 2 },
    { midi: 65, beats: 1 },
    { midi: 64, beats: 1 },
    // Bar 4 — a REST (one beat) then a closing cadence. rest D C
    { midi: null as unknown as number, beats: 1 },
    { midi: 62, beats: 1 },
    { midi: 60, beats: 2 },
  ],
};

/** The pitches the demo should transcribe to, rests excluded. */
export const DEMO_EXPECTED_PITCHES = DEMO_MELODY.notes
  .filter((note) => typeof note.midi === 'number')
  .map((note) => note.midi);

export function synthesizeDemoMelody(sampleRate: number): Float32Array {
  const { notes, bpm, beatsPerMeasure } = DEMO_MELODY;
  const secondsPerBeat = 60 / bpm;
  const beats = notes.reduce((sum, note) => sum + note.beats, 0);
  const total = Math.round(beats * secondsPerBeat * sampleRate);
  const out = new Float32Array(total);
  // Long notes get a proportionally gentler attack, so a half note does not
  // click where a quarter would not.
  const attackSeconds = 0.025;
  const releaseSeconds = 0.03;

  let cursor = 0;
  for (const note of notes) {
    const count = Math.round(note.beats * secondsPerBeat * sampleRate);
    // A rest is silence, but not digital silence: leaving the samples at zero
    // is fine, and it is what a real breath sounds like at this level.
    if (typeof note.midi !== 'number') {
      cursor += count;
      continue;
    }

    const frequency = 440 * Math.pow(2, (note.midi - 69) / 12);
    const attack = Math.round(attackSeconds * sampleRate);
    const release = Math.round(releaseSeconds * sampleRate);

    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      // Three harmonics with a 1/h rolloff, roughly a sung vowel.
      //
      // No vibrato, deliberately. A vibrato of even 0.35% is 6 cents, and near
      // the top of a note that is enough to push the detected pitch across a
      // semitone boundary and back: a single held C4 measured as
      // 60, 61, 60, 59, 60. Those spurious transitions fragment one note into
      // three, which then wrecks the tempo search — the demo printed 205bpm for
      // a phrase written at 100. Real singing does wobble, and a recording tool
      // has to cope with it, but the demo's job is to show the output for the
      // phrase as specified, so it stays steady. See the README for what
      // happens on genuinely vibrato-heavy input.
      let value = 0.5 * Math.sin(2 * Math.PI * frequency * t);
      value += 0.2 * Math.sin(2 * Math.PI * 2 * frequency * t);
      value += 0.08 * Math.sin(2 * Math.PI * 3 * frequency * t);

      if (i < attack) value *= i / attack;
      if (i > count - release) value *= (count - i) / release;
      out[cursor + i] = value;
    }
    cursor += count;
  }
  return out;
}
