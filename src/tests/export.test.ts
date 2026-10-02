import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { buildScore } from '../lib/music/score';
import { renderScore } from '../lib/ui/render-score';
import { serializeSvg } from '../lib/ui/export-image';
import { scoreToMidi, variableLength } from '../lib/music/midi';

const GRID = {
  bpm: 120,
  beatsPerStep: 0.25,
  secondsPerStep: 0.125,
  beatsPerMeasure: 4,
  stepsPerMeasure: 16,
  cost: 0,
};
const C_MAJOR = { tonic: 0, mode: 'major' } as const;

function installDom(): {
  document: Document;
  container: HTMLElement;
  window: Window & typeof globalThis;
  restore: () => void;
} {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>
       @font-face { font-family: 'Bravura'; src: url('data:font/woff2;base64,AAAA') format('woff2'); }
     </style></head><body><div id="host"></div></body></html>`,
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = [
    'window', 'document', 'navigator', 'Node', 'SVGElement',
    'HTMLElement', 'XMLSerializer', 'DocumentFragment', 'SVGSVGElement',
    'CSSFontFaceRule', 'Image',
  ] as const;
  const previous = new Map<string, unknown>();
  for (const key of keys) previous.set(key, globals[key]);
  const win = dom.window as unknown as Record<string, unknown>;
  for (const key of keys) globals[key] = win[key];

  return {
    document: dom.window.document,
    container: dom.window.document.getElementById('host') as HTMLElement,
    window: dom.window as unknown as Window & typeof globalThis,
    restore() {
      for (const [key, value] of previous) globals[key] = value;
    },
  };
}

test('serializeSvg inlines the music font so the file is self-contained', () => {
  const env = installDom();
  try {
    const score = buildScore(
      [{ startStep: 0, durationSteps: 4, midi: 60, confidence: 1 }],
      GRID,
      C_MAJOR,
    );
    const svg = renderScore(env.container, score, { width: 400 });
    const markup = serializeSvg(svg);

    // Without an inlined @font-face the noteheads and clef render as blank
    // boxes in a saved file or a rasterised PNG, because the document's font
    // registration is not visible from an isolated SVG context.
    expect(markup).toContain('@font-face');
    expect(markup).toContain('Bravura');
    expect(markup).toContain('data:font/woff2');
    // The drawn notation must survive into the exported document.
    expect(markup).toContain('<path');
    expect(markup).toContain('score-svg');
    // A white background, so a transparent PNG is not what the user gets.
    expect(markup).toContain('#ffffff');
  } finally {
    env.restore();
  }
});

test('serializeSvg is valid, parseable XML', async () => {
  const env = installDom();

  const score = buildScore(
    [60, 62, 64].map((midi, i) => ({ startStep: i * 4, durationSteps: 4, midi, confidence: 1 })),
    GRID,
    C_MAJOR,
  );
  const markup = serializeSvg(renderScore(env.container, score, { width: 400 }));
  // Restore before parsing: building a second JSDOM while `document` still
  // points at the first one produces a spurious DataCloneError.
  env.restore();

  // Parse the result the way a browser would when opening the file.
  const parsed = new JSDOM(markup, { contentType: 'image/svg+xml' });
  expect(parsed.window.document.documentElement.tagName.toLowerCase()).toBe('svg');
  expect(parsed.window.document.querySelectorAll('path').length).toBeGreaterThan(0);
});

test('variableLength encodes MIDI delta times correctly', () => {
  // Values above 127 need continuation bytes, which is where hand-rolled VLQ
  // writers usually go wrong.
  expect(variableLength(0)).toEqual([0]);
  expect(variableLength(127)).toEqual([127]);
  expect(variableLength(128)).toEqual([0x81, 0x00]);
  expect(variableLength(480)).toEqual([0x83, 0x60]);
  expect(variableLength(16383)).toEqual([0xff, 0x7f]);
  expect(variableLength(16384)).toEqual([0x81, 0x80, 0x00]);
  // Each byte after the first must carry the continuation bit.
  for (const value of [0, 1, 127, 128, 480, 16384, 1_000_000]) {
    const bytes = variableLength(value);
    for (let i = 0; i < bytes.length - 1; i++) {
      expect(bytes[i] & 0x80).not.toBe(0);
    }
    expect(bytes[bytes.length - 1] & 0x80).toBe(0);
  }
});

test('scoreToMidi output is byte-identical for the same score', () => {
  const env = installDom();
  try {
    const score = buildScore(
      [60, 62, 64, 65].map((midi, i) => ({ startStep: i * 4, durationSteps: 4, midi, confidence: 0.8 })),
      GRID,
      C_MAJOR,
    );
    const a = scoreToMidi(score);
    const b = scoreToMidi(score);
    expect(Array.from(a)).toEqual(Array.from(b));
  } finally {
    env.restore();
  }
});
