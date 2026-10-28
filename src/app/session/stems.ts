/**
 * The karaoke track of the song in use: sending a dropped file to the service,
 * following the service while it separates the vocal and reads the melody, and
 * bringing the results back, the stems into the mix (session/mix.ts) and the
 * melody onto the lane. A linked song joins at the same place once it has been
 * prepared (session/prepare.ts hands over its status). The song itself never
 * waits for any of this: a file plays the moment it is decoded, and with the
 * service away or failing the only difference is one line in the song panel.
 *
 * Everything belongs to one song. A newer song taking over (`reset`) ends the
 * upload and the polling in flight through their AbortSignal, takes the stems
 * and the melody away and clears the panel's state, and a result that arrives
 * late is turned away by `isCurrent` (the epoch, the signal and the Player's
 * song) before it can touch the new song. A load that fails leaves the old
 * song, and its karaoke track, as they were.
 */
import type { ScoreReference } from '../../analysis/score';
import type { LaneReference } from '../../render/lane-geometry';
import { isAbortError, ServiceClient, ServiceError, settledThrough } from '../../service/client';
import type { Reference, SongStatus } from '../../service/types';
import { initialKaraoke } from '../karaoke';
import type { KaraokeState } from '../karaoke';
import { describeFailure, describeServiceError } from '../prepare';
import { initialReference, laneReferenceOf, scoreReferenceOf } from '../reference';
import type { ReferenceState } from '../reference';
import type { SessionCore } from './core';

/** Said when the service holds no stems for a song it called separated. */
const NO_STEMS = 'The service has no karaoke track for this song. Add it again.';
/** Said when the reference step finished but the service has no melody. */
const NO_MELODY = 'The service has no melody for this song.';
/** Said when the reference step was skipped without saying why. */
const MELODY_SKIPPED = 'The service found no melody in this song.';
/** Said when the separation step was skipped without saying why. */
const SEPARATION_SKIPPED = 'The service did not separate this song.';

/** One run at the service for the song in use. */
interface Job {
  epoch: number;
  controller: AbortController;
  /** The Player's key for the song the run began on. */
  hash: string | undefined;
}

/** Makes the karaoke track for the song in use, through the service. */
export class StemsController {
  // Bumped by every reset, so a run for an earlier song knows it is over.
  private epoch = 0;
  private job: Job | null = null;
  // The file whose upload found no service, kept to send once one answers.
  private heldFile: File | null = null;
  private laneReference: LaneReference | null = null;

  constructor(private readonly core: SessionCore) {}

  /**
   * A dropped file has loaded and is the song: starts making its karaoke
   * track, if the service is running. The file plays meanwhile.
   */
  beginFile(file: File): void {
    this.reset();
    this.heldFile = file;
    void this.runFile(file);
  }

  /**
   * A linked song has been prepared and the Player holds its audio: follows
   * the service from `status` (the last word it had, with the fetch done)
   * through separation and the melody.
   */
  follow(status: SongStatus): void {
    const job = this.begin();
    void this.guarded(job, () => this.carryOn(job, new ServiceClient(this.clientOptions()), status));
  }

  /**
   * Ends everything for the song in use: the run at the service, the stems,
   * the melody and the panel's state. Called when another song takes over.
   */
  reset(): void {
    this.epoch += 1;
    this.job?.controller.abort();
    this.job = null;
    this.heldFile = null;
    this.core.mix.clear();
    this.showReference(null, initialReference());
    this.core.store.patch({ karaoke: initialKaraoke() });
  }

  /**
   * Asks the service again, with the file held, if it was found not to run:
   * the person may have started it since.
   */
  checkService(): void {
    const file = this.heldFile;
    if (file && this.core.store.state.karaoke.phase === 'unavailable') void this.runFile(file);
  }

  /** Gives a lane attached after the melody arrived the melody it missed. */
  syncLane(): void {
    this.core.lane?.setReference(this.laneReference);
    if (this.laneReference) this.core.lane?.fitRangeToReference();
  }

  /** The address is read each time, so a changed setting needs no restart. */
  private clientOptions(): { baseUrl: string } {
    return { baseUrl: this.core.current.serviceUrl };
  }

  /** Starts a run, ending the one before it. */
  private begin(): Job {
    this.job?.controller.abort();
    const job: Job = {
      epoch: this.epoch,
      controller: new AbortController(),
      hash: this.core.parts?.player.info?.hash,
    };
    this.job = job;
    return job;
  }

  /**
   * True while `job` is the run for the song in use: nothing has reset it or
   * stopped it, and the Player still holds the song it began on.
   */
  private isCurrent(job: Job): boolean {
    return (
      this.job === job &&
      job.epoch === this.epoch &&
      !job.controller.signal.aborted &&
      this.core.parts?.player.info?.hash === job.hash
    );
  }

  private setKaraoke(fields: Partial<KaraokeState>): void {
    this.core.store.patch({ karaoke: { ...this.core.store.state.karaoke, ...fields } });
  }

