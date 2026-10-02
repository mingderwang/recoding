/** Pitch-class and note-spelling helpers. MIDI note 60 = C4. */

export type Mode = 'major' | 'minor';

export interface Key {
  /** Pitch class of the tonic, 0 = C. */
  tonic: number;
  mode: Mode;
}

export interface KeySignature {
  /** Which way the signature leans, or null for C major / A minor. */
  accidental: '#' | 'b' | null;
  /** Count of sharps or flats. */
  num: number;
}

export const LETTER_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
export type LetterName = (typeof LETTER_NAMES)[number];

/** Natural pitch class of each letter, C D E F G A B. */
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

/** Order in which sharps appear on a staff, as letter indices: F C G D A E B. */
const SHARP_ORDER = [3, 0, 4, 1, 2, 5, 6];
/** Order in which flats appear on a staff, as letter indices: B E A D G C F. */
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];

export const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

/** VexFlow key-specifier strings, indexed by tonic pitch class. */
/** Key names indexed by tonic pitch class (C = 0). */
const MAJOR_SPECS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_SPECS = ['Cm', 'C#m', 'Dm', 'D#m', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

/** The key-specifier string VexFlow's `Stave.addKeySignature` expects. */
export function vexflowKeySpec(key: Key): string {
  return key.mode === 'major' ? MAJOR_SPECS[key.tonic] : MINOR_SPECS[key.tonic];
}

/**
 * Accidentals for each key, indexed by tonic pitch class. Spellings are the
 * conventional ones (Eb minor has six flats, not the enharmonic D# minor's six
 * sharps), chosen as a fixed convention because pitch class alone cannot
 * distinguish them — Eb minor and D# minor sound identical but notate
 * differently. Every entry is a multiple of three sharps/flats, which is what
 * makes all 24 keys fall out of two tables.
 */
const MAJOR_SIGNATURES: Array<[number, '#' | 'b' | null]> = [
  [0, null], // C
  [5, 'b'],  // Db
  [2, '#'],  // D
  [3, 'b'],  // Eb
  [4, '#'],  // E
  [1, 'b'],  // F
  [6, '#'],  // F#
  [1, '#'],  // G
  [4, 'b'],  // Ab
  [3, '#'],  // A
  [2, 'b'],  // Bb
  [5, '#'],  // B
];
const MINOR_SIGNATURES: Array<[number, '#' | 'b' | null]> = [
  [3, 'b'],  // Cm
  [4, '#'],  // C#m
  [1, 'b'],  // Dm
  [6, '#'],  // D#m
  [1, '#'],  // Em
  [4, 'b'],  // Fm
  [3, '#'],  // F#m
  [2, 'b'],  // Gm
  [5, '#'],  // G#m
  [0, null], // Am
  [5, 'b'],  // Bbm
  [2, '#'],  // Bm
];

export function keySignatureOf(key: Key): KeySignature {
  const [num, accidental] = (key.mode === 'major' ? MAJOR_SIGNATURES : MINOR_SIGNATURES)[key.tonic];
  return { accidental, num };
}

export function keyLabel(key: Key): string {
  const spec = vexflowKeySpec(key);
  if (key.mode === 'major') return spec;
  // VexFlow's Am/Dm spec doubles for the relative major; show the real tonic.
  return `${LETTER_NAMES[[0, 5, 2, 7, 4, 9, 6, 11, 8, 3, 10, 5][key.tonic]] ?? 'C'}${key.mode === 'minor' ? 'm' : ''}`;
}

export function scaleSteps(key: Key): number[] {
  const base = key.mode === 'major' ? MAJOR_STEPS : MINOR_STEPS;
  return base.map((s) => (s + key.tonic) % 12);
}

/** The seven diatonic pitch classes of a key, in tonic order. */
export function diatonicPitchClasses(key: Key): number[] {
  return scaleSteps(key);
}

export function inScale(key: Key, pitchClass: number): boolean {
  return scaleSteps(key).includes(((pitchClass % 12) + 12) % 12);
}

/** Per-letter alteration implied by a key signature. */
export function diatonicAlterations(signature: KeySignature): number[] {
  const alter = [0, 0, 0, 0, 0, 0, 0];
  if (!signature.accidental || signature.num === 0) return alter;
  const order = signature.accidental === '#' ? SHARP_ORDER : FLAT_ORDER;
  const value = signature.accidental === '#' ? 1 : -1;
  for (let i = 0; i < Math.min(7, signature.num); i++) alter[order[i]] = value;
  return alter;
}

export interface SpelledNote {
  /** Diatonic letter, e.g. 'F'. */
  letter: LetterName;
  /** -1 flat, 0 natural, +1 sharp. */
  alter: number;
  /** VexFlow key for `StaveNote.addModifier`, e.g. '##' or 'n'. */
  accidentalKey: string;
}

/**
 * Spell a MIDI note using the letter names implied by a key signature, so the
 * printed key signature and the printed accidentals actually agree.
 */
export function spell(midi: number, key: Key): SpelledNote {
  const pitchClass = ((midi % 12) + 12) % 12;
  const alter = diatonicAlterations(keySignatureOf(key));
  const diatonic = new Set<number>();
  for (let i = 0; i < 7; i++) {
    const value = (LETTER_PC[i] + alter[i] + 120) % 12;
    if (!diatonic.has(value)) diatonic.add(value);
  }

  // Prefer a letter that belongs to the key, then the smallest alteration.
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < 7; i++) {
    const a = alter[i];
    const value = (LETTER_PC[i] + a + 120) % 12;
    if (value !== pitchClass) continue;
    const score = (diatonic.has(value) ? 10 : 0) - Math.abs(a);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) {
    // Chromatic note: fall back to a sharp-oriented spelling, which reads
    // better than picking an arbitrary flat.
    for (let i = 0; i < 7; i++) {
      const a = ((pitchClass - LETTER_PC[i] + 12) % 12);
      const useSharp = a <= 6;
      const alterValue = useSharp ? a : a - 12;
      if (((LETTER_PC[i] + alterValue + 120) % 12) === pitchClass) {
        if (-Math.abs(alterValue) > bestScore) {
          bestScore = -Math.abs(alterValue);
          best = i;
          if (Math.abs(alterValue) === 1) break;
        }
      }
    }
    if (best < 0) return { letter: 'C', alter: 0, accidentalKey: 'n' };
    const alterValue = ((pitchClass - LETTER_PC[best] + 12) % 12);
    const finalAlter = alterValue <= 6 ? alterValue : alterValue - 12;
    return toSpelled(best, finalAlter);
  }
  return toSpelled(best, alter[best]);
}

function toSpelled(letterIndex: number, alterValue: number): SpelledNote {
  const accidentalKey = alterValue === 0 ? 'n' : alterValue > 0 ? '#'.repeat(alterValue) : 'b'.repeat(-alterValue);
  return { letter: LETTER_NAMES[letterIndex], alter: alterValue, accidentalKey };
}

/** Snap a (possibly fractional) MIDI value to the nearest pitch of the key. */
export function snapToScale(midi: number, key: Key): number {
  const steps = scaleSteps(key);
  const target = Math.round(midi);
  if (steps.includes(((target % 12) + 12) % 12)) return target;

  let best = target;
  let bestDistance = Infinity;
  for (let d = 0; d <= 2; d++) {
    for (const delta of d === 0 ? [0] : [-d, d]) {
      const candidate = target + delta;
      if (!steps.includes(((candidate % 12) + 12) % 12)) continue;
      const distance = Math.abs(candidate - midi);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best;
}

export function midiToPitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

export function midiToOctave(midi: number): number {
  return Math.floor(midi / 12) - 1;
}
