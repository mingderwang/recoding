/**
 * Runs a real recording through the analysis pipeline and writes a MIDI file.
 *
 * Usage: bun src/tests/transcribe-file.ts <audio-path> [out.mid]
 *
 * Accepts WAV. For m4a/mp3, convert first, e.g.
 *   ffmpeg -i input.m4a -ac 1 -ar 44100 -f wav input.wav
 */
import { basename, extname } from 'node:path';
import { analyzeTrack, DEFAULT_TRACK_OPTIONS } from '../lib/dsp/frames';
import { smoothTrack, midiToHz, hzToMidi } from '../lib/dsp/smooth';
import { segmentNotes, DEFAULT_SEGMENT_OPTIONS } from '../lib/music/segment';
import { detectKey } from '../lib/music/key';
import { inferGrid, quantizeNotes } from '../lib/music/quantize';
import { buildScore } from '../lib/music/score';
import { scoreToMidi, parseMidiNotes } from '../lib/music/midi';
import { keyLabel, spell, midiToOctave, LETTER_NAMES } from '../lib/music/notes';
import { readWavMono } from './lib/read-wav';

const input = process.argv[2];
if (!input) {
  console.error('usage: bun transcribe-file.ts <audio.wav> [out.mid]');
  process.exit(1);
}
const output = process.argv[3] ?? `out/${basename(input, extname(input))}.mid`;

const { samples, sampleRate } = readWavMono(input);
const duration = samples.length / sampleRate;

let peak = 0;
let sumSquares = 0;
for (const value of samples) {
  const magnitude = Math.abs(value);
  if (magnitude > peak) peak = magnitude;
  sumSquares += value * value;
}
const rms = Math.sqrt(sumSquares / samples.length);

console.log('INPUT');
console.log(`  file      ${input}`);
console.log(`  duration  ${duration.toFixed(2)}s @ ${sampleRate}Hz`);
console.log(`  peak      ${peak.toFixed(4)}   rms ${rms.toFixed(4)}`);

console.log('\nPITCH TRACK');
const t0 = performance.now();
const frames = analyzeTrack(samples, { ...DEFAULT_TRACK_OPTIONS, sampleRate });
const detectMs = performance.now() - t0;
const voiced = frames.filter((f) => f.hz > 0);
console.log(`  windows   ${frames.length} (${detectMs.toFixed(0)}ms)`);
console.log(`  voiced    ${voiced.length} (${((voiced.length / frames.length) * 100).toFixed(1)}%)`);

if (voiced.length > 0) {
  const pitches = voiced.map((f) => hzToMidi(f.hz));
  console.log(`  range     ${Math.min(...pitches).toFixed(1)}–${Math.max(...pitches).toFixed(1)} semitones`);
  console.log(
    `  centre    ${(69 + 12 * Math.log2(voiced.reduce((s, f) => s + f.hz, 0) / voiced.length)).toFixed(1)} MIDI`,
  );
  const clarities = voiced.map((f) => f.clarity).sort((a, b) => a - b);
  console.log(`  clarity   median ${clarities[clarities.length >> 1].toFixed(2)}`);
}

const track = frames.map((f) => ({ time: f.time, hz: f.hz, voiced: f.hz > 0 ? 1 : 0 }));
const smoothed = smoothTrack(track);
const notes = segmentNotes(smoothed, {
  ...DEFAULT_SEGMENT_OPTIONS,
  frameDuration: DEFAULT_TRACK_OPTIONS.hopSize / sampleRate,
});

console.log('\nSEGMENTED NOTES');
if (notes.length === 0) {
  console.log('  (none)');
} else {
  for (const [i, n] of notes.entries()) {
    const name = `${LETTER_NAMES[((Math.round(n.midi) % 12) + 12) % 12]}${midiToOctave(Math.round(n.midi))}`;
    console.log(
      `  ${String(i).padStart(2)}  ${n.start.toFixed(3)}s  ${(n.end - n.start).toFixed(3)}s  ` +
        `${name.padEnd(4)} midi ${n.midi.toFixed(2).padStart(6)}  conf ${n.confidence.toFixed(2)}`,
    );
  }
  const gaps = notes.slice(1).map((n, i) => n.start - notes[i].end);
  const onsets = notes.slice(1).map((n, i) => n.start - notes[i].start);
  const fmt = (v: number[]) => v.map((x) => x.toFixed(3)).join(' ');
  console.log(`  onsets    ${fmt(onsets)}`);
  console.log(`  gaps      ${fmt(gaps)}`);
}

const detection = detectKey(notes.map((n) => ({ midi: n.midi, duration: n.end - n.start })));
console.log('\nKEY');
if (detection) {
  console.log(`  best      ${keyLabel(detection.key)}  (r=${detection.score.toFixed(3)})`);
  console.log(`  next      ${keyLabel(detection.alternative)}  (r=${detection.alternativeScore.toFixed(3)})`);
}

const grid = inferGrid(notes);
console.log('\nRHYTHM GRID');
console.log(`  bpm       ${grid.bpm}`);
console.log(`  step      ${grid.beatsPerStep} beat(s) = ${grid.secondsPerStep.toFixed(4)}s`);
console.log(`  measure   ${grid.beatsPerMeasure} beats = ${grid.stepsPerMeasure} steps`);

const quantized = quantizeNotes(notes, grid);
const score = buildScore(quantized, grid, detection?.key ?? { tonic: 0, mode: 'major' });

console.log('\nSCORE');
const pitched = score.events.filter((e) => e.type === 'note');
const rests = score.events.filter((e) => e.type === 'rest');
console.log(`  measures  ${score.measures.length}  (${score.totalUnits} sixteenths)`);
console.log(`  notes     ${pitched.length}   rests ${rests.length}`);
for (const event of score.events) {
  if (event.type === 'rest') {
    console.log(`    rest  start=${String(event.start).padStart(3)} dur=${event.duration}`);
  } else {
    const s = spell(event.midi, score.key);
    const name = `${s.letter}${s.alter > 0 ? '♯' : s.alter < 0 ? '♭' : ''}${midiToOctave(event.midi)}`;
    console.log(
      `    note  start=${String(event.start).padStart(3)} dur=${String(event.duration).padStart(2)} ` +
        `${name.padEnd(4)} midi ${String(event.midi).padStart(3)}${event.tie ? '  (tied)' : ''}`,
    );
  }
}

const bytes = scoreToMidi(score);
const { notes: parsed, microsecondsPerBeat } = parseMidiNotes(bytes);
console.log('\nMIDI ROUND TRIP');
console.log(`  bytes     ${bytes.length}`);
console.log(`  tempo     ${Math.round(60_000_000 / microsecondsPerBeat)} bpm`);
console.log(`  notes     ${parsed.length} (score had ${pitched.length})`);
if (parsed.length !== pitched.length) {
  console.log('  !! note count mismatch — the file does not round-trip');
}
const mismatches = parsed
  .map((n, i) => ({ i, file: n.key, score: pitched[i]?.midi }))
  .filter((m) => m.file !== m.score);
console.log(`  pitches   ${mismatches.length === 0 ? 'all match' : `${mismatches.length} MISMATCH`}`);
for (const m of mismatches.slice(0, 8)) {
  console.log(`    [${m.i}] file ${m.file} vs score ${m.score}`);
}

const out = Bun.write(output, bytes);
console.log(`\nWROTE ${output} (${out} bytes)`);
void midiToHz;
