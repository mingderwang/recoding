/**
 * The feedback report is the only channel by which real-recording judgements
 * reach the code, so a bug in it silently destroys the signal it exists to
 * carry. These tests pin the parts that would drop data.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildFeedbackReport,
  clearFeedback,
  describeNotes,
  describeScoreEvents,
  feedbackCounts,
  loadFeedback,
  MAX_FEEDBACK_RECORDS,
  noteName,
  recordFeedback,
  saveFeedback,
  FEEDBACK_STORAGE_KEY,
  type FeedbackIssue,
  type FeedbackRecord,
  type FeedbackStorage,
} from '../lib/diagnostics/feedback';
import type { FunnelStats } from '../lib/diagnostics/funnel';

/** An in-memory stand-in for localStorage, including its failure modes. */
function memoryStorage(seed?: string): FeedbackStorage & { raw: string | null } {
  const store: { raw: string | null } = { raw: seed ?? null };
  return {
    get raw() {
      return store.raw;
    },
    getItem: (key) => (key === FEEDBACK_STORAGE_KEY ? store.raw : null),
    setItem: (key, value) => {
      if (key === FEEDBACK_STORAGE_KEY) store.raw = value;
    },
  };
}

const funnel: FunnelStats = {
  windows: 546,
  tooQuiet: 20,
  noPitchFound: 300,
  detected: 226,
  droppedClarityFloor: 0,
  droppedClarityRatio: 0,
  afterSmoothing: 226,
  voicedRuns: 40,
  runsTooShort: 12,
  tooShortDurations: [40, 55, 61],
  notes: 23,
  pitches: [60, 62, 64],
  medianClarity: 0.65,
  windowMs: 92.9,
  minNoteMs: 70,
};

function record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    verdict: 'bad',
    issues: ['missing-notes'],
    comment: '',
    at: '2026-10-04T12:00:00.000Z',
    takeId: 'take-1',
    source: 'recording',
    durationSeconds: 12.4,
    voiceRange: 'tenor',
    transpose: 0,
    keyLabel: 'C major',
    bpm: 96,
    notes: ['C4', 'D4', 'E4'],
    rhythm: ['0:2', '2:1', '3:4'],
    funnel,
    ...overrides,
  };
}

describe('noteName', () => {
  test('names middle C correctly', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(21)).toBe('A0');
  });

  test('rounds a fractional pitch instead of producing an octave below', () => {
    // DetectedNote.midi is fractional. Truncating would turn a detected A4 into
    // a G3 an octave down, which is the exact class of bug being hunted.
    expect(noteName(69.2)).toBe('A4');
    expect(noteName(60.6)).toBe('C#4');
    // Cross-check the octave boundary explicitly: 59.4 is below middle C.
    expect(noteName(59.4)).toBe('B3');
  });
});

describe('storage', () => {
  test('round-trips a record', () => {
    const storage = memoryStorage();
    recordFeedback(storage, record());
    const loaded = loadFeedback(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].verdict).toBe('bad');
    expect(loaded[0].issues).toEqual(['missing-notes']);
  });

  test('survives corrupt storage instead of breaking the page', () => {
    expect(loadFeedback(memoryStorage('not json'))).toEqual([]);
    expect(loadFeedback(memoryStorage('{"verdict":"maybe"}'))).toEqual([]);
    expect(loadFeedback(memoryStorage('[1,2,3]'))).toEqual([]);
    expect(loadFeedback(memoryStorage('null'))).toEqual([]);
  });

  test('works with no storage at all', () => {
    expect(loadFeedback(null)).toEqual([]);
    expect(() => recordFeedback(null, record())).not.toThrow();
    expect(() => clearFeedback(null)).not.toThrow();
  });

  test('a full quota does not throw, because the copy must still work', () => {
    const failing: FeedbackStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => saveFeedback(failing, [record()])).not.toThrow();
  });

  test('re-rating the same take replaces it rather than contradicting itself', () => {
    const storage = memoryStorage();
    recordFeedback(storage, record({ verdict: 'bad', issues: ['missing-notes'] }));
    const after = recordFeedback(storage, record({ verdict: 'good' }));
    expect(after).toHaveLength(1);
    expect(after[0].verdict).toBe('good');
  });

  test('ticking more symptoms refines one record, it does not append a new take', () => {
    // The real bug: the page restamps `at` on every submit, and every symptom
    // checkbox triggers a submit. A single recording rated six times was
    // reported as six takes with identical notes, and a paste of "7 takes" was
    // really one take and six clicks.
    //
    // Each submit re-reads every checked box, so the symptoms accumulate. That
    // is modelled here rather than replacing the list each round, which is what
    // the page actually does.
    const storage = memoryStorage();
    const takeId = 'take-abc';
    const ticked: FeedbackIssue[] = [];
    let at = '2026-10-04T12:00:00.000Z';

    for (const issue of ['missing-notes', 'wrong-pitches', 'wrong-rhythm'] as const) {
      at = new Date(Date.parse(at) + 1000).toISOString(); // a new timestamp each time
      ticked.push(issue);
      recordFeedback(storage, record({ takeId, at, issues: [...ticked] }));
    }

    const stored = loadFeedback(storage);
    expect(stored).toHaveLength(1);
    expect(stored[0].issues).toEqual(['missing-notes', 'wrong-pitches', 'wrong-rhythm']);
    // The last write wins for the timestamp, which is right: it is when the
    // rating was last revised.
    expect(stored[0].at).toBe(at);
  });

  test('different takes are kept apart', () => {
    const storage = memoryStorage();
    recordFeedback(storage, record({ takeId: 'take-a' }));
    recordFeedback(storage, record({ takeId: 'take-b' }));
    expect(loadFeedback(storage)).toHaveLength(2);
  });

  test('history is bounded', () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_FEEDBACK_RECORDS + 5; i++) {
      recordFeedback(storage, record({ takeId: `take-${i}` }));
    }
    const loaded = loadFeedback(storage);
    expect(loaded).toHaveLength(MAX_FEEDBACK_RECORDS);
    // The oldest is dropped, so the newest rating is always present.
    expect(loaded[loaded.length - 1].takeId).toBe(`take-${MAX_FEEDBACK_RECORDS + 4}`);
  });

  test('clear empties the history', () => {
    const storage = memoryStorage();
    recordFeedback(storage, record());
    clearFeedback(storage);
    expect(loadFeedback(storage)).toEqual([]);
  });
});

describe('buildFeedbackReport', () => {
  test('says how to send the audio, since the numbers alone are not enough', () => {
    const report = buildFeedbackReport([record()]);
    expect(report).toContain('Download recording');
  });

  test('carries the funnel, which is what localises the loss', () => {
    const report = buildFeedbackReport([record()]);
    expect(report).toContain('too short');
    expect(report).toContain('23'); // notes counted by the funnel
    expect(report).toContain('0.65'); // median clarity
  });

  test('carries the note list, so a stated melody can be compared', () => {
    const report = buildFeedbackReport([record()]);
    expect(report).toContain('C4 D4 E4');
  });

  test('names the problem in plain language, not an internal id', () => {
    const report = buildFeedbackReport([record({ issues: ['missing-notes'] })]);
    expect(report).toContain('Notes are missing');
    expect(report).not.toContain('missing-notes');
  });

  test('carries the user comment, which is where ground truth arrives', () => {
    const report = buildFeedbackReport([record({ comment: 'the "oh" notes are gone' })]);
    expect(report).toContain('the "oh" notes are gone');
  });

  test('includes settings, since a wrong range explains a transposition', () => {
    const report = buildFeedbackReport([record({ voiceRange: 'soprano', transpose: -12 })]);
    expect(report).toContain('voice=soprano transpose=-12');
  });

  test('summarises a very long note list rather than pasting thousands of notes', () => {
    const notes = Array.from({ length: 400 }, () => 'C4');
    const report = buildFeedbackReport([record({ notes })]);
    expect(report).toContain('and 280 more');
  });

  test('counts verdicts in the header', () => {
    const report = buildFeedbackReport([record(), record({ verdict: 'good', takeId: 'take-2' })]);
    expect(report).toContain('(1 good, 1 bad)');
  });

  test('handles a take with no funnel', () => {
    const report = buildFeedbackReport([record({ funnel: null })]);
    expect(report).toContain('(not captured)');
  });

  test('handles an empty history', () => {
    expect(buildFeedbackReport([])).toContain('no ratings yet');
  });
});

describe('describeNotes, describeRhythm and feedbackCounts', () => {
  test('describeNotes keeps order', () => {
    expect(describeNotes([{ midi: 60 }, { midi: 67 }, { midi: 72 }])).toEqual(['C4', 'G4', 'C5']);
  });

  test('describeScoreEvents reads positions as start:duration', () => {
    expect(
      describeScoreEvents([
        { type: 'note', midi: 60, start: 0, duration: 4 },
        { type: 'rest', start: 4, duration: 2 },
        { type: 'note', midi: 67, start: 6, duration: 2 },
      ]),
    ).toEqual({ notes: ['C4', 'G4'], rhythm: ['0:4', '6:2'] });
  });

  test('describeScoreEvents skips rests, so a spurious rest reads as a missing note', () => {
    expect(describeScoreEvents([{ type: 'rest', start: 0, duration: 4 }]).notes).toEqual([]);
  });

  test('the report includes the rhythm, so a timing complaint is actionable', () => {
    expect(buildFeedbackReport([record()])).toContain('0:2 2:1 3:4');
  });

  test('feedbackCounts splits verdicts', () => {
    expect(
      feedbackCounts([
        record(),
        record({ verdict: 'good', takeId: 'take-2' }),
        record({ verdict: 'good', takeId: 'take-3' }),
      ]),
    ).toEqual({ good: 2, bad: 1 });
  });
});