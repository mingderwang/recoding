import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Checks against the *built* output in dist/, because the failure this guards
 * against is invisible in the source: a hand-written
 * `<script type="module" src="../scripts/app.ts">` is copied to the HTML
 * verbatim, so the page builds, the build succeeds, and the deployed site has
 * no JavaScript at all.
 *
 * Skipped when dist/ is absent, so `bun test` still works on a fresh clone.
 */
const DIST = join(process.cwd(), 'dist');
const built = existsSync(join(DIST, 'index.html'));

test('the built page has a bundled, hashed script', () => {
  if (!built) return;
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]);

  const moduleScripts = scripts.filter((tag) => /type="module"/.test(tag));
  expect(moduleScripts.length).toBeGreaterThan(0);

  for (const tag of moduleScripts) {
    const src = /src="([^"]+)"/.exec(tag)?.[1];
    expect(src).toBeDefined();
    // A built asset path is root-relative and content-hashed.
    expect(src).toMatch(/^\/_astro\/[\w.-]+\.js$/);
    // Never a source path or a bare relative reference: neither resolves on a
    // deployed host.
    expect(src).not.toContain('.ts');
    expect(src).not.toMatch(/^\.\.?/);
  }
});

test('every local asset the built page references actually exists', () => {
  if (!built) return;
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const references = [
    ...[...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]),
  ];
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) {
    const path = join(DIST, reference.replace(/^\//, ''));
    expect(existsSync(path)).toBe(true);
  }
});

test('the built page contains the controls the app drives', () => {
  if (!built) return;
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  // app.ts looks these up by id at startup and throws if any is missing.
  for (const id of [
    'record', 'stop', 'demo', 'status', 'level', 'level-fill',
    'pitch-readout', 'pitch-label', 'timer', 'progress', 'progress-fill',
    'results', 'summary', 'score-host', 'play', 'playhead-label',
    'download-midi', 'download-svg', 'download-png', 'restart',
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
});

test('vercel.json allows the microphone', () => {
  const path = join(process.cwd(), 'vercel.json');
  if (!existsSync(path)) return;
  const config = JSON.parse(readFileSync(path, 'utf8')) as {
    // Headers are declared per route, each with its own header list.
    headers?: Array<{ source?: string; headers?: Array<{ key?: string; value?: string }> }>;
  };
  const policy = config.headers
    ?.flatMap((route) => route.headers ?? [])
    .find((header) => header.key?.toLowerCase() === 'permissions-policy')?.value;
  // Without this the browser blocks getUserMedia on the deployed origin.
  expect(policy).toBeTruthy();
  expect(policy).toMatch(/microphone=\(self\)/);
});
