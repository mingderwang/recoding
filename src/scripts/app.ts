/**
 * Page controller. Deliberately framework-free: the app is a small state
 * machine (idle -> recording -> analysing -> done) and a reconciler would be
 * more code than the UI it managed.
 */
import { Recorder, MicrophoneError, decodeToMono, type RecorderHandle } from '../lib/audio/recorder';
import { synthesizeDemoMelody } from '../lib/audio/demo-melody';
import { renderScore } from '../lib/ui/render-score';
import { downloadBlob, downloadPng, downloadSvg } from '../lib/ui/export-image';
import { scoreToMidi } from '../lib/music/midi';
import { ScorePlayer } from '../lib/audio/score-player';
import { keyLabel, midiToPitchClass } from '../lib/music/notes';
import type { Score } from '../lib/music/score';
import type { AnalyzeResponse } from '../lib/workers/analyze.worker';

const SAMPLE_RATE = 44100;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const ui = {
  record: el<HTMLButtonElement>('record'),
  stop: el<HTMLButtonElement>('stop'),
  demo: el<HTMLButtonElement>('demo'),
  status: el<HTMLParagraphElement>('status'),
  level: el<HTMLDivElement>('level'),
  levelFill: el<HTMLDivElement>('level-fill'),
  pitch: el<HTMLDivElement>('pitch-readout'),
  pitchLabel: el<HTMLDivElement>('pitch-label'),
  timer: el<HTMLDivElement>('timer'),
  progress: el<HTMLDivElement>('progress'),
  progressFill: el<HTMLDivElement>('progress-fill'),
  results: el<HTMLElement>('results'),
  summary: el<HTMLDivElement>('summary'),
  scoreHost: el<HTMLDivElement>('score-host'),
  play: el<HTMLButtonElement>('play'),
  playheadLabel: el<HTMLSpanElement>('playhead-label'),
  playScore: el<HTMLButtonElement>('play-score'),
  transpose: el<HTMLSelectElement>('transpose'),
  downloadMidi: el<HTMLButtonElement>('download-midi'),
  downloadSvg: el<HTMLButtonElement>('download-svg'),
  downloadPng: el<HTMLButtonElement>('download-png'),
  restart: el<HTMLButtonElement>('restart'),
};

let recorder: Recorder | null = null;
let handle: RecorderHandle | null = null;
let audio: HTMLAudioElement | null = null;
let currentScore: Score | null = null;
let currentSvg: SVGSVGElement | null = null;
let timerHandle = 0;
let state: 'idle' | 'recording' | 'analysing' | 'done' = 'idle';

const player = new ScorePlayer();

function setState(next: typeof state): void {
  state = next;
  ui.record.hidden = next !== 'idle';
  ui.demo.disabled = next === 'recording' || next === 'analysing';
  ui.stop.hidden = next !== 'recording';
  // "Record again" lives beside the demo button now, so it only makes sense
  // once there is something to record again over.
  ui.restart.hidden = next !== 'done';
  ui.results.hidden = next !== 'done';
  ui.progress.hidden = next !== 'analysing';
  ui.status.hidden = next === 'done';
}

