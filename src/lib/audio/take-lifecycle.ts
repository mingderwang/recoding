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

/**
 * Replace the current take with a new one, in that order.
 *
 * The order is the entire point, and getting it wrong is invisible until a
 * feature silently stops working. Assigning the new blob first and clearing
 * afterwards clears the take that has just arrived rather than the one that is
 * leaving, so `take.blob` ends up null after every analysis — which is exactly
 * what happened: "Play recording" and "Download recording" both returned early
 * on every take, so the recording a user had been asked to send in could not be
 * produced, and every feedback report claimed a duration of 0.0s.
 *
 * Doing it in one function is what keeps it correct, and what makes it testable
 * without a page.
 */
export function adoptTake(
  take: TakeState,
  audio: HTMLAudioElement | null,
  release: ReleaseAudio,
  labels: ResetLabels,
  next: { blob: Blob; duration: number },
): void {
  resetTake(take, audio, release, labels);
  take.blob = next.blob;
  take.duration = next.duration;
}
