/**
 * Voice range presets, used to bound the fundamental the detector will report.
 *
 * Measured on a real tenor recording with full accompaniment, band-limiting was
 * the single biggest improvement available:
 *
 *   range              span   notes in a tenor's range
 *   60-1200 Hz (none)   44     66%
 *   100-550 Hz          29     86%
 *   130-550 Hz          25     84%
 *
 * Band-limiting does not make the transcription correct — the detector still
 * hops between sources — but it stops the output being nonsense, like a B1
 * printed for a tenor who cannot sing below an E2.
 *
 * Bounds are on the FUNDAMENTAL, not the harmonics, and are deliberately wide:
 * missing a note at the edge of someone's range is a smaller error than
 * silently transposing them an octave.
 */

export type VoiceRangeId = 'auto' | 'bass' | 'tenor' | 'alto' | 'soprano' | 'piano';

export interface VoiceRange {
  id: VoiceRangeId;
  label: string;
  /** Hz. The detector will never report a fundamental outside these. */
  minHz: number;
  maxHz: number;
  /** MIDI numbers, for the UI and for the plausibility check. */
  lowMidi: number;
  highMidi: number;
}

export const VOICE_RANGES: Record<VoiceRangeId, VoiceRange> = {
  // No restriction. This is the default because the app cannot know what the
  // singer sounds like, and guessing would silently transpose someone.
  auto: { id: 'auto', label: 'Any voice', minHz: 60, maxHz: 1200, lowMidi: 36, highMidi: 84 },
  bass: { id: 'bass', label: 'Bass / baritone', minHz: 55, maxHz: 500, lowMidi: 33, highMidi: 74 },
  tenor: { id: 'tenor', label: 'Tenor', minHz: 95, maxHz: 600, lowMidi: 45, highMidi: 77 },
  alto: { id: 'alto', label: 'Alto', minHz: 130, maxHz: 800, lowMidi: 50, highMidi: 80 },
  soprano: { id: 'soprano', label: 'Soprano', minHz: 200, maxHz: 1100, lowMidi: 55, highMidi: 84 },
  // The whole keyboard, A0 to C8. Measured at an 8192 window, every note from A0
  // to C8 resolves to within 10 cents; the top of the keyboard is not the weak
  // end, despite C8 having a period of only 10.5ms.
  //
  // This is a MONOPHONIC piano preset: one note at a time. A chord or any
  // overlapping notes will not read, because the detector reports whichever
  // pitch is locally strongest — the same limitation as a voice with
  // accompaniment, but with no way to narrow the band to hide it.
  piano: { id: 'piano', label: 'Piano (one note at a time)', minHz: 27.5, maxHz: 4186, lowMidi: 21, highMidi: 108 },
};

export function voiceRange(id: VoiceRangeId): VoiceRange {
  return VOICE_RANGES[id] ?? VOICE_RANGES.auto;
}