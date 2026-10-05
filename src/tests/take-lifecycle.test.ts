import { describe, expect, test } from 'bun:test';
import { adoptTake, DEFAULT_PLAY_LABEL, resetTake, type TakeState } from '../lib/audio/take-lifecycle';

/** A stand-in for the audio element that records what was done to it. */
function fakeAudio() {
  const revoked: string[] = [];
  const element = {
    src: 'blob:https://example.test/abc-123',
    paused: false,
    currentTime: 4.2,
    onended: (() => {}) as unknown,
    ontimeupdate: (() => {}) as unknown,
    loadCount: 0,
    pause() { this.paused = true; },
    load() { this.loadCount++; },
    removeAttribute(name: string) { if (name === 'src') this.src = ''; },
  };
  return { element, revoked };
}

test('reset clears the take, the button and the playhead', () => {
  const take: TakeState = { blob: new Blob(['audio']), duration: 9.6 };
  const labels = { playButton: { textContent: 'Stop playback' }, playhead: { textContent: '4.2s / 9.6s' } };
  const { element } = fakeAudio();
  let released = 0;

  resetTake(take, element as never, () => { released++; }, labels);

  // This is the reported bug: any of these left set means the old take is
  // still reachable after a reset.
  expect(take.blob).toBeNull();
  expect(take.duration).toBe(0);
  expect(labels.playButton.textContent).toBe(DEFAULT_PLAY_LABEL);
  expect(labels.playhead.textContent).toBe('');
  expect(element.paused).toBe(true);
  expect(released).toBe(1);
});

test('reset detaches event handlers so a stale event cannot repaint a label', () => {
  const take: TakeState = { blob: new Blob(['audio']), duration: 3 };
  const labels = { playButton: { textContent: '' }, playhead: { textContent: '' } };
  const { element } = fakeAudio();
  const before = element.ontimeupdate;
  expect(typeof before).toBe('function');

  resetTake(take, element as never, () => {}, labels);
  expect(element.ontimeupdate).toBeNull();
  expect(element.onended).toBeNull();
});

test('reset revokes the object URL so the blob is not leaked', () => {
  const take: TakeState = { blob: new Blob(['audio']), duration: 1 };
  const labels = { playButton: { textContent: '' }, playhead: { textContent: '' } };
  const { element } = fakeAudio();
  const revoked: string[] = [];

  // The module resolves `URL` at call time from the global, so replacing it
  // here is enough to observe the calls.
  const globals = globalThis as unknown as { URL: unknown };
  const previous = globals.URL;
  globals.URL = {
    createObjectURL: () => element.src,
    revokeObjectURL: (url: string) => { revoked.push(url); },
  };
  try {
    resetTake(take, element as never, () => {}, labels);
  } finally {
    globals.URL = previous;
  }

  // Every take leaks a full recording if this is skipped.
  expect(revoked).toContain('blob:https://example.test/abc-123');
});

test('reset is safe with no audio element at all', () => {
  const take: TakeState = { blob: null, duration: 0 };
  const labels = { playButton: { textContent: DEFAULT_PLAY_LABEL }, playhead: { textContent: '' } };
  let released = 0;
  expect(() => resetTake(take, null, () => { released++; }, labels)).not.toThrow();
  expect(take.blob).toBeNull();
  expect(released).toBe(1);
});

test('reset is idempotent', () => {
  const take: TakeState = { blob: new Blob(['a']), duration: 5 };
  const labels = { playButton: { textContent: 'Stop playback' }, playhead: { textContent: '1s' } };
  const { element } = fakeAudio();
  let released = 0;
  resetTake(take, element as never, () => { released++; }, labels);
  expect(() => resetTake(take, element as never, () => { released++; }, labels)).not.toThrow();
  expect(take.blob).toBeNull();
  expect(released).toBe(2);
});

test('a non-blob source is never revoked', () => {
  // Guard against revoking a URL the app did not create.
  const take: TakeState = { blob: null, duration: 0 };
  const labels = { playButton: { textContent: '' }, playhead: { textContent: '' } };
  const { element } = fakeAudio();
  element.src = 'https://cdn.example.test/track.mp3';
  const revoked: string[] = [];

  const globals = globalThis as unknown as { URL: unknown };
  const previous = globals.URL;
  globals.URL = { revokeObjectURL: (url: string) => { revoked.push(url); } };
  try {
    resetTake(take, element as never, () => {}, labels);
  } finally {
    globals.URL = previous;
  }
  expect(revoked).toEqual([]);
});

/**
 * The regression that made the audio undownloadable.
 *
 * A user pasted a feedback report and it turned out to describe one recording
 * reported seven times. Chasing that surfaced the real damage: every take said
 * "0.0s", because `take.duration` was being read after something had already
 * zeroed it. The same call had also nulled `take.blob`, so "Play recording" and
 * "Download recording" returned early every time. The button a user had been
 * asked to press to send in their recording was the one button that could not
 * work.
 */
describe('adoptTake', () => {
  function setup() {
    const take: TakeState = { blob: new Blob(['old']), duration: 3 };
    const labels = {
      playButton: { textContent: 'Stop playback' },
      playhead: { textContent: '1.0s / 3.0s' },
    };
    let released = 0;
    return {
      take,
      labels,
      releasedCount: () => released,
      release: () => {
        released++;
      },
    };
  }

  test('the new take survives, rather than being cleared by the release', () => {
    const { take, labels, release } = setup();
    const blob = new Blob(['new']);
    adoptTake(take, null, release, labels, { blob, duration: 14.2 });

    // The bug was `take.blob` being null here.
    expect(take.blob).toBe(blob);
    expect(take.blob).not.toBeNull();
    expect(take.duration).toBe(14.2);
  });

  test('the previous take is still released', () => {
    const { take, labels, release, releasedCount } = setup();
    adoptTake(take, null, release, labels, { blob: new Blob(['new']), duration: 1 });
    expect(releasedCount()).toBe(1);
  });

  test('stale labels are reset, so the playhead never quotes the old take', () => {
    const { take, labels, release } = setup();
    adoptTake(take, null, release, labels, { blob: new Blob(['new']), duration: 14.2 });
    expect(labels.playButton.textContent).toBe(DEFAULT_PLAY_LABEL);
    expect(labels.playhead.textContent).toBe('');
  });

  test('a fresh take is never null after adoption, over repeated takes', () => {
    const take: TakeState = { blob: null, duration: 0 };
    const labels = { playButton: { textContent: '' }, playhead: { textContent: '' } };
    const release = () => {};
    for (let i = 0; i < 5; i++) {
      adoptTake(take, null, release, labels, { blob: new Blob([`take${i}`]), duration: i + 1 });
      expect(take.blob).not.toBeNull();
      expect(take.duration).toBe(i + 1);
    }
  });
});
