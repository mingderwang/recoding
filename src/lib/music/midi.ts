import { keySignatureOf } from './notes';
import { UNITS_PER_BEAT, type Score } from './score';

const TICKS_PER_BEAT = 480;

/** Standard MIDI File, format 0, single track. */
export function scoreToMidi(score: Score): Uint8Array {
  const ticksPerUnit = TICKS_PER_BEAT / UNITS_PER_BEAT;
  const events: Array<{ tick: number; order: number; bytes: number[] }> = [];

  const microsecondsPerBeat = Math.round(60_000_000 / Math.max(1, score.grid.bpm));
  events.push({
    tick: 0, order: 0,
    bytes: [
      0xff, 0x51, 0x03,
      (microsecondsPerBeat >> 16) & 0xff,
      (microsecondsPerBeat >> 8) & 0xff,
      microsecondsPerBeat & 0xff,
    ],
  });
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] }); // 4/4
  events.push({ tick: 0, order: 0, bytes: [0xc0, 0x00] }); // acoustic grand
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x59, 0x02, ...keySignatureMeta(score)] });

  for (const event of score.events) {
    if (event.type !== 'note') continue;
    const key = Math.max(0, Math.min(127, Math.round(event.midi)));
    const velocity = Math.max(1, Math.min(127, Math.round(64 + event.confidence * 60)));
    const start = Math.round(event.start * ticksPerUnit);
    const end = Math.round((event.start + event.duration) * ticksPerUnit);
    // Note-on for the attack.
    events.push({ tick: start, order: 1, bytes: [0x90, key, velocity] });
    // Note-on with velocity 0 for the release. This is the form the spec
    // defines and every reader handles; a real 0x80 status byte is legal too,
    // but synthesizers vary in whether they honour it.
    events.push({ tick: end, order: 0, bytes: [0x90, key, 0] });
  }

  // Sort by tick, and at an identical tick put releases before attacks. Two
  // notes of the same pitch that abut share a tick, and a note-on sorted
  // before its own note-off would leave the release attaching to the wrong
  // note — which silently drops a note from the file.
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const body: number[] = [];
  let previousTick = 0;
  for (const event of events) {
    body.push(...variableLength(event.tick - previousTick));
    body.push(...event.bytes);
    previousTick = event.tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00);

  const out: number[] = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, // MThd, length 6
    0, 0, 0, 1, // format 0, one track
    (TICKS_PER_BEAT >> 8) & 0xff, TICKS_PER_BEAT & 0xff,
  ];
  out.push(
    0x4d, 0x54, 0x72, 0x6b,
    (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff, body.length & 0xff,
  );
  out.push(...body);
  return Uint8Array.from(out);
}

/**
 * GM key-signature meta event: one signed byte for sharps (positive) or flats
 * (negative), then a byte where 1 = major and 0 = minor.
 */
function keySignatureMeta(score: Score): number[] {
  const { num, accidental } = keySignatureOf(score.key);
  const signed = accidental === 'b' ? -num : num;
  return [signed & 0xff, score.key.mode === 'major' ? 1 : 0];
}

/** MIDI variable-length quantity. */
export function variableLength(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const stack = [v & 0x7f];
  v = Math.floor(v / 128);
  while (v > 0) {
    stack.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  return stack.reverse();
}

export interface MidiNoteEvent {
  tick: number;
  key: number;
  velocity: number;
  /** Absolute seconds, derived from the tempo in the file. */
  seconds: number;
}

/** Minimal reader, used by the tests to check what `scoreToMidi` produced. */
export function parseMidiNotes(data: Uint8Array): { notes: MidiNoteEvent[]; microsecondsPerBeat: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  const readTag = () => String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
  if (readTag() !== 'MThd') throw new Error('not a MIDI file');
  // Layout: bytes 0-3 tag, 4-7 length, 8-9 format, 10-11 track count,
  // 12-13 division. Read each field from its own offset — advancing a cursor
  // through them reads the length as the format, and the track count as zero.
  const headerLength = view.getUint32(4);
  if (headerLength < 6) throw new Error('bad MIDI header length');
  const trackCount = view.getUint16(10);
  if (trackCount < 1) throw new Error('no tracks');
  // The next chunk starts after the whole header, however long it claims to be.
  pos = 8 + headerLength;

  if (readTag() !== 'MTrk') throw new Error('missing track chunk');
  const trackLength = view.getUint32(pos + 4);
  pos += 8;
  const end = pos + trackLength;

  const notes: MidiNoteEvent[] = [];
  let tick = 0;
  let microsecondsPerBeat = 500000;
  const pending = new Map<number, number>();
  // The status of the last channel message, for running status.
  let runningStatus = 0;

  while (pos < end) {
    let delta = 0;
    for (;;) {
      const byte = data[pos++];
      delta = delta * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    tick += delta;

    // Decide whether a status byte is present, and of what kind.
    //
    // A channel status is 0x80-0xef; 0xff starts a meta event and 0xf0 a sysex
    // event. Everything else is a data byte belonging to a running status, and
    // data bytes can legitimately be >= 0x80, so this cannot be decided from the
    // high bit alone.
    //
    // The full byte must be tested here, not a masked value: 0xff & 0xf0 is
    // 0xf0, so masking a meta status and comparing it to 0xf0 makes the two
    // indistinguishable, and a meta event then gets parsed as sysex.
    const head = data[pos];
    let type: number;
    if (head >= 0x80 && head <= 0xef) {
      type = head & 0xf0;
      pos++;
    } else if (head === 0xff) {
      type = 0xff;
      pos++;
    } else if (head === 0xf0 || head === 0xf7) {
      type = 0xf0;
      pos++;
    } else {
      // No new status byte: this is the continuation of a running status.
      type = runningStatus;
      if (runningStatus === 0) throw new Error('data byte before any status byte');
    }

    if (type === 0xff) {
      const metaType = data[pos++];
      let length = 0;
      for (;;) {
        const byte = data[pos++];
        length = length * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) break;
      }
      if (metaType === 0x51 && length === 3) {
        microsecondsPerBeat = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
      }
      pos += length;
      // A meta event is a complete message, so it ends any running status.
      runningStatus = 0;
    } else if (type === 0x90 || type === 0x80) {
      const key = data[pos++];
      const velocity = data[pos++];
      runningStatus = type;
      if (type === 0x90 && velocity > 0) {
        pending.set(key, tick);
      } else {
        const start = pending.get(key);
        if (start !== undefined) {
          pending.delete(key);
          notes.push({
            tick: start,
            key,
            velocity,
            seconds: (start * microsecondsPerBeat) / (TICKS_PER_BEAT * 1_000_000),
          });
        }
      }
    } else if (type === 0xc0 || type === 0xd0) {
      // Program change and channel pressure carry one data byte. Record the
      // status so a following bare data byte is still attributable, though a
      // program number of 0 is a common and confusing case for readers.
      runningStatus = type;
      pos += 1;
    } else if (type === 0xf0) {
      // System exclusive: a length-prefixed blob we do not interpret. Consume
      // it so it cannot be mistaken for events, and end any running status.
      pos += 1; // the MIDI manufacturer/device byte
      let length = 0;
      for (;;) {
        const byte = data[pos++];
        length = length * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) break;
      }
      pos += length;
      runningStatus = 0;
    } else {
      // Other channel messages (control change, pitch bend): two data bytes.
      runningStatus = type;
      pos += 2;
    }
  }

  notes.sort((a, b) => a.tick - b.tick);
  return { notes, microsecondsPerBeat };
}
