import { expect, test } from 'bun:test';
import { vexflowKeySpec, keySignatureOf, type Key } from '../lib/music/notes';
import * as fs from 'node:fs';

/**
 * The set of key specifiers VexFlow accepts, read straight out of its bundled
 * tables module so this test cannot drift from the installed version.
 */
function vexflowKeySpecs(): Set<string> {
  const source = fs.readFileSync('node_modules/vexflow/build/esm/src/tables.js', 'utf8');
  const start = source.indexOf('keySignatures = {');
  const end = source.indexOf('};', start);
  const body = source.slice(start, end);
  return new Set(
    [...body.matchAll(/^\s{4}('?[\w#]+'?):/gm)].map((m) => m[1].replace(/'/g, '')),
  );
}

test('every key we can produce is one VexFlow accepts', () => {
  const valid = vexflowKeySpecs();
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const spec = vexflowKeySpec({ tonic, mode });
      expect(valid.has(spec)).toBe(true);
    }
  }
});

test('all 24 keys are distinct, and major/minor names differ', () => {
  const specs = new Set<string>();
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const key: Key = { tonic, mode };
      const spec = vexflowKeySpec(key);
      // The same spec must not be reused across different keys.
      expect(specs.has(spec)).toBe(false);
      specs.add(spec);
      // A key with no accidentals must never print one.
      if (keySignatureOf(key).num === 0) {
        expect(spec).not.toMatch(/[b#]/);
      }
    }
  }
  expect(specs.size).toBe(24);
});

test('our signature matches the one VexFlow derives from the same name', () => {
  // Parses VexFlow's own table, so the two cannot silently disagree.
  const source = fs.readFileSync('node_modules/vexflow/build/esm/src/tables.js', 'utf8');
  const start = source.indexOf('keySignatures = {');
  const end = source.indexOf('};', start);
  const body = source.slice(start, end);
  const table = new Map<string, { accidental: string | null; num: number }>();
  for (const line of body.split('\n')) {
    const match = /^\s{4}(['\w#]+):\s*\{(.*)\},?\s*$/.exec(line);
    if (!match) continue;
    const spec = match[1].replace(/'/g, '');
    const num = Number(/num:\s*(\d+)/.exec(match[2])?.[1] ?? NaN);
    const accidental = /accidental:\s*'([^']+)'/.exec(match[2])?.[1] ?? null;
    table.set(spec, { num, accidental });
  }
  expect(table.size).toBeGreaterThanOrEqual(24);

  let checked = 0;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const key: Key = { tonic, mode };
      const theirs = table.get(vexflowKeySpec(key));
      expect(theirs).toBeDefined();
      const ours = keySignatureOf(key);
      expect(ours.num).toBe(theirs?.num);
      // VexFlow omits `accidental` entirely at zero; treat that as "none".
      const oursAccidental: string | null = ours.accidental;
      const theirsAccidental: string | null = theirs?.accidental ?? null;
      expect(oursAccidental).toBe(theirsAccidental);
      checked++;
    }
  }
  expect(checked).toBe(24);
});