  /** Runs `work`; whatever it throws becomes the panel's reason, unless stale. */
  private async guarded(job: Job, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!this.isCurrent(job) || isAbortError(error)) return;
      this.setKaraoke({ phase: 'failed', steps: null, message: describeServiceError(error) });
    }
  }

  /** Checks the service, sends the file and carries on with what it answers. */
  private async runFile(file: File): Promise<void> {
    const job = this.begin();
    const client = new ServiceClient(this.clientOptions());
    const { signal } = job.controller;
    this.setKaraoke({ phase: 'checking', uploadProgress: 0, steps: null, message: '' });
    await this.guarded(job, async () => {
      const up = await client.health(signal);
      if (!this.isCurrent(job)) return;
      if (!up) {
        this.setKaraoke({ phase: 'unavailable' });
        return;
      }
      this.setKaraoke({ phase: 'uploading', uploadProgress: 0 });
      const status = await client.uploadSong(file, {
        signal,
        onProgress: (fraction) => {
          const before = Math.round(this.core.store.state.karaoke.uploadProgress * 100);
          if (this.isCurrent(job) && Math.round(fraction * 100) !== before) {
            this.setKaraoke({ uploadProgress: fraction });
          }
        },
      });
      if (!this.isCurrent(job)) return;
      this.heldFile = null;
      await this.carryOn(job, client, status);
    });
  }

  /** The common road: separation, the stems, the melody. */
  private async carryOn(job: Job, client: ServiceClient, first: SongStatus): Promise<void> {
    this.setKaraoke({ phase: 'preparing', steps: first.steps, message: '' });
    const separated = await this.settle(job, client, first, 'separation', 'preparing');
    if (!separated) return;
    const separation = separated.steps.separation;
    if (separation.state !== 'done') {
      this.setKaraoke({ phase: 'failed', steps: null, message: this.whyNot(separated, 'separation') });
      return;
    }
    this.setKaraoke({ phase: 'loading', steps: separated.steps });
    if (!(await this.loadStems(job, client, separated.song_id))) return;
    this.setKaraoke({ phase: 'ready', steps: separated.steps });

    const mapped = await this.settle(job, client, separated, 'reference', 'ready');
    if (!mapped) return;
    await this.loadReference(job, client, mapped);
    if (this.isCurrent(job)) this.setKaraoke({ phase: 'ready', steps: mapped.steps });
  }

  /**
   * Waits for the steps up to `through` to settle, showing them in `phase` as
   * they move. Null when the run was stopped or replaced on the way.
   */
  private async settle(
    job: Job,
    client: ServiceClient,
    status: SongStatus,
    through: 'separation' | 'reference',
    phase: KaraokeState['phase'],
  ): Promise<SongStatus | null> {
    if (settledThrough(status, through)) return status;
    const outcome = await client.pollSong(status.song_id, {
      through,
      signal: job.controller.signal,
      onUpdate: (update) => {
        if (this.isCurrent(job)) this.setKaraoke({ phase, steps: update.steps });
      },
    });
    if (!this.isCurrent(job) || outcome.kind !== 'settled') return null;
    return outcome.status;
  }

  /** Why a step did not finish, in the service's words when it gave any. */
  private whyNot(status: SongStatus, step: 'separation' | 'reference'): string {
    const { state, detail } = status.steps[step];
    if (state === 'skipped') {
      return detail?.trim() || (step === 'separation' ? SEPARATION_SKIPPED : MELODY_SKIPPED);
    }
    // A step that never ran is left queued behind the one that failed.
    const failed = (['fetch', 'separation', 'reference'] as const).find(
      (name) => status.steps[name].state === 'failed',
    );
    return describeFailure(status, failed ?? step);
  }

  /** Downloads and decodes both stems and puts them in the mix. */
  private async loadStems(job: Job, client: ServiceClient, songId: string): Promise<boolean> {
    const player = this.core.parts?.player;
    if (!player) return false;
    const { signal } = job.controller;
    let downloads;
    try {
      downloads = await Promise.all([
        client.fetchStem(songId, 'vocals', signal),
        client.fetchStem(songId, 'no_vocals', signal),
      ]);
    } catch (error) {
      if (error instanceof ServiceError && error.kind === 'not-fetched') {
        throw new ServiceError('unexpected', NO_STEMS, error.status);
      }
      throw error;
    }
    if (!this.isCurrent(job)) return false;
    const [vocals, noVocals] = await Promise.all(downloads.map((d) => player.decode(d.bytes)));
    if (!this.isCurrent(job)) return false;
    this.core.mix.install({ vocals, noVocals, gain: Math.min(downloads[0].gain, downloads[1].gain) });
    this.core.store.setStatus('Karaoke track ready: the original singer is out of the mix.');
    return true;
  }

  /** Fetches the melody and draws it, or records why there is none. */
  private async loadReference(job: Job, client: ServiceClient, status: SongStatus): Promise<void> {
    const { state } = status.steps.reference;
    if (state === 'done') {
      let reference: Reference;
      try {
        reference = await client.fetchReference(status.song_id, job.controller.signal);
      } catch (failure) {
        if (!this.isCurrent(job) || isAbortError(failure)) return;
        const none = failure instanceof ServiceError && failure.kind === 'not-fetched';
        const message = none ? NO_MELODY : describeServiceError(failure);
        this.showReference(null, { phase: none ? 'skipped' : 'failed', notes: 0, message });
        return;
      }
      if (!this.isCurrent(job)) return;
      this.showReference(
        laneReferenceOf(reference),
        { phase: 'ready', notes: reference.notes.length, message: '' },
        scoreReferenceOf(reference),
      );
      return;
    }
    const message = this.whyNot(status, 'reference');
    this.showReference(null, { phase: state === 'failed' ? 'failed' : 'skipped', notes: 0, message });
  }

  /**
   * Puts a melody (or none) on the lane, hands it to learning mode to score
   * against, and its state in the panel.
   */
  private showReference(
    lane: LaneReference | null,
    state: ReferenceState,
    score: ScoreReference | null = null,
  ): void {
    this.laneReference = lane;
    this.core.scoring.setReference(score);
    this.syncLane();
    this.core.store.patch({ reference: state });
  }
}