function say(message: string, tone: 'info' | 'error' = 'info'): void {
  ui.status.textContent = message;
  ui.status.dataset.tone = tone;
  ui.status.hidden = false;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

function describePitch(hz: number): void {
  if (hz <= 0) {
    ui.pitch.textContent = '—';
    ui.pitchLabel.textContent = 'listening';
    return;
  }
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NOTE_NAMES[midiToPitchClass(midi)];
  const octave = Math.floor(midi / 12) - 1;
  ui.pitch.textContent = `${name}${octave}`;
  ui.pitchLabel.textContent = `${hz.toFixed(1)} Hz`;
}

// ---------------------------------------------------------------- recording

ui.record.addEventListener('click', async () => {
  setState('recording');
  ui.pitch.textContent = '—';
  ui.timer.textContent = '0.0s';
  say('Recording. Sing or play one line, then press stop.');

  recorder = new Recorder({
    onLevel: (level) => {
      ui.levelFill.style.transform = `scaleX(${level.toFixed(3)})`;
      ui.level.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    },
    onPitch: describePitch,
  });

  try {
    await recorder.start();
  } catch (error) {
    setState('idle');
    if (error instanceof MicrophoneError) say(error.message, 'error');
    else say(`Could not start recording: ${(error as Error).message}`, 'error');
    return;
  }

  const startedAt = performance.now();
  timerHandle = window.setInterval(() => {
    ui.timer.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
  }, 100);
});

ui.stop.addEventListener('click', () => void finishRecording());

async function finishRecording(): Promise<void> {
  if (!recorder) return;
  clearInterval(timerHandle);
  const result = await recorder.stop();
  recorder = null;
  ui.levelFill.style.transform = 'scaleX(0)';
  describePitch(0);
  await handleResult(result);
}

/** A synthesized melody, so the output can be seen before granting mic access. */
ui.demo.addEventListener('click', async () => {
  setState('analysing');
  say('Playing a demo melody through the same pipeline…');
  const samples = await synthesizeDemoMelody(SAMPLE_RATE);
  const blob = await encodeWav(samples, SAMPLE_RATE);
  await handleResult({ blob, duration: samples.length / SAMPLE_RATE });
});

// ------------------------------------------------------------------ analysis

async function handleResult(result: RecorderHandle): Promise<void> {
  handle = result;
  setState('analysing');
  ui.progressFill.style.transform = 'scaleX(0)';
  say('Listening for the notes…');

  let samples: Float32Array;
  try {
    samples = await decodeToMono(result.blob, SAMPLE_RATE);
  } catch (error) {
    setState('idle');
    say(`Could not read that audio: ${(error as Error).message}`, 'error');
    return;
  }

  if (samples.length / SAMPLE_RATE < 0.4) {
    setState('idle');
    say('That was too short to read. Try a second or two.', 'error');
    return;
  }

  try {
    const result_ = await runAnalysis(samples);
    if (!result_) return; // the worker already reported the failure
    showScore(result_.score, result_.key, result_.confidence);
  } catch (error) {
    setState('idle');
    say(`Analysis failed: ${(error as Error).message}`, 'error');
  }
}

function runAnalysis(samples: Float32Array) {
  return new Promise<Extract<AnalyzeResponse, { type: 'result' }> | null>((resolve, reject) => {
    const worker = new Worker(new URL('../lib/workers/analyze.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        ui.progressFill.style.transform = `scaleX(${message.fraction.toFixed(3)})`;
        return;
      }
      worker.terminate();
      if (message.type === 'error') {
        setState('idle');
        say(message.message, 'error');
        resolve(null);
        return;
      }
      resolve(message);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'the analysis worker crashed'));
    };

    worker.postMessage({ type: 'analyze', samples, sampleRate: SAMPLE_RATE }, [samples.buffer]);
  });
}

// ------------------------------------------------------------------- results

function showScore(
  score: Score,
  key: { tonic: number; mode: 'major' | 'minor' },
  confidence: number,
): void {
  // A fresh result replaces the old one, so anything still sounding must stop.
  player.stop();
  ui.playScore.textContent = 'Play transcription';
  ui.playScore.dataset.playing = 'false';
  ui.playheadLabel.textContent = '';

  currentScore = score;
  setState('done');

  const noteCount = score.events.filter((e) => e.type === 'note').length;
  const measureCount = score.measures.length;
  const honesty =
    confidence > 0.75
      ? 'The pitches look reliable.'
      : confidence > 0.45
        ? 'Some notes may be off — vibrato and scoops cause this.'
        : 'This came out uncertain. Try a slower, more even delivery.';

  ui.summary.innerHTML = `
    <dl class="facts">
      <div><dt>Key</dt><dd>${escapeHtml(keyLabel(key))}</dd></div>
      <div><dt>Tempo</dt><dd>${score.grid.bpm} bpm</dd></div>
      <div><dt>Notes</dt><dd>${noteCount}</dd></div>
      <div><dt>Bars</dt><dd>${measureCount}</dd></div>
    </dl>
    <p class="confidence">${escapeHtml(honesty)}</p>
  `;

  try {
    currentSvg = renderScore(ui.scoreHost, score, { width: 760 });
  } catch (error) {
    ui.scoreHost.innerHTML = `<p class="status" data-tone="error">Could not draw the score: ${escapeHtml((error as Error).message)}</p>`;
  }
}

