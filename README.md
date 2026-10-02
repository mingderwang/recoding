# Recoding

Record a melody, get the sheet music back.

Everything runs in the browser tab. Audio is never uploaded — there is no
backend, no API key, and no server-side processing.

## Running it

```sh
bun install
bun run dev        # http://localhost:4321
```

The microphone needs a secure context, which means HTTPS or `localhost`. On any
other host the page will refuse to record and say so.

```sh
bun test           # 44 tests, including real engraved output
bun run check      # typecheck app + tests
bun run build      # static output into dist/
```

## How it works

```
mic ──► MediaRecorder ──► Blob ──► decodeAudioData ──► mono Float32
                                            │
                                            ▼
                              analyze.worker.ts  (off the main thread)
                              ├─ dsp/mpm         McLeod pitch detection
                              ├─ dsp/frames      framing + silence gate
                              ├─ dsp/smooth      median filter, octave repair
                              ├─ music/segment   voiced runs → note events
                              ├─ music/key       Krumhansl-Schmuckler key finding
                              ├─ music/quantize  rhythmic grid + tempo search
                              └─ music/score     bars, rests, ties
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
             ui/render-score          music/midi          audio/score-player
             (VexFlow 5 → SVG)        (SMF format 0)      (Web Audio synth)
```

### Playback

There are two distinct play buttons, and the distinction matters:

- **Play recording** — your original audio, straight from the blob.
- **Play transcription** — the app's own claim about what you sang,
  synthesised from the score model. Hearing it next to the original is the
  only real way to tell whether the transcription is right, which is why it is
  a separate control rather than a toggle on the same one.

The synth plays the score directly rather than decoding the exported MIDI, so
what you hear is exactly what the score says, ties and rests included. The tone
is a plain decaying sine with two quiet harmonics and a low-pass: deliberately
obviously synthetic, because a realistic instrument tone would imply a fidelity
the transcription does not have. There is a transpose control, since a
transcription can land an octave or two from where you sang and it is useful to
hear it at the pitch you intended.

Analysis runs offline over the decoded buffer rather than live during
recording. Real-time per-frame analysis drops frames under load and cannot be
re-tuned after the fact; the live view is only a level meter and a pitch
readout.

### Pitch detection

McLeod Pitch Method (Schloss 1986) rather than plain autocorrelation. A
human voice has a strong second harmonic, which makes the true period look
like a multiple of itself and drags plain autocorrelation an octave down. MPM's
normalised square difference function plus the "take the *first* qualifying
peak" rule avoids that.

Measured worst-case error across 82–880 Hz is ~12 cents at the 4096-sample
window, ~28 cents at 2048. The residual comes from a window that does not hold
an integer number of 2f cycles; Hann and Hamming windowing were both measured
and made it worse (24–30 cents), so the window stays rectangular.

### Rhythm

The tempo is inferred, not measured. The search covers (tempo × grid
resolution) and scores each candidate on:

- **alignment** — distance in *seconds* the onsets must move onto the grid,
  weighted by note length. Absolute time matters: a fraction-of-a-step measure
  is scale-free, so a grid far too fine always looks near-perfect and a
  metronomic 0.5 s beat is "explained" by a 0.166 s grid to within 3 ms.
- **metrical level** — preference for one note per beat. One physical grid can
  be notated at several tempi (a 0.5 s beat is half notes at 60, quarters at
  120, eighths at 240), and only one of those is a sensible transcription.
- **tempo prior** — a narrow prior around 108 bpm, small enough to break ties
  rather than over-ride evidence.

## Known limits

- **Monophonic only.** One pitch at a time. Chords will not transcribe, and two
  people singing at once is a mess. This is a deliberate design choice, not a
  limitation to work around later — multi-pitch detection is a different and
  much less reliable problem.
- **The tempo is a guess.** Check it against how you were actually singing.
- **Vibrato can split a note in two.** Very wide vibrato reads as a pitch
  change, and one note becomes two.
- **Pitched percussion and breathy tones are unreliable.** The detector wants a
  clear, sustained fundamental.
- Short notes are detected with jitter of ±25%, because an analysis window is
  longer than a sixteenth note. `segmentNotes` snaps boundaries to the median
  onset spacing to compensate, but very fast runs may still come out uneven.

### Guitar does not work, and the reason is structural

Tested against a real recording of a plucked low E (`sample.m4a`). The
transcription is wrong, and it is worth being precise about why rather than
blaming the peak picker.

Measured partial magnitudes at t=2.6s:

| partial | frequency | magnitude |
|---------|-----------|-----------|
| h1 | 82.4 Hz | 9.1 |
| h3 | 247.2 Hz | 37.3 |
| h6 | 494.4 Hz | **92.7** |
| h9 | 741.7 Hz | 19.3 |
| h10 | 824.1 Hz | 36.5 |

The fundamental sits at ~10% of the strongest partial and **is not a local
spectral peak** (its neighbours measure 1.5 and 8.1). A windowed FFT of usable
length cannot see it at all.

Four spectral approaches were implemented and measured on this file. All landed
on a harmonic:

| method | result at t=2.6s |
|--------|------------------|
| tallest spectral peak | 495 Hz (h6) |
| sub-harmonic summation | 248 Hz (h3) |
| harmonic product spectrum | 75 Hz (nearest, but pinned) |
| normalised harmonic-series scoring | 246 Hz |

The ambiguity is structural rather than a scoring failure: if the signal is
periodic at `tau`, it also correlates at `2*tau` and `3*tau`, so *every* divisor
of the true period has a full harmonic series present. No scoring function over
this spectrum can separate them without extra assumptions.

Phase-vocoder refinement of an already-chosen peak *does* work well (246.24 Hz,
sub-cent precision) but can only refine a choice, not make it.

The app targets a solo singing voice, where the fundamental is the strongest
partial and this ambiguity does not arise. Supporting guitar properly needs a
fundamental-candidate model or true multi-pitch detection — a substantially
larger piece of work than a better peak rule, and not something to bolt on.

`src/tests/recording.test.ts` carries the three failing assertions as `todo`
tests so the limitation stays visible in the test output.

## Notes on the tests

The engraving tests run VexFlow against a real DOM (jsdom) and assert on the
emitted SVG, because rendering is the part a user notices first and the one
pure functions cannot check. The MIDI tests parse back what the writer produced
rather than trusting the byte layout, which is how a duplicate-`xmlns` export
bug and a MIDI header offset error were both caught.
