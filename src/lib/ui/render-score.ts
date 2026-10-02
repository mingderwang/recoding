import { SVGContext, Stave, StaveNote, Beam, Accidental, StaveTie, Voice, Formatter, BarlineType } from 'vexflow';
import { keySignatureOf, spell, vexflowKeySpec } from '../music/notes';
import type { Score, ScoreEvent } from '../music/score';

const MEASURE_WIDTH = 190;
const LEFT_GUTTER = 56; // clef + key signature + time signature
const SYSTEM_HEIGHT = 116;

interface Drawn {
  event: Extract<ScoreEvent, { type: 'note' }>;
  note: StaveNote;
}

/** Note value for a duration measured in sixteenth units. */
function durationFor(units: number): string {
  if (units >= 16) return 'w';
  if (units >= 12) return 'hd';
  if (units >= 8) return 'h';
  if (units >= 6) return 'qd';
  if (units >= 4) return 'q';
  if (units >= 3) return '8d';
  if (units >= 2) return '8';
  return '16';
}

export interface RenderOptions {
  /** Wrap to this many measures per system. Defaults to a sensible width. */
  measuresPerSystem?: number;
  width?: number;
}

/**
 * Engrave a score as SVG.
 *
 * The layout is computed by hand rather than through VexFlow's `Score` class.
 * The score model already encodes the bar structure exactly, and doing the
 * system breaking here keeps the output predictable for a single monophonic
 * line, which is all this app produces.
 *
 * VexFlow 5's `Factory` is not used: it requires a target element id up front
 * and manages its own render queue, while this needs to size the canvas from
 * the measure count and draw into a caller-owned container.
 */
export function renderScore(container: HTMLElement, score: Score, options: RenderOptions = {}): SVGSVGElement {
  // How many measures fit on one line. Two is the readable default for a
  // single melodic line; more only when the caller says so.
  const measuresPerSystem = Math.max(1, options.measuresPerSystem ?? 2);
  const systems: Score['measures'][] = [];
  for (let i = 0; i < score.measures.length; i += measuresPerSystem) {
    systems.push(score.measures.slice(i, i + measuresPerSystem));
  }
  if (systems.length === 0) systems.push([]);

  // Width is driven by the widest system, so a short final line does not make
  // the whole page jump when the measures-per-line count changes.
  const widestSystem = Math.max(1, ...systems.map((system) => system.length));
  const width = options.width ?? LEFT_GUTTER + widestSystem * MEASURE_WIDTH + 24;
  const height = systems.length * SYSTEM_HEIGHT + 16;

  // VexFlow appends its own <svg> to the container, so anything already there
  // (a previous rendering, an error message) has to go or it stacks up.
  container.innerHTML = '';

  const context = new SVGContext(container);
  // The constructor only takes the element; size the canvas explicitly after.
  context.resize(width, height);
  const svg = context.svg;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'score-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Engraved score');

  const keySpec = vexflowKeySpec(score.key);
  const signature = keySignatureOf(score.key);
  const clef = clefForScore(score);
  const availableWidth = width - LEFT_GUTTER - 24;

  systems.forEach((system, systemIndex) => {
    const top = 24 + systemIndex * SYSTEM_HEIGHT;
    if (system.length === 0) return;

    // Each measure on the system gets its own slice of the width. Previously
    // every measure was drawn at the same x with the full width, so all but
    // the first were painted directly on top of it.
    system.forEach((measure, indexInSystem) => {
      const measureWidth = availableWidth / system.length;
      drawMeasure(context, score, measure, {
        x: LEFT_GUTTER + indexInSystem * measureWidth,
        y: top,
        width: measureWidth,
        clef,
        keySpec,
        signature,
        // Clef, key and time go on the first measure of the first system only;
        // the rest of that system continues, and later systems are assumed to
        // be a continuation of the same piece.
        showClefAndKey: indexInSystem === 0,
        showTimeSignature: indexInSystem === 0 && systemIndex === 0,
        // A barline between measures, but not at the start of a system.
        startBarline: indexInSystem > 0,
      });
    });
  });

  return svg;
}

interface MeasureLayout {
  x: number;
  y: number;
  width: number;
  clef: 'treble' | 'bass';
  keySpec: string;
  signature: { accidental: '#' | 'b' | null; num: number };
  /** Clef and key signature — first measure of each system. */
  showClefAndKey: boolean;
  /** Time signature — very first measure of the piece only. */
  showTimeSignature: boolean;
  /** Draw a barline at the start of this measure. */
  startBarline: boolean;
}