ui.play.addEventListener('click', () => {
  if (!handle) return;
  if (!audio) {
    audio = new Audio(URL.createObjectURL(handle.blob));
    audio.addEventListener('timeupdate', () => {
      ui.playheadLabel.textContent = `${audio!.currentTime.toFixed(1)}s / ${handle!.duration.toFixed(1)}s`;
    });
    audio.addEventListener('ended', () => {
      ui.playheadLabel.textContent = '';
    });
  }
  if (audio.paused) {
    void audio.play();
    ui.play.textContent = 'Stop playback';
  } else {
    audio.pause();
    ui.play.textContent = 'Play recording';
  }
});

// Play back the TRANSCRIPTION, which is a different thing from playing back the
// recording: this is the app's own claim about what you sang, so hearing it next
// to the original is the only way to tell whether the transcription is right.
ui.playScore.addEventListener('click', async () => {
  if (!currentScore) return;
  if (player.isPlaying) {
    player.stop();
    return;
  }
  const transpose = Number(ui.transpose.value) || 0;
  try {
    await player.play(currentScore, {
      transpose,
      onProgress: (seconds) => {
        ui.playheadLabel.textContent = `${seconds.toFixed(1)}s / ${player.length.toFixed(1)}s`;
      },
      onEnd: () => {
        ui.playScore.textContent = 'Play transcription';
        ui.playScore.dataset.playing = 'false';
        ui.playheadLabel.textContent = '';
      },
    });
    ui.playScore.textContent = 'Stop';
    ui.playScore.dataset.playing = 'true';
  } catch (error) {
    say(`Could not play the transcription: ${(error as Error).message}`, 'error');
  }
});

ui.transpose.addEventListener('change', () => {
  // Replay from the top with the new transposition rather than leaving a
  // half-finished render playing at the old pitch.
  if (player.isPlaying) {
    player.stop();
    void player.play(currentScore!, { transpose: Number(ui.transpose.value) || 0 });
  }
});

ui.downloadMidi.addEventListener('click', () => {
  if (!currentScore) return;
  const bytes = scoreToMidi(currentScore);
  downloadBlob(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/midi' }), 'recoding.mid');
});

ui.downloadSvg.addEventListener('click', () => {
  if (currentSvg) downloadSvg(currentSvg, 'recoding.svg');
});

ui.downloadPng.addEventListener('click', async () => {
  if (!currentSvg) return;
  ui.downloadPng.disabled = true;
  try {
    await downloadPng(currentSvg, 'recoding.png');
  } catch (error) {
    say(`Could not export a PNG: ${(error as Error).message}`, 'error');
  } finally {
    ui.downloadPng.disabled = false;
  }
});

ui.restart.addEventListener('click', () => {
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  // Stop the synthesised playback too, or it keeps sounding over the next take
  // and its playhead label fights the recording's.
  player.stop();
  ui.playScore.textContent = 'Play transcription';
  ui.playScore.dataset.playing = 'false';
  ui.playheadLabel.textContent = '';
  ui.summary.innerHTML = '';
  ui.scoreHost.innerHTML = '';
  currentScore = null;
  currentSvg = null;
  setState('idle');
  say('Ready when you are.');
});

// -------------------------------------------------------------------- helpers

/** Minimal 16-bit PCM WAV wrapper, so the demo plays back in the browser. */
async function encodeWav(samples: Float32Array, sampleRate: number): Promise<Blob> {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

setState('idle');
