/**
 * Microphone capture: records audio for playback while simultaneously
 * exposing a live level meter and pitch readout.
 */
export interface RecorderHandle {
  /** The recorded audio, as a playable blob. */
  blob: Blob;
  /** Duration in seconds. */
  duration: number;
}

export interface RecorderCallbacks {
  /** Input level in 0..1, called on every animation frame while recording. */
  onLevel?: (level: number) => void;
  /** Live pitch estimate while recording, for the moving readout. */
  onPitch?: (hz: number) => void;
}

export class MicrophoneError extends Error {
  constructor(message: string, readonly kind: 'permission' | 'unsupported' | 'device') {
    super(message);
    this.name = 'MicrophoneError';
  }
}

function isSecure(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  );
}

/** Best mime type this browser will actually record with. */
function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

export class Recorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private frameHandle = 0;
  private readonly buffer: Float32Array<ArrayBuffer>;

  constructor(private readonly callbacks: RecorderCallbacks = {}) {
    this.buffer = new Float32Array(new ArrayBuffer(2048 * 4));
  }

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined' &&
      typeof AudioContext !== 'undefined'
    );
  }

  async start(): Promise<void> {
    if (!isSecure()) {
      throw new MicrophoneError(
        'The microphone needs a secure connection. Open this page over HTTPS, or on localhost.',
        'unsupported',
      );
    }
    if (!Recorder.isSupported()) {
      throw new MicrophoneError('This browser does not support microphone recording.', 'unsupported');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (error) {
      const name = (error as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new MicrophoneError(
          'Microphone access was blocked. Allow it in your browser’s site settings, then try again.',
          'permission',
        );
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new MicrophoneError('No microphone was found on this device.', 'device');
      }
      throw new MicrophoneError(`Could not open the microphone: ${(error as Error).message}`, 'device');
    }

    this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();

    this.analyser = this.context.createAnalyser();
    // A large FFT size is not needed for the meter, only a stable level, but a
    // 4096 window gives the live pitch readout enough resolution for low notes.
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    this.context.createMediaStreamSource(this.stream).connect(this.analyser);

    const mimeType = pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
    this.startedAt = performance.now();
    this.tick();
  }

  private tick = (): void => {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buffer);

    let sumSquares = 0;
    for (let i = 0; i < this.buffer.length; i++) sumSquares += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sumSquares / this.buffer.length);
    // Map RMS to a 0..1 bar with a curve; linear RMS is invisible for speech.
    this.callbacks.onLevel?.(Math.min(1, Math.pow(rms * 3.2, 0.6)));
    this.callbacks.onPitch?.(this.livePitch(rms));

    this.frameHandle = requestAnimationFrame(this.tick);
  };

  /** Cheap live pitch: autocorrelation over a limited lag range. */
  private livePitch(rms: number): number {
    if (rms < 0.008) return 0;
    const n = this.buffer.length;
    const minLag = Math.floor(this.context!.sampleRate / 600);
    const maxLag = Math.floor(this.context!.sampleRate / 70);
    let bestLag = -1;
    let bestScore = 0;
    for (let lag = minLag; lag < maxLag && lag < n - 1; lag++) {
      let correlation = 0;
      let energyA = 0;
      let energyB = 0;
      for (let i = 0; i < n - lag; i += 2) {
        const a = this.buffer[i];
        const b = this.buffer[i + lag];
        correlation += a * b;
        energyA += a * a;
        energyB += b * b;
      }
      const score = correlation / (Math.sqrt(energyA * energyB) + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    if (bestLag < 0 || bestScore < 0.5) return 0;
    return this.context!.sampleRate / bestLag;
  }

  async stop(): Promise<RecorderHandle> {
    cancelAnimationFrame(this.frameHandle);
    const duration = (performance.now() - this.startedAt) / 1000;

    const recorder = this.recorder;
    const blob = await new Promise<Blob>((resolve) => {
      if (!recorder || recorder.state === 'inactive') {
        resolve(new Blob(this.chunks, { type: this.chunks[0]?.type || 'audio/webm' }));
        return;
      }
      recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorder.stop();
    });

    this.release();
    return { blob, duration };
  }

  cancel(): void {
    cancelAnimationFrame(this.frameHandle);
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
    this.analyser = null;
    this.recorder = null;
  }
}

/**
 * Decode a recorded blob to a mono signal for analysis.
 *
 * `decodeAudioData` needs the raw sample rate of the file, which is often not
 * 44100, so the result is resampled by linear interpolation to keep the analysis
 * parameters (window sizes, hop) meaningful.
 */
export async function decodeToMono(blob: Blob, targetSampleRate = 44100): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(arrayBuffer);
    if (decoded.sampleRate === targetSampleRate && decoded.numberOfChannels === 1) {
      return decoded.getChannelData(0).slice();
    }
    const mono = mixToMono(decoded);
    return resample(mono, decoded.sampleRate, targetSampleRate);
  } finally {
    void context.close();
  }
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const out = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  const scale = 1 / buffer.numberOfChannels;
  for (let i = 0; i < length; i++) out[i] *= scale;
  return out;
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const length = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}