function drawMeasure(context: SVGContext, score: Score, measure: Score['measures'][number], layout: MeasureLayout): void {
  const stave = new Stave(layout.x, layout.y, layout.width);
  if (layout.showClefAndKey) {
    stave.addClef(layout.clef);
    if (layout.signature.num > 0) stave.addKeySignature(layout.keySpec);
  }
  if (layout.showTimeSignature) stave.addTimeSignature('4/4');
  if (layout.startBarline) stave.setBegBarType(BarlineType.SINGLE);
  stave.setContext(context).draw();

  const events = score.events.filter(
    (event) => event.start >= measure.start && event.start < measure.start + measure.units,
  );
  if (events.length === 0) return;

  const drawn: Drawn[] = [];
  for (const event of events) {
    const note = buildNote(event, score);
    if (!note) continue;
    note.setStave(stave);
    drawn.push({ event: event as Extract<ScoreEvent, { type: 'note' }>, note });
  }
  if (drawn.length === 0) return;

  // Notes must be formatted before they are drawn. VexFlow lays them out
  // through a Voice plus Formatter, which creates the TickContext that
  // getAbsoluteX() needs; drawing a StaveNote directly throws NoTickContext.
  // VexFlow 5 spells these camelCase. Passing the old snake_case names is
  // silently ignored, which leaves the voice with an undefined time signature
  // and the notes laid out at the wrong spacing.
  const voice = new Voice({ numBeats: 4, beatValue: 4 }).setStrict(false);
  voice.addTickables(drawn.map((d) => d.note));
  new Formatter().joinVoices([voice]).format([voice], stave.getNoteStartX() + 8);
  voice.draw(context, stave);

  // Beam short notes so a run of eighths is not a hedge of separate flags.
  for (const group of beamable(drawn)) {
    try {
      new Beam(group.map((d) => d.note)).setContext(context).draw();
    } catch {
      // VexFlow refuses some combinations; unbeamed notes are still correct.
    }
  }

  // Ties are drawn between the two halves of a note split across a barline.
  for (let i = 0; i < drawn.length - 1; i++) {
    if (drawn[i].event.tie && drawn[i].event.midi === drawn[i + 1].event.midi) {
      new StaveTie({ firstNote: drawn[i].note, lastNote: drawn[i + 1].note })
        .setContext(context)
        .draw();
    }
  }
}

function buildNote(event: ScoreEvent, score: Score): StaveNote | null {
  // VexFlow keys are like 'c/4' for C in octave 4. MIDI 60 is C4.
  const duration = durationFor(event.duration);
  if (event.type === 'rest') {
    // A rest needs a key that sits inside the staff; b/4 is the convention.
    return new StaveNote({ keys: ['b/4'], duration: `${duration}r`, alignCenter: true });
  }

  // VexFlow keys look like 'c/4' — the letter comes from the key's own spelling
  // so the printed accidental matches the key signature, and the octave is the
  // scientific one, where middle C (MIDI 60) is octave 4.
  const spelled = spell(event.midi, score.key);
  const note = new StaveNote({
    keys: [`${spelled.letter.toLowerCase()}/${octaveFor(event.midi)}`],
    duration,
    autoStem: true,
  });

  if (spelled.accidentalKey !== 'n') {
    note.addModifier(new Accidental(spelled.accidentalKey), 0);
  }
  return note;
}

/** Scientific octave number, so MIDI 60 is octave 4. */
function octaveFor(midi: number): number {
  return Math.floor(midi / 12) - 1;
}

function clefForScore(score: Score): 'treble' | 'bass' {
  const notes = score.events.filter((e): e is Extract<ScoreEvent, { type: 'note' }> => e.type === 'note');
  if (notes.length === 0) return 'treble';
  const average = notes.reduce((sum, note) => sum + note.midi, 0) / notes.length;
  return average < 55 ? 'bass' : 'treble';
}

function beamable(drawn: Drawn[]): Drawn[][] {
  const groups: Drawn[][] = [];
  let current: Drawn[] = [];
  const short = (d: Drawn) => d.event.duration <= 2;
  for (const item of drawn) {
    if (short(item)) {
      current.push(item);
    } else {
      if (current.length > 1) groups.push(current);
      current = [];
    }
  }
  if (current.length > 1) groups.push(current);
  return groups;
}
