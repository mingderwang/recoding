/**
 * Reads a WAV file into a mono Float32Array.
 *
 * The app decodes audio with the Web Audio API, which is not available under
 * `bun test`. For running a real recording through the pipeline offline, a
 * minimal RIFF reader avoids pulling in a decoder dependency and keeps the
 * production code path unchanged.
 */
import { readFileSync } from 'node:fs';

export function readWavMono(path: string): { samples: Float32Array; sampleRate: number } {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const tag = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }

  let pos = 12;
  let format = 0;
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLength = 0;

  while (pos + 8 <= bytes.length) {
    const chunk = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;

    if (chunk === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunk === 'data') {
      dataStart = body;
      dataLength = size;
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }

  if (dataStart < 0) throw new Error('no data chunk in WAV file');
  if (format !== 1) throw new Error(`only PCM WAV is supported, got format ${format}`);
  if (bitsPerSample !== 16) throw new Error(`only 16-bit WAV is supported, got ${bitsPerSample}`);

  const frames = Math.floor(dataLength / (2 * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const offset = dataStart + (i * channels + c) * 2;
      sum += view.getInt16(offset, true) / 32768;
    }
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate };
}
