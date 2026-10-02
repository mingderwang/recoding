import { analyzeTrack, DEFAULT_TRACK_OPTIONS, type PitchFrame } from '../dsp/frames';
import { smoothTrack, type F0Point } from '../dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS, type DetectedNote } from '../music/segment';
import { detectKey, type KeyDetection } from '../music/key';
import { inferGrid, quantizeNotes } from '../music/quantize';
import { buildScore, type Score } from '../music/score';
import type { Key } from '../music/notes';

export interface AnalyzeRequest {
  type: 'analyze';
  /** Mono samples, transferred rather than copied. */
  samples: Float32Array;
  sampleRate: number;
}

export type AnalyzeResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'result'; score: Score; key: Key; notes: DetectedNote[]; confidence: number; track: F0Point[] }
  | { type: 'error'; message: string };

/**
 * Runs the full analysis chain on a worker thread.
 *
 * The transfer of `samples` matters: a ten-second recording is 1.7MB, and
 * structured-cloning that to the worker would stall the UI for the duration.
 */
self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const request = event.data;
  if (request.type !== 'analyze') return;

  try {
    const { samples, sampleRate } = request;
    const post = (message: AnalyzeResponse, transfer?: Transferable[]) =>
      (self as unknown as Worker).postMessage(message, transfer ?? []);

    const hopSize = DEFAULT_TRACK_OPTIONS.hopSize;

    const frames: PitchFrame[] = analyzeTrack(
      samples,
      { ...DEFAULT_TRACK_OPTIONS, sampleRate },
      (fraction) => post({ type: 'progress', fraction: fraction * 0.7 }),
    );

    const track: F0Point[] = frames.map((frame) => ({
      time: frame.time,
      hz: frame.hz,
      voiced: frame.hz > 0 ? 1 : 0,
      // Carried through so the octave corrector can tell a low-confidence
      // window-straddling artefact from a real note.
      clarity: frame.clarity,
    }));
    const smoothed = smoothTrack(track);

    const notes = segmentNotes(smoothed, {
      ...DEFAULT_SEGMENT_OPTIONS,
      frameDuration: hopSize / sampleRate,
    });
    post({ type: 'progress', fraction: 0.78 });

    if (notes.length === 0) {
      post({
        type: 'error',
        message: 'No clear pitch was detected. Try singing or playing one note at a time, closer to the microphone.',
      });
      return;
    }

    const weighted = notes.map((note) => ({ midi: note.midi, duration: note.end - note.start }));
    const detection: KeyDetection | null = detectKey(weighted);
    const key: Key = detection?.key ?? { tonic: 0, mode: 'major' };

    const grid = inferGrid(notes);
    post({ type: 'progress', fraction: 0.88 });

    const quantized = quantizeNotes(notes, grid);
    const score = buildScore(quantized, grid, key);
    post({ type: 'progress', fraction: 0.96 });

    // A rough overall confidence: the mean per-note confidence, tempered by how
    // many notes survived. Few notes is not necessarily bad (a two-note phrase
    // is a fine answer), so this is a hint for the UI, not a verdict.
    const meanConfidence = notes.reduce((sum, n) => sum + n.confidence, 0) / notes.length;
    const confidence = Math.max(0, Math.min(1, meanConfidence * Math.min(1, notes.length / 4)));

    post(
      { type: 'result', score, key, notes, confidence, track: smoothed },
      // Hand the pitch track back for the waveform overlay; the copy is small
      // relative to the audio, and it lets the UI avoid re-running detection.
      [],
    );
  } catch (error) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      message: `Analysis failed: ${(error as Error).message}`,
    } satisfies AnalyzeResponse);
  }
};
