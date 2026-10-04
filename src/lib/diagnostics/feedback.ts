/**
 * In-app feedback: was this transcription right or wrong, and if wrong, how?
 *
 * Why this exists. Every regression found so far came from tuning against
 * synthetic fixtures, where tones score clarity 0.94 and come out perfect. Real
 * microphone audio has a median clarity around 0.65 and does not. The gap
 * between "the tests pass" and "the transcription misses notes" was invisible
 * until the user said so in words.
 *
 * So the app asks directly, and captures enough context with the answer to act
 * on it: which stage lost the notes, what settings produced it, and the note
 * list as detected. Without that, "too many missing notes" has several
 * incompatible causes — a detector that never locks on, a filter throwing good
 * frames away, or a segmenter discarding short notes — and guessing between
 * them is how the earlier bugs happened.
 *
 * There is no server. The report is plain text the user copies back, so this
 * module is pure logic over a `Storage`-shaped object rather than anything that
 * touches `window` directly.
 */
import { summariseFunnel, type FunnelStats } from './funnel';
import { midiToPitchClass, midiToOctave } from '../music/notes';
import type { VoiceRangeId } from '../music/voice-range';

export type FeedbackVerdict = 'good' | 'bad';

export const FEEDBACK_ISSUES = [
  { id: 'missing-notes', label: 'Notes are missing' },
  { id: 'extra-notes', label: 'Spurious notes' },
  { id: 'wrong-pitches', label: 'Wrong pitches' },
  { id: 'wrong-rhythm', label: 'Wrong rhythm or timing' },
  { id: 'wrong-key', label: 'Wrong key or spelling' },
  { id: 'unreadable', label: 'Score is unreadable' },
] as const;

export type FeedbackIssue = (typeof FEEDBACK_ISSUES)[number]['id'];

/** How a take was produced. The demo has a known-correct answer, so a bad
 * verdict on it is a real bug report rather than a judgement of the app. */
export type FeedbackSource = 'recording' | 'demo';

export interface FeedbackRecord {
  verdict: FeedbackVerdict;
  issues: FeedbackIssue[];
  /** Free text from the user. This is where the ground truth tends to arrive. */
  comment: string;
  /** ISO timestamp, so reports from several takes can be ordered. */
  at: string;
  source: FeedbackSource;
  durationSeconds: number;
  voiceRange: VoiceRangeId;
  transpose: number;
  keyLabel: string;
  bpm: number;
  /** Note names exactly as detected, in order: "C4", "D#4". */
  notes: string[];
  /**
   * The engraved rhythm as `start:duration` in grid steps, in order. Included
   * because "wrong rhythm or timing" is a distinct complaint from "wrong
   * pitches", and only the grid output can tell them apart.
   */
  rhythm: string[];
  /** Where notes were lost, or null if the worker did not report it. */
  funnel: FunnelStats | null;
}

export interface NoteLike {
  midi: number;
}

/**
 * The parts of an engraved score event a report needs.
 *
 * Structural rather than `ScoreEvent`, so this module stays independent of the
 * engraver: the report should keep working if the score representation changes,
 * and be testable without building a score.
 */
export interface ReportNote {
  type: string;
  midi?: number;
  /** Sixteenth units from the start of the take. */
  start?: number;
  /** Sixteenth units. */
  duration?: number;
}

/** The subset of the Web Storage API used here, so tests need no DOM. */
export interface FeedbackStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const FEEDBACK_STORAGE_KEY = 'recoding.feedback.v1';

/** Keep the history bounded: a full localStorage quota would silently break
 * every subsequent rating, including the copy button. */
export const MAX_FEEDBACK_RECORDS = 20;

/** Note names beyond this are summarised, to keep a paste manageable. */
const MAX_NOTES_IN_REPORT = 120;

/** MIDI number to a readable name, e.g. 60 -> "C4". */
export function noteName(midi: number): string {
  const rounded = Math.round(midi);
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const name = names[midiToPitchClass(rounded)] ?? '?';
  return `${name}${midiToOctave(rounded)}`;
}

export function describeNotes(notes: NoteLike[]): string[] {
  return notes.map((note) => noteName(note.midi));
}

/**
 * Pull the note list and rhythm out of an engraved score.
 *
 * The engraved events are used rather than the raw detection, deliberately: this
 * is what the user actually saw, so a complaint about it should be answered
 * against it. Rests are skipped in the note list but their absence still shows,
 * because a spurious rest and a missing note are the same complaint.
 */
export function describeScoreEvents(events: ReportNote[]): { notes: string[]; rhythm: string[] } {
  const notes: string[] = [];
  const rhythm: string[] = [];
  for (const event of events) {
    if (event.type !== 'note' || typeof event.midi !== 'number') continue;
    notes.push(noteName(event.midi));
    rhythm.push(`${event.start ?? 0}:${event.duration ?? 0}`);
  }
  return { notes, rhythm };
}

/**
 * Read the stored history, tolerating anything unexpected in storage.
 *
 * A corrupt or hand-edited entry must not break the page, so anything that does
 * not parse is discarded rather than thrown.
 */
