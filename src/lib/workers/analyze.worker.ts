import { analyzeTrack, DEFAULT_TRACK_OPTIONS, windowSizeForFloor, type PitchFrame } from '../dsp/frames';
import { smoothTrack, type F0Point } from '../dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS, type DetectedNote } from '../music/segment';
import { detectKey, type KeyDetection } from '../music/key';
import { inferGrid, quantizeNotes } from '../music/quantize';
import { buildScore, type Score } from '../music/score';
import type { Key } from '../music/notes';
import { median, type FunnelStats } from '../diagnostics/funnel';

export interface AnalyzeRequest {
  type: 'analyze';
  /** Mono samples, transferred rather than copied. */
  samples: Float32Array;
  sampleRate: number;
  /** Bounds on the fundamental, so a tenor is not transposed an octave. */
  range?: { minHz: number; maxHz: number };
}

export type AnalyzeResponse =
  | { type: 'progress'; fraction: number }
  | {
      type: 'result';
      score: Score;
      key: Key;
      notes: DetectedNote[];
      confidence: number;
      track: F0Point[];
      /** Pitches as MIDI values, for the input-suitability check. */
      pitches: number[];
      /**
       * How the signal behaved during analysis, independent of the notes found.
       * The absence of gaps between notes is the only evidence that an input had
       * a second source in it, so it has to reach the UI.
       */
      source: { windows: number; tooQuiet: number; detected: number; durationSeconds: number };
      /** Where notes were lost, for diagnosis. */
      funnel: FunnelStats;
    }
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
    const bounds = request.range;
    // The window is derived from the range's floor rather than fixed: a shorter
    // window resolves short notes a long one loses, but a window holding too few
    // periods of a low fundamental detects nothing at all. See
    // `windowSizeForFloor`.
    const windowSize = bounds
      ? windowSizeForFloor(bounds.minHz, sampleRate)
      : DEFAULT_TRACK_OPTIONS.windowSize;

    const frames: PitchFrame[] = analyzeTrack(
      samples,
      {
        ...DEFAULT_TRACK_OPTIONS,
        sampleRate,
        windowSize,
        ...(bounds ? { minHz: bounds.minHz, maxHz: bounds.maxHz } : {}),
      },
      (fraction) => post({ type: 'progress', fraction: fraction * 0.7 }),
    );

    // Derived from the frames, not counted during analysis.
    //
    // These two were declared, never incremented, and reported as 0. Every funnel
    // a user has pasted therefore carried two rows of fiction: "too quiet 0" and
    // "no pitch 0". That was read as evidence — a 33.5s recording with not one
    // silent window looked like continuous multi-source audio — when the real
    // detected count was 2387 of 2868, so 481 windows had found no pitch after
    // all. A plausible story built on a constant that was never wired up.
    //
    // `estimatePitch` returns hz 0 both for a frame below the silence floor and
    // for one that was audible but not periodic, and both cases matter
    // differently, so the two are separated here by the frame's RMS.
    const floor = DEFAULT_TRACK_OPTIONS.rmsFloor;
    const tooQuiet = frames.filter((f) => f.rms < floor).length;
    const noPitchFound = frames.filter((f) => f.rms >= floor && f.hz <= 0).length;

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

    // Reconstruct the funnel from data already in hand. Cheap, and it turns
    // "too many missing notes" into a specific number to fix.
    const frameDuration = hopSize / sampleRate;
    const minNoteMs = DEFAULT_SEGMENT_OPTIONS.minDurationSeconds * 1000;
    const runs: Array<{ start: number; end: number }> = [];
    let runStart = -1;
    for (const point of smoothed) {
      if (point.hz > 0 && runStart < 0) runStart = point.time;
      else if (point.hz <= 0 && runStart >= 0) { runs.push({ start: runStart, end: point.time }); runStart = -1; }
    }
    const tooShort = runs
      .filter((run) => run.end - run.start < DEFAULT_SEGMENT_OPTIONS.minDurationSeconds)
      .map((run) => Math.round((run.end - run.start) * 1000))
      .sort((a, b) => a - b);

    const detectedClarity = frames.filter((f) => f.hz > 0).map((f) => f.clarity);

    const funnel: FunnelStats = {
      windows: frames.length,
      tooQuiet,
      noPitchFound,
      detected: detectedClarity.length,
      droppedClarityFloor: 0,
      droppedClarityRatio: 0,
      afterSmoothing: smoothed.filter((p) => p.hz > 0).length,
      voicedRuns: runs.length,
      runsTooShort: tooShort.length,
      tooShortDurations: tooShort.slice(0, 40),
      notes: notes.length,
      pitches: notes.map((n) => n.midi),
      medianClarity: median(detectedClarity),
      windowMs: windowSize / sampleRate * 1000,
      minNoteMs,
    };

    post(
      {
        type: 'result',
        score,
        key,
        notes,
        confidence,
        track: smoothed,
        pitches: notes.map((n) => n.midi),
        source: {
          windows: frames.length,
          tooQuiet,
          detected: frames.filter((f) => f.hz > 0).length,
          durationSeconds: samples.length / sampleRate,
        },
        funnel,
      },
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
