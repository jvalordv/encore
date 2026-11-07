/**
 * Scoring a karaoke track against its original: the run at the service. The
 * singer names an original, either a video picked from the search (which the
 * service must first prepare, without it becoming the song in use) or a
 * prepared song from the Library. The service then aligns the karaoke song to
 * it (`POST /songs/{id}/align`, a job) and this controller follows the job,
 * writing its progress into `state.align`. When the alignment is done the
 * borrowed melody replaces the lane's and Strict scoring applies to the
 * karaoke video; when it is refused (the arrangements differ) or fails, the
 * reason is shown and nothing changes, so the song panel can offer Open.
 *
 * One run at a time, and it belongs to the song in use: another song taking
 * over (`reset`, called by the stems controller) ends it.
 */
import { isAbortError, ServiceClient, ServiceError } from '../../service/client';
import { alignStateOf, initialAlign, PREPARING_ORIGINAL } from '../align';
import type { AlignState } from '../align';
import { describeFailure, describeServiceError } from '../prepare';
import type { SessionCore } from './core';

/** Said when the karaoke song is not on the service yet. */
export const NO_KARAOKE_SONG =
  "The service does not have this song yet. Prepare it first, then pick the original.";
/** Said when the original was prepared but has no melody to follow. */
export const ORIGINAL_HAS_NO_MELODY = 'The service found no melody in that original.';
/** Said when the melody was written but could not be brought back. */
export const MELODY_NOT_LOADED = 'The service matched the songs but the melody could not be loaded.';

/** Follows one alignment job at a time for the song in use. */
export class AlignController {
  private controller: AbortController | null = null;

  constructor(private readonly core: SessionCore) {}

  private set(state: Partial<AlignState>): void {
    this.core.store.patch({ align: { ...this.core.store.state.align, ...state } });
  }

  /** Ends any run and clears what the panel says; another song has taken over. */
  reset(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.core.store.state.align.phase !== 'idle') this.core.store.patch({ align: initialAlign() });
  }

  /**
   * A video was picked as the original: has the service prepare it (the
   * link is added, and the song in use is left alone) and aligns to it.
   */
  async useVideo(videoId: string): Promise<void> {
    await this.run(async (client, signal, karaokeId) => {
      const added = await client.createSongFromUrl(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, signal);
      const outcome = await client.pollSong(added.song_id, {
        through: 'reference',
        signal,
        onUpdate: (update) => this.set({ phase: 'working', progress: 0, message: this.preparing(update) }),
      });
      if (outcome.kind === 'aborted') return;
      if (outcome.kind !== 'settled') throw new ServiceError('unexpected', 'The original could not be prepared.');
      const { status } = outcome;
      if (status.steps.reference.state !== 'done') {
        const failed = (['fetch', 'separation', 'reference'] as const).find((s) => status.steps[s].state === 'failed');
        const why = status.steps.reference.detail?.trim() || ORIGINAL_HAS_NO_MELODY;
        throw new ServiceError('unexpected', failed ? describeFailure(status, failed) : why);
      }
      await this.align(client, signal, karaokeId, status.song_id);
    });
  }

  /** A prepared song was picked as the original: aligns to it. */
  async useSong(originalId: string): Promise<void> {
    await this.run((client, signal, karaokeId) => this.align(client, signal, karaokeId, originalId));
  }

  private preparing(update: { steps: { fetch: { progress: number } } }): string {
    return `${PREPARING_ORIGINAL} ${Math.round(update.steps.fetch.progress * 100)}%`;
  }

  private async run(work: (client: ServiceClient, signal: AbortSignal, karaokeId: string) => Promise<void>): Promise<void> {
    const karaokeId = this.core.stems.songId();
    if (karaokeId === null) {
      this.core.store.patch({ align: { ...initialAlign(), phase: 'failed', message: NO_KARAOKE_SONG } });
      return;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.core.store.patch({ align: { ...initialAlign(), phase: 'working' } });
    const client = new ServiceClient({ baseUrl: this.core.current.serviceUrl });
    try {
      await work(client, controller.signal, karaokeId);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      this.set({ phase: 'failed', message: describeServiceError(error) });
    }
  }

  /** Asks for the alignment, follows it, and brings the melody in when done. */
  private async align(client: ServiceClient, signal: AbortSignal, karaokeId: string, originalId: string): Promise<void> {
    this.set({ phase: 'working', progress: 0, message: '' });
    await client.alignSong(karaokeId, originalId, signal);
    const result = await client.pollAlignment(karaokeId, {
      signal,
      onUpdate: (alignment) => this.core.store.patch({ align: alignStateOf(alignment) }),
    });
    if (result === null || signal.aborted) return;
    this.core.store.patch({ align: alignStateOf(result) });
    if (result.state !== 'done') return;
    if (!(await this.core.stems.adoptAligned(karaokeId)) && !signal.aborted) {
      this.set({ phase: 'failed', message: MELODY_NOT_LOADED });
    }
  }
}
