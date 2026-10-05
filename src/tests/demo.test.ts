import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS } from '../lib/dsp/frames';
import { smoothTrack } from '../lib/dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS } from '../lib/music/segment';
import { detectKey } from '../lib/music/key';
import { inferGrid, quantizeNotes } from '../lib/music/quantize';
import { buildScore } from '../lib/music/score';
import { renderScore } from '../lib/ui/render-score';
import { buildFeedbackReport, describeScoreEvents, noteName } from '../lib/diagnostics/feedback';
import { keyLabel } from '../lib/music/notes';
import {
  synthesizeDemoMelody,
  DEMO_MELODY,
  DEMO_EXPECTED_PITCHES,
} from '../lib/audio/demo-melody';

const SAMPLE_RATE = 44100;
const C_MAJOR = { tonic: 0, mode: 'major' } as const;

function installDom(): { container: HTMLElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = [
    'window', 'document', 'navigator', 'Node', 'SVGElement',
    'HTMLElement', 'XMLSerializer', 'SVGSVGElement', 'DocumentFragment',
  ] as const;
  const previous = new Map<string, unknown>();
  for (const key of keys) previous.set(key, globals[key]);
  const win = dom.window as unknown as Record<string, unknown>;
  for (const key of keys) globals[key] = win[key];
  return {
    container: dom.window.document.getElementById('host') as HTMLElement,
    restore() {
      for (const [key, value] of previous) globals[key] = value;
    },
  };
}

/** Run the demo through the whole pipeline, exactly as the worker does. */
function transcribeDemo() {
  const samples = synthesizeDemoMelody(SAMPLE_RATE);
  const track = analyzeTrack(samples, { ...DEFAULT_TRACK_OPTIONS, sampleRate: SAMPLE_RATE })
    .map((frame) => ({
      time: frame.time,
      hz: frame.hz,
      voiced: frame.hz > 0 ? 1 : 0,
      // The pipeline needs this: low-confidence frames are boundary artefacts.
      clarity: frame.clarity,
    }));
  const notes = segmentNotes(smoothTrack(track), {
    ...DEFAULT_SEGMENT_OPTIONS,
    frameDuration: DEFAULT_TRACK_OPTIONS.hopSize / SAMPLE_RATE,
  });
  const detection = detectKey(notes.map((n) => ({ midi: n.midi, duration: n.end - n.start })));
  const key = detection?.key ?? C_MAJOR;
  const grid = inferGrid(notes);
  const score = buildScore(quantizeNotes(notes, grid), grid, key);
  return { samples, notes, key, grid, score };
}

// ---------------------------------------------------------------------------
// The demo melody is a test fixture as much as a feature. If it stops
// transcribing exactly, the pipeline has regressed — a synthetic phrase is the
// only input in this suite whose correct answer is known for certain.
// ---------------------------------------------------------------------------

test('the demo melody transcribes to exactly the notes it was built from', () => {
  const { notes } = transcribeDemo();
  expect(notes.length).toBe(DEMO_EXPECTED_PITCHES.length);
  for (let i = 0; i < DEMO_EXPECTED_PITCHES.length; i++) {
    // Detection is a measurement, not a lookup: 60.02 is C4, not a wrong note.
    // A quarter of a semitone is far tighter than a note boundary, so this
    // cannot pass by accident on a neighbouring pitch.
    expect(Math.abs(notes[i].midi - DEMO_EXPECTED_PITCHES[i])).toBeLessThan(0.25);
  }
});

test('the demo melody reports its known tempo and key', () => {
  const { grid, key } = transcribeDemo();
  // Within 3%. Two effects push this off the written 100bpm, in opposite
  // directions: a note's end is reported one analysis hop early, which shortens
  // notes, while the detected median onset interval (0.602s) is slightly longer
  // than the written 0.600s. Neighbouring tempi a couple of bpm apart fit an
  // evenly-spaced phrase almost equally well, so the search lands within a few
  // bpm either side.
  expect(Math.abs(grid.bpm - DEMO_MELODY.bpm) / DEMO_MELODY.bpm).toBeLessThan(0.03);
  expect(key.tonic).toBe(C_MAJOR.tonic);
  expect(key.mode).toBe(C_MAJOR.mode);
});

