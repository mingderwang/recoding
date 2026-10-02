import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS } from '../lib/dsp/frames';
import { smoothTrack } from '../lib/dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS } from '../lib/music/segment';
import { detectKey } from '../lib/music/key';
import { inferGrid, quantizeNotes } from '../lib/music/quantize';
import { buildScore } from '../lib/music/score';
import { renderScore } from '../lib/ui/render-score';
import { synthesizeDemoMelody, DEMO_MELODY, DEMO_EXPECTED } from '../lib/audio/demo-melody';

const SAMPLE_RATE = 44100;

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
    .map((frame) => ({ time: frame.time, hz: frame.hz, voiced: frame.hz > 0 ? 1 : 0 }));
  const notes = segmentNotes(smoothTrack(track, { medianRadius: 2, octaveTolerance: 0.75 }), {
    ...DEFAULT_SEGMENT_OPTIONS,
    frameDuration: DEFAULT_TRACK_OPTIONS.hopSize / SAMPLE_RATE,
  });
  const detection = detectKey(notes.map((n) => ({ midi: n.midi, duration: n.end - n.start })));
  const key = detection?.key ?? { tonic: 0, mode: 'major' as const };
  const grid = inferGrid(notes);
  const score = buildScore(quantizeNotes(notes, grid), grid, key);
  return { notes, key, grid, score };
}

test('the demo melody transcribes to the notes it was built from', () => {
  const { notes } = transcribeDemo();
  expect(notes.length).toBe(DEMO_MELODY.notes.length);
  for (let i = 0; i < DEMO_MELODY.notes.length; i++) {
    expect(notes[i].midi).toBeCloseTo(DEMO_MELODY.notes[i], 0);
  }
});

test('the demo melody reports its known tempo and key', () => {
  const { grid, key } = transcribeDemo();
  expect(Math.abs(grid.bpm - DEMO_EXPECTED.bpm)).toBeLessThanOrEqual(2);
  expect(key.tonic).toBe(DEMO_EXPECTED.key.tonic);
  expect(key.mode).toBe(DEMO_EXPECTED.key.mode);
});

test('the demo melody notates as even quarter notes', () => {
  const { score } = transcribeDemo();
  const pitched = score.events.filter((e) => e.type === 'note');
  expect(pitched.length).toBe(DEMO_MELODY.notes.length);
  for (const note of pitched) {
    // One quarter note = 4 sixteenth units.
    expect(note.duration).toBe(4);
  }
});

test('measures are laid out side by side, not stacked on one another', () => {
  // The bug this guards against: every measure in a system was drawn at the
  // same x with the full system width, so all but the first were painted
  // directly over the first. It produced plausible-looking output that
  // silently lost most of the melody.
  const GRID = {
    bpm: 120, beatsPerStep: 0.25, secondsPerStep: 0.125,
    beatsPerMeasure: 4, stepsPerMeasure: 16, cost: 0,
  };
  const score = buildScore(
    [60, 62, 64, 65, 67, 69, 71, 72].map((midi, i) => ({
      startStep: i * 4, durationSteps: 4, midi, confidence: 1,
    })),
    GRID,
    { tonic: 0, mode: 'major' },
  );
  expect(score.measures.length).toBe(2);

  const env = installDom();
  let markup = '';
  let viewBox = '';
  try {
    const svg = renderScore(env.container, score, { width: 760, measuresPerSystem: 2 });
    markup = new env.container.ownerDocument.defaultView!.XMLSerializer().serializeToString(svg);
    viewBox = svg.getAttribute('viewBox') ?? '';
  } finally {
    env.restore();
  }

  // Both measures share a staff line, so each staff path's start x is the
  // measure's left edge. They must differ.
  const staves = [...markup.matchAll(/<g class="vf-stave"[^>]*><path fill="none" d="M([\d.]+) /g)]
    .map((m) => Number(m[1]));
  expect(staves.length).toBe(2);
  expect(staves[0]).not.toBe(staves[1]);
  expect(staves[0]).toBeLessThan(staves[1]);

  // And all eight notes must be drawn, not just the four in the first measure.
  const noteheads = (markup.match(/vf-notehead/g) || []).length;
  expect(noteheads).toBe(8);

  // Two measures on one system means one system height, not two.
  const height = Number(viewBox.split(' ')[3]);
  expect(height).toBeLessThan(200);
});

test('a longer score wraps onto additional systems', () => {
  const GRID = {
    bpm: 120, beatsPerStep: 0.25, secondsPerStep: 0.125,
    beatsPerMeasure: 4, stepsPerMeasure: 16, cost: 0,
  };
  const score = buildScore(
    Array.from({ length: 32 }, (_, i) => ({ startStep: i * 4, durationSteps: 4, midi: 60 + (i % 8), confidence: 1 })),
    GRID,
    { tonic: 0, mode: 'major' },
  );
  expect(score.measures.length).toBe(8);

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

  // 8 measures at 2 per system = 4 systems = 8 staff rows.
  const staveYs = [...markup.matchAll(/<g class="vf-stave"[^>]*><path fill="none" d="M[\d.]+ ([\d.]+)/g)]
    .map((m) => Number(m[1]));
  expect(staveYs.length).toBe(8);
  expect(new Set(staveYs).size).toBe(4); // 4 distinct rows, 2 measures each
  expect(height).toBeGreaterThan(400);

  // Every note in the score is drawn, across all systems.
  expect((markup.match(/vf-notehead/g) || []).length).toBe(32);
});

test('the demo melody renders every note, plus the rest that fills its last bar', () => {
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
  expect(pitched.length).toBe(10);
  // Ten quarter notes fill two and a half bars, so a rest is required to
  // complete the third — that is correct engraving, not a stray symbol.
  expect(rests.length).toBe(1);

  // VexFlow puts BOTH noteheads and rests inside a group classed
  // `vf-notehead`, so counting that class cannot tell them apart. The glyph
  // codepoint can: Bravura draws noteheads in the e0aX range and rests in the
  // e4eX range, so a rest wrongly drawn as a note is visible here.
  const glyphs = [...markup.matchAll(/<text[^>]*>([^<]+)<\/text>/g)]
    .map((m) => m[1].codePointAt(0)!);
  const noteGlyphs = glyphs.filter((code) => code >= 0xe0a0 && code <= 0xe0af);
  const restGlyphs = glyphs.filter((code) => code >= 0xe4e0 && code <= 0xe4ef);

  expect(noteGlyphs.length).toBe(pitched.length);
  expect(restGlyphs.length).toBe(rests.length);
  // A clef (0xe050) opens every system, and a 4/4 signature (two '4' glyphs)
  // appears only on the very first measure. Ten quarter notes make three bars,
  // which is two systems at two measures per line, so two clefs.
  const clefGlyphs = glyphs.filter((code) => code === 0xe050).length;
  const timeGlyphs = glyphs.filter((code) => code === 0xe084).length;
  expect(clefGlyphs).toBe(2);
  expect(timeGlyphs).toBe(2);
  expect(glyphs.length).toBe(pitched.length + rests.length + clefGlyphs + timeGlyphs);
});
