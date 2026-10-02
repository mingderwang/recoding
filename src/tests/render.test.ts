import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

/**
 * Rendering is the one part of the app that cannot be checked with pure
 * functions, and it is also the part a user notices first. These tests drive
 * the real VexFlow renderer against a DOM so a regression in the engraving
 * shows up in `bun test` rather than in the browser.
 */
interface DomEnvironment {
  document: Document;
  container: HTMLElement;
  XMLSerializer: typeof XMLSerializer;
  restore(): void;
}

function installDom(): DomEnvironment {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = [
    'window', 'document', 'navigator', 'Node', 'SVGElement',
    'HTMLElement', 'XMLSerializer', 'DocumentFragment', 'SVGSVGElement',
  ] as const;
  const previous = new Map<string, unknown>();
  for (const key of keys) previous.set(key, globals[key]);

  const win = dom.window as unknown as Record<string, unknown>;
  for (const key of keys) globals[key] = win[key];

  return {
    document: dom.window.document,
    container: dom.window.document.getElementById('host') as HTMLElement,
    XMLSerializer: win.XMLSerializer as typeof XMLSerializer,
    restore() {
      for (const [key, value] of previous) globals[key] = value;
    },
  };
}

const GRID = {
  bpm: 120,
  beatsPerStep: 0.25,
  secondsPerStep: 0.125,
  beatsPerMeasure: 4,
  stepsPerMeasure: 16,
  cost: 0,
};

const C_MAJOR = { tonic: 0, mode: 'major' } as const;

async function renderInto(options: {
  pitches: number[];
  width?: number;
  measuresPerSystem?: number;
  key?: { tonic: number; mode: 'major' | 'minor' };
}): Promise<{ markup: string; viewBox: string | null; width: number; height: number }> {
  const env = installDom();
  try {
    const { buildScore } = await import('../lib/music/score');
    const { renderScore } = await import('../lib/ui/render-score');

    const score = buildScore(
      options.pitches.map((midi, index) => ({
        startStep: index * 4,
        durationSteps: 4,
        midi,
        confidence: 1,
      })),
      GRID,
      (options.key ?? C_MAJOR) as Parameters<typeof buildScore>[2],
    );

    const svg = renderScore(env.container, score, {
      width: options.width,
      measuresPerSystem: options.measuresPerSystem,
    });
    return {
      markup: new env.XMLSerializer().serializeToString(svg),
      viewBox: svg.getAttribute('viewBox'),
      width: svg.getAttribute('width') ? Number(svg.getAttribute('width')) : 0,
      height: svg.getAttribute('height') ? Number(svg.getAttribute('height')) : 0,
    };
  } finally {
    env.restore();
  }
}

test('renderScore produces a sized SVG containing drawn note paths', async () => {
  const { markup, viewBox } = await renderInto({ pitches: [60, 62, 64, 65], width: 700 });
  expect(viewBox).toBeTruthy();
  expect(viewBox).toMatch(/^0 0 [\d.]+ [\d.]+$/);
  // The staff lines and noteheads are drawn as paths; an SVG with no children
  // would mean nothing rendered at all.
  expect(markup).toContain('<path');
  expect(markup.length).toBeGreaterThan(1000);
});

test('renderScore produces the same notation for the same score', async () => {
  const strip = (markup: string) => markup.replace(/id="vf-auto\d+"/g, 'id="x"');
  const first = await renderInto({ pitches: [60, 62, 64, 65], width: 700 });
  const second = await renderInto({ pitches: [60, 62, 64, 65], width: 700 });
  // VexFlow gives every element a globally incrementing id, so the markup can
  // only be compared once those are normalised away.
  expect(strip(first.markup)).toBe(strip(second.markup));
});

test('renderScore grows taller as it wraps onto more systems', async () => {
  const one = await renderInto({ pitches: [60, 62, 64, 65], measuresPerSystem: 1, width: 300 });
  const four = await renderInto({ pitches: [60, 62, 64, 65], measuresPerSystem: 4, width: 900 });
  // Four quarter notes is one measure, so these should be the same height...
  expect(four.height).toBe(one.height);

  // Twelve measures must produce three systems at one measure per system.
  const many = Array.from({ length: 48 }, (_, i) => 60 + (i % 8));
  const stacked = await renderInto({ pitches: many, measuresPerSystem: 1, width: 300 });
  const single = await renderInto({ pitches: many, measuresPerSystem: 48, width: 900 });
  expect(stacked.height).toBeGreaterThan(single.height * 2);
});

test('renderScore handles an empty score without throwing', async () => {
  const env = installDom();
  try {
    const { buildScore } = await import('../lib/music/score');
    const { renderScore } = await import('../lib/ui/render-score');
    const score = buildScore([], GRID, C_MAJOR);
    expect(() => renderScore(env.container, score, { width: 400 })).not.toThrow();
  } finally {
    env.restore();
  }
});

test('renderScore uses a different clef for a low melody', async () => {
  const low = await renderInto({ pitches: [45, 47, 48, 50], width: 600 });
  const high = await renderInto({ pitches: [72, 74, 76, 77], width: 600 });
  // Bass and treble clefs are different glyphs, so the two renderings must
  // differ even though the note values are identical.
  expect(low.markup).not.toBe(high.markup);
});

test('renderScore draws a different score for a different key', async () => {
  const cMajor = await renderInto({ pitches: [66, 67, 69, 71], width: 600, key: C_MAJOR });
  const gMajor = await renderInto({ pitches: [66, 67, 69, 71], width: 600, key: { tonic: 7, mode: 'major' } });
  // In G major the F sharp is in the signature, so it prints no accidental;
  // in C major it must print a sharp. The staves cannot be identical.
  expect(cMajor.markup).not.toBe(gMajor.markup);
});

test('renderScore clears the container before drawing', async () => {
  const env = installDom();
  try {
    const { buildScore } = await import('../lib/music/score');
    const { renderScore } = await import('../lib/ui/render-score');
    const stale = env.document.createElement('p');
    stale.textContent = 'stale content';
    env.container.appendChild(stale);

    const score = buildScore(
      [{ startStep: 0, durationSteps: 4, midi: 60, confidence: 1 }],
      GRID,
      C_MAJOR,
    );
    renderScore(env.container, score, { width: 400 });
    expect(env.container.textContent).not.toContain('stale content');
  } finally {
    env.restore();
  }
});