test('the demo melody notates with the right note values and its rest', () => {
  const { score } = transcribeDemo();
  const events = score.events;
  const pitched = events.filter((e) => e.type === 'note') as Array<{
    midi: number; duration: number; start: number;
  }>;
  const rests = events.filter((e) => e.type === 'rest') as Array<{ duration: number; start: number }>;

  // 13 notes and one beat of rest, as written.
  expect(pitched.length).toBe(DEMO_EXPECTED_PITCHES.length);
  expect(rests.length).toBe(1);

  // Four bars of 4/4.
  expect(score.measures.length).toBe(4);
  expect(score.totalUnits).toBe(64);

  // Every quarter is 4 units, every half is 8 — or a half split across a
  // barline into two tied quarters, which is the same sounding length.
  for (const note of pitched) {
    expect([4, 8]).toContain(note.duration);
  }
  // 11 quarters + 2 halves + a one-beat rest = 11*4 + 2*8 + 4 = 64 units,
  // which is exactly four full bars. Summing notes and rests together is what
  // proves the score is complete: 16 beats written, 16 beats printed.
  const sounded = [...pitched, ...rests].reduce((sum, e) => sum + e.duration, 0);
  const written = DEMO_MELODY.notes.reduce((sum, note) => sum + note.beats, 0);
  expect(sounded / 4).toBe(written);
  expect(written).toBe(DEMO_MELODY.beatsPerMeasure * 4);
  // And the single rest is one beat.
  expect(rests[0].duration).toBe(4);
});

test('each bar of the demo score matches the phrase it came from', () => {
  const { score } = transcribeDemo();
  const perBar = (bar: number) =>
    score.events
      .filter((e) => e.start >= bar * score.unitsPerMeasure && e.start < (bar + 1) * score.unitsPerMeasure)
      .map((e) => (e.type === 'rest' ? `rest/${e.duration}` : `${e.midi}/${e.duration}`));

  // C4 D4 E4 F4 | G4 C5 B4 A4 | G4(half) F4 E4 | rest D4 C4(half)
  expect(perBar(0)).toEqual(['60/4', '62/4', '64/4', '65/4']);
  expect(perBar(1)).toEqual(['67/4', '72/4', '71/4', '69/4']);
  expect(perBar(2)).toEqual(['67/8', '65/4', '64/4']);
  expect(perBar(3)).toEqual(['rest/4', '62/4', '60/8']);
});

test('the rest is preserved rather than absorbed into a neighbouring note', () => {
  // A regression guard. Boundary smoothing used to pull the note after a rest
  // backwards onto the note before it, deleting the silence entirely: bar 4
  // came out as two half notes where the phrase has a rest, a quarter and a
  // half.
  const { score } = transcribeDemo();
  const lastBar = score.events.filter(
    (e) => e.start >= 3 * score.unitsPerMeasure,
  );
  expect(lastBar.map((e) => (e.type === 'rest' ? 'rest' : `note${e.duration}`))).toEqual([
    'rest',
    'note4',
    'note8',
  ]);
});