export function loadFeedback(storage: FeedbackStorage | null): FeedbackRecord[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(FEEDBACK_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFeedbackRecord).slice(-MAX_FEEDBACK_RECORDS);
  } catch {
    return [];
  }
}

function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<FeedbackRecord>;
  return (
    (record.verdict === 'good' || record.verdict === 'bad') &&
    typeof record.comment === 'string' &&
    Array.isArray(record.notes) &&
    Array.isArray(record.rhythm) &&
    Array.isArray(record.issues)
  );
}

/**
 * Append a rating, replacing any earlier rating of the same take.
 *
 * Re-rating happens: you listen, rate it bad, then press play against the
 * original and realise it was fine. Without the replacement the report would
 * contain both, and read as if the app contradicted itself.
 */
export function recordFeedback(
  storage: FeedbackStorage | null,
  record: FeedbackRecord,
): FeedbackRecord[] {
  const existing = loadFeedback(storage).filter(
    (r) => !(r.at === record.at && r.source === record.source && r.durationSeconds === record.durationSeconds),
  );
  const merged = [...existing, record].slice(-MAX_FEEDBACK_RECORDS);
  saveFeedback(storage, merged);
  return merged;
}

export function saveFeedback(storage: FeedbackStorage | null, records: FeedbackRecord[]): void {
  if (!storage) return;
  try {
    storage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Private browsing, or the quota is full. Losing the history is acceptable;
    // failing the rating outright would not be, so the report is still copied.
  }
}

export function clearFeedback(storage: FeedbackStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(FEEDBACK_STORAGE_KEY, '[]');
  } catch {
    // Nothing useful to do; the history simply stays.
  }
}

function wrapNotes(notes: string[], perLine = 16): string[] {
  if (notes.length <= MAX_NOTES_IN_REPORT) {
    const lines: string[] = [];
    for (let i = 0; i < notes.length; i += perLine) lines.push(notes.slice(i, i + perLine).join(' '));
    return lines.length ? lines : ['(none)'];
  }
  const lines: string[] = [];
  const kept = notes.slice(0, MAX_NOTES_IN_REPORT);
  for (let i = 0; i < kept.length; i += perLine) lines.push(kept.slice(i, i + perLine).join(' '));
  lines.push(`... and ${notes.length - MAX_NOTES_IN_REPORT} more`);
  return lines;
}

/**
 * Render the history as plain text to paste back.
 *
 * The opening line is deliberate: the audio itself never leaves the browser, so
 * the single most useful thing the user can do is also the one they may not
 * think of, and a diagnosis is blocked without it.
 */
export function buildFeedbackReport(records: FeedbackRecord[]): string {
  if (records.length === 0) {
    return 'RECODING FEEDBACK\n\n(no ratings yet)';
  }

  const out: string[] = [
    'RECODING FEEDBACK',
    `takes: ${records.length}  (${records.filter((r) => r.verdict === 'good').length} good, ${records.filter((r) => r.verdict === 'bad').length} bad)`,
    '',
    'The recording itself never left the browser. If a take below is rated bad,',
    'press "Download recording" as well and send the audio file — the numbers',
    'below localise the problem, but only the audio can settle it.',
    '',
  ];

  records.forEach((record, index) => {
    const issueLabels = record.issues
      .map((id) => FEEDBACK_ISSUES.find((i) => i.id === id)?.label ?? id)
      .join('; ');

    out.push(`--- take ${index + 1}: ${record.verdict.toUpperCase()} ---`);
    out.push(`when       ${record.at}`);
    out.push(`source     ${record.source}, ${record.durationSeconds.toFixed(1)}s`);
    out.push(`settings   voice=${record.voiceRange} transpose=${record.transpose}`);
    out.push(`result     ${record.keyLabel}, ${record.bpm} bpm, ${record.notes.length} notes`);
    if (record.verdict === 'bad') {
      out.push(`problem    ${issueLabels || '(not specified)'}`);
      if (record.comment) out.push(`comment    ${record.comment}`);
    } else if (record.comment) {
      out.push(`comment    ${record.comment}`);
    }
    if (record.funnel) {
      out.push('funnel');
      for (const line of summariseFunnel(record.funnel).split('\n')) out.push(`  ${line}`);
    } else {
      out.push('funnel     (not captured)');
    }
    out.push('notes');
    for (const line of wrapNotes(record.notes)) out.push(`  ${line}`);
    if (record.rhythm?.length) {
      out.push('rhythm  (grid steps, start:duration)');
      for (const line of wrapNotes(record.rhythm)) out.push(`  ${line}`);
    }
    out.push('');
  });

  return out.join('\n');
}

/** The verdict count, for the summary line under the buttons. */
export function feedbackCounts(records: FeedbackRecord[]): { good: number; bad: number } {
  return {
    good: records.filter((r) => r.verdict === 'good').length,
    bad: records.filter((r) => r.verdict === 'bad').length,
  };
}