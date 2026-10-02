/**
 * Recorded-take lifecycle, kept out of the page controller so it can be
 * tested.
 *
 * A reset has to clear three things, and missing any one of them leaves the
 * previous take reachable: the blob, the audio element built from it, and the
 * labels that describe it. Reported by a user: after "Record again" the page
 * looked reset but "Play recording" still replayed the old recording, its
 * button still read "Stop playback", and the playhead quoted the old duration.
 */

export interface TakeState {
  /** The recorded audio, or null once released. */
  blob: Blob | null;
  /** Duration in seconds. */
  duration: number;
}

export type ReleaseAudio = () => void;

export interface ResetLabels {
  playButton: { textContent: string };
  playhead: { textContent: string };
}

export const DEFAULT_PLAY_LABEL = 'Play recording';

/**
 * Detach and dispose of the audio element for a take.
 *
 * The `timeupdate` and `ended` handlers are removed before the element is
 * dropped, so a late event from audio that no longer belongs to the page cannot
 * repaint a label. The object URL is revoked, because a blob URL keeps its blob
 * alive for the lifetime of the document; without this every take leaks a full
 * recording.
 */
export function disposeAudioElement(audio: HTMLAudioElement | null): void {
  if (!audio) return;
  audio.pause();
  audio.onended = null;
  audio.ontimeupdate = null;
  if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
  audio.removeAttribute('src');
  audio.load();
}

/**
 * Clear everything belonging to a finished take: the audio element, the blob
 * reference, and the labels describing it.
 */
export function resetTake(
  take: TakeState,
  audio: HTMLAudioElement | null,
  release: ReleaseAudio,
  labels: ResetLabels,
): void {
  disposeAudioElement(audio);
  take.blob = null;
  take.duration = 0;
  labels.playButton.textContent = DEFAULT_PLAY_LABEL;
  labels.playhead.textContent = '';
  release();
}