test('the demo score renders every note, and the right number of glyphs', () => {
  const { score } = transcribeDemo();
  const env = installDom();
  let markup = '';
  try {
    const svg = renderScore(env.container, score, { width: 760 });
    markup = new env.container.ownerDocument.defaultView!.XMLSerializer().serializeToString(svg);
  } finally {
    env.restore();
  }
  const pitched = score.events.filter((e) => e.type === 'note');
  const rests = score.events.filter((e) => e.type === 'rest');

  // VexFlow puts BOTH noteheads and rests inside a group classed
  // `vf-notehead`, so that class cannot tell them apart. The glyph codepoint
  // can: Bravura draws noteheads in the e0aX range and rests in the e4eX range,
  // so a rest wrongly drawn as a note is visible here.
  const glyphs = [...markup.matchAll(/<text[^>]*>([^<]+)<\/text>/g)]
    .map((m) => m[1].codePointAt(0)!);
  const noteGlyphs = glyphs.filter((code) => code >= 0xe0a0 && code <= 0xe0af);
  const restGlyphs = glyphs.filter((code) => code >= 0xe4e0 && code <= 0xe4ef);
  const clefs = glyphs.filter((code) => code === 0xe050).length;
  const times = glyphs.filter((code) => code === 0xe084).length;

  expect(noteGlyphs.length).toBe(pitched.length);
  expect(restGlyphs.length).toBe(rests.length);
  expect(clefs).toBe(2); // four bars at two per system
  expect(times).toBe(2); // 4/4 drawn as two '4' glyphs
  expect(glyphs.length).toBe(pitched.length + rests.length + clefs + times);
});

test('four bars at two per system lay out as two rows without overlap', () => {
  const { score } = transcribeDemo();
  const env = installDom();
  let markup = '';
  let height = 0;
  try {
    const svg = renderScore(env.container, score, { width: 760, measuresPerSystem: 2 });
    markup = new env.container.ownerDocument.defaultView!.XMLSerializer().serializeToString(svg);
    height = Number((svg.getAttribute('viewBox') ?? '').split(' ')[3]);
  } finally {
    env.restore();
  }
  // Four stave groups across two distinct rows.
  const staveYs = [...markup.matchAll(/<g class="vf-stave"[^>]*><path fill="none" d="M[\d.]+ ([\d.]+)/g)]
    .map((m) => Number(m[1]));
  expect(staveYs.length).toBe(4);
  expect(new Set(staveYs).size).toBe(2);
  expect(height).toBeGreaterThan(200);
});

// ---------------------------------------------------------------------------
// The feedback report is the only channel by which a real-recording judgement
// reaches the code. Its data path is checked against real pipeline output
// rather than a hand-written fixture, because every earlier regression came from
// trusting a fixture: the note list and the funnel have to come out of the same
// pipeline the browser runs, or the report describes something else entirely.
// ---------------------------------------------------------------------------

test('a feedback report describes a real transcription, not a placeholder', () => {
  const { score, key, samples } = transcribeDemo();
  const { notes, rhythm } = describeScoreEvents(score.events);

  const report = buildFeedbackReport([
    {
      verdict: 'bad',
      issues: ['missing-notes'],
      comment: 'the last two notes are gone',
      at: '2026-10-04T00:00:00.000Z',
      takeId: 'take-demo',
      source: 'demo',
      durationSeconds: samples.length / SAMPLE_RATE,
      voiceRange: 'auto',
      transpose: 0,
      keyLabel: keyLabel(key),
      bpm: score.grid.bpm,
      notes,
      rhythm,
      funnel: null,
    },
  ]);

  // Every note the pipeline found, in order, and the ones that were correct.
  expect(report).toContain(notes.join(' '));
  expect(notes).toHaveLength(DEMO_EXPECTED_PITCHES.length);
  expect(notes[0]).toBe('C4');

  // The rhythm line must agree with the note list, or a "wrong timing" report
  // would send me looking at a grid that does not match the engraving.
  expect(rhythm).toHaveLength(notes.length);
  expect(report).toContain(rhythm.join(' '));

  expect(report).toContain(keyLabel(key));
  expect(report).toContain(String(score.grid.bpm));
  expect(report).toContain('the last two notes are gone');
  expect(report).toContain('Download recording');
});

test('the report would let a stated melody be compared against the detected one', () => {
  const { score } = transcribeDemo();
  const { notes } = describeScoreEvents(score.events);

  // The whole point: a user who knows what they sang can type it, and the
  // detected list is present to diff against. So the detected names have to be
  // exact and complete, not rounded to a scale or collapsed.
  const expectedNames = DEMO_EXPECTED_PITCHES.map((midi) => noteName(midi));
  expect(notes).toEqual(expectedNames);
});
