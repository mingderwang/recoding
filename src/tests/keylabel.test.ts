import { expect, test } from 'bun:test';
import { keyLabel, vexflowKeySpec, keySignatureOf, type Key } from '../lib/music/notes';

/**
 * A regression test for a bug that made a wrong answer look right.
 *
 * `keyLabel` once remapped the tonic through a hand-written table to "show the
 * real tonic", and reported C# minor as "Am". Key detection had in fact chosen
 * the wrong key, and the plausible-looking label hid it: the UI said "Am" while
 * the MIDI file was written with a 4-sharp signature for a piece that is
 * plainly in A minor. A label that cannot disagree with the key it describes is
 * the whole point of having it.
 */

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
/** Natural pitch class of each letter: C D E F G A B. */
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

test('keyLabel reports the key that was actually detected', () => {
  // The case that exposed the bug.
  expect(keyLabel({ tonic: 1, mode: 'minor' })).toBe('C#m');
  expect(keyLabel({ tonic: 1, mode: 'minor' })).not.toBe('Am');
  expect(keyLabel({ tonic: 9, mode: 'minor' })).toBe('Am');
  expect(keyLabel({ tonic: 0, mode: 'major' })).toBe('C');
  expect(keyLabel({ tonic: 7, mode: 'major' })).toBe('G');
});

test('keyLabel agrees with the VexFlow spec for all 24 keys', () => {
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const key: Key = { tonic, mode };
      expect(keyLabel(key)).toBe(vexflowKeySpec(key));
    }
  }
});

test('every keyLabel names a real key with the right mode', () => {
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const label = keyLabel({ tonic, mode });
      // Starts with a letter name, optionally with an accidental.
      const match = /^([A-G])([#b]?)(m?)$/.exec(label);
      expect(match, `unparseable key label: ${label}`).not.toBeNull();
      expect(LETTERS).toContain(match![1]);
      // The tonic letter must be the one that pitch class names, adjusted for
      // a sharp or flat. This is what the old remap table got wrong.
      const naturalPc = LETTER_PC[LETTERS.indexOf(match![1])];
      const alteredPc = (naturalPc + (match![2] === '#' ? 1 : match![2] === 'b' ? -1 : 0) + 12) % 12;
      expect(alteredPc, `${label} does not describe pitch class ${tonic}`).toBe(tonic);
      // Mode suffix must be present exactly for minor keys.
      expect(match![3] === 'm').toBe(mode === 'minor');
    }
  }
});

test('all 24 key labels are distinct', () => {
  const labels = new Set<string>();
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      labels.add(keyLabel({ tonic, mode }));
    }
  }
  // 24 keys, 24 distinct names.
  expect(labels.size).toBe(24);
});

test('a major key and its relative minor share a signature and differ in name', () => {
  // C major / A minor: same notes, different names, same key signature.
  expect(keyLabel({ tonic: 0, mode: 'major' })).toBe('C');
  expect(keyLabel({ tonic: 9, mode: 'minor' })).toBe('Am');
  expect(keySignatureOf({ tonic: 0, mode: 'major' })).toEqual(keySignatureOf({ tonic: 9, mode: 'minor' }));

  // G major / E minor.
  expect(keyLabel({ tonic: 7, mode: 'major' })).toBe('G');
  expect(keyLabel({ tonic: 4, mode: 'minor' })).toBe('Em');
  expect(keySignatureOf({ tonic: 7, mode: 'major' })).toEqual(keySignatureOf({ tonic: 4, mode: 'minor' }));
});

test('the pitch class of every label matches the pitch classes of its scale', () => {
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const key: Key = { tonic, mode };
      const label = keyLabel(key);
      const match = /^([A-G])([#b]?)(m?)$/.exec(label)!;
      const rootPc =
        (LETTER_PC[LETTERS.indexOf(match[1])] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + 12) % 12;
      expect(rootPc).toBe(tonic);
    }
  }
});
