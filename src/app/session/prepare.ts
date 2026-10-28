/**
 * Preparing a linked song: the service probe, the preparation attempt (one
 * run at the service for the video in use), and the switch from the video to
 * the app's own audio once the prepared file is loaded. Owns the attempt, the
 * embed follower that keeps the muted video in step afterwards, and the
 * waiters a prepared song leaves while a take is being recorded. The panel's
 * state machine itself is in src/app/prepare.ts; this is what drives it.
 */
import { EmbedFollower } from '../../audio/embed-follower';
import type { FollowerHooks } from '../../audio/embed-follower';
import { isRunning } from '../../audio/transport';
import type { YouTubeTransport } from '../../audio/youtube-transport';
import { ServiceClient } from '../../service/client';
import {
  canonicalWatchUrl,
  initialPrepare,
  PREPARED_NOTE,
  prepareLink,
  WAITING_NOTE,
} from '../prepare';
import type { PrepareState } from '../prepare';
import type { SessionCore } from './core';
import { messageOf } from './helpers';
import type { SessionParts } from './types';

/**
 * Longest wait for the audio context to run before a prepared song takes over
 * from its video. A context the browser will not start yet never answers, and
 * the switch then goes ahead without it.
 */
const CONTEXT_START_WAIT_MS = 2000;
/** Said when the app's own audio has taken the song over from the video. */
const PREPARED_STATUS =
  'Prepared: the app now plays the song and keeps time. The video follows, muted.';
/** Said when Prepare finds the service gone since the link loaded. */
const SERVICE_GONE_STATUS =
  'The service is not running, so the song was not prepared. See service/README.md.';
/** Said when YouTube's own Play is pressed while a calibration is running. */
const CALIBRATING_VIDEO_STATUS = 'Wait for calibration to finish before playing the video.';

/**
 * One run at the service for the linked song: a check that it is running, or
 * a preparation. It belongs to the video it began on and to the load token of
 * that moment, so a newer load (which bumps the token) or a different video
 * ends it, and `controller` stops whatever call is in flight.
 */
interface PrepareAttempt {
  embed: YouTubeTransport;
  token: number;
  controller: AbortController;
  /**
   * 'check' is the question whether the service runs, asked as a link loads;
   * 'prepare' is a preparation, whose own first step may ask it again. What a
   * stopped run leaves the panel saying depends on which it was.
   */
  kind: 'check' | 'prepare';
}

/** Drives the service check, the preparation and the switch to prepared. */
export class PrepareController {
  // The service check or preparation in hand for the linked song, if any.
  private attempt: PrepareAttempt | null = null;
  // Once the song is prepared, keeps the muted video in step with the engine.
  private follower: EmbedFollower | null = null;
  // Wake-ups for a prepared song waiting for a take to end (see kickSwitch).
  private readonly switchWaiters = new Set<() => void>();

  constructor(private readonly core: SessionCore) {}

  /**
   * Prepares the linked song for scoring: has the service fetch the video's
   * audio, loads that into the audio Player and makes it the song, with the
   * video as a muted picture that follows. This is where a link leaves for the
   * service, so it runs only when the person presses Prepare for scoring (or
   * Add again after a failure), or from the automatic setting once a link has
   * loaded. It does nothing unless the song panel is offering it, and a newer
   * load ends it wherever it has got to.
   */
  async prepare(): Promise<void> {
    await this.startPrepare(false);
  }

  /**
   * Asks the service again whether it runs, if it was found not to: the person
   * may have started it since, and Prepare stays off until it answers.
   */
  checkService(): void {
    const embed = this.core.songs.embed;
    if (embed && this.core.store.state.prepare.phase === 'unavailable') void this.probeService(embed);
  }

  /**
   * Turns the automatic sending of a link to the service on or off. It is read
   * when a link's service check ends, so turning it on sends no link whose
   * check has already passed; one that found the service not running is sent
   * once the service answers (checkService), if the setting is on by then.
   */
  setAutoPrepareLinks(on: boolean): void {
    this.core.current.autoPrepareLinks = on === true;
    this.core.persist();
  }

  /** A client for the service at the address in the settings, read each time. */
  private serviceClient(): ServiceClient {
    return new ServiceClient({ baseUrl: this.core.current.serviceUrl });
  }

  /** Writes the panel's state; a repeat of what it already says is no change. */
  private setPrepare(next: PrepareState): void {
    const now = this.core.store.state.prepare;
    const same = now.phase === next.phase && now.message === next.message && now.steps === next.steps;
    if (!same) this.core.store.patch({ prepare: next });
  }

  /** Starts a run at the service for `embed`, ending any run before it. */
  private beginAttempt(embed: YouTubeTransport, kind: PrepareAttempt['kind']): PrepareAttempt {
    this.attempt?.controller.abort();
    const controller = new AbortController();
    const attempt: PrepareAttempt = { embed, token: this.core.songs.loadToken, controller, kind };
    this.attempt = attempt;
    return attempt;
  }

  /**
   * True while `attempt` is the run in hand for the video in use, and no
   * newer load has begun since it started (the load token), nor stopped it.
   * Every await in a run is followed by this check.
   */
  private isCurrent(attempt: PrepareAttempt): boolean {
    return (
      this.attempt === attempt &&
      attempt.token === this.core.songs.loadToken &&
      this.core.songs.embed === attempt.embed &&
      !attempt.controller.signal.aborted
    );
  }

  /**
   * Stops a run that is under way because a newer load has begun. A preparation
   * puts the panel back to offering Prepare: if that load fails the video stays
   * as the song, unprepared, and the person presses Prepare again. A check that
   * had not been answered is asked afresh instead, since Prepare is not to be
   * offered on a guess, and a link waiting on that answer to be sent by itself
   * still is. If the newer load wins, the panel is reset for what it loaded.
   */
  cancelAttempt(): void {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null;
    attempt.controller.abort();
    if (attempt.kind === 'check') {
      void this.probeService(attempt.embed);
      return;
    }
    this.setPrepare({ phase: 'ready', steps: null, message: '' });
  }

  /**
   * Everything about the linked song's preparation, ended: the follower, any
   * run, the panel. Called when the video is replaced or closed, and before
   * the Player is told to pause so the follower does not copy that.
   */
  endPrepared(): void {
    this.follower?.stop();
    this.follower = null;
    this.attempt?.controller.abort();
    this.attempt = null;
    this.setPrepare(initialPrepare());
  }

  /**
   * Asks the service whether it runs and shows Prepare accordingly. With the
   * automatic setting on, a service that answers is sent the link at once.
   */
  async probeService(embed: YouTubeTransport): Promise<void> {
    const attempt = this.beginAttempt(embed, 'check');
    this.setPrepare({ phase: 'checking', steps: null, message: '' });
    const up = await this.serviceClient().health(attempt.controller.signal);
    if (!this.isCurrent(attempt)) return;
    this.attempt = null;
    this.setPrepare({ phase: up ? 'ready' : 'unavailable', steps: null, message: '' });
    if (up && this.core.current.autoPrepareLinks) void this.startPrepare(true);
  }

  /**
   * The preparation itself; see `prepare`. `healthKnown` is true when the
   * service has just answered a check, so it is not asked again.
   */
  private async startPrepare(healthKnown: boolean): Promise<void> {
    const embed = this.core.songs.embed;
    const parts = this.core.parts;
    const { phase } = this.core.store.state.prepare;
    if (!embed || !parts || (phase !== 'ready' && phase !== 'failed')) return;
    const attempt = this.beginAttempt(embed, 'prepare');
    const { signal } = attempt.controller;
    const client = this.serviceClient();
    try {
      if (!healthKnown) {
        this.setPrepare({ phase: 'checking', steps: null, message: '' });
        // It may have stopped since the link loaded.
        const up = await client.health(signal);
        if (!this.isCurrent(attempt)) return;
        if (!up) {
          this.attempt = null;
          this.setPrepare({ phase: 'unavailable', steps: null, message: '' });
          this.core.store.setStatus(SERVICE_GONE_STATUS, 'warn');
          return;
        }
      }
      this.setPrepare({ phase: 'preparing', steps: null, message: '' });
      const outcome = await prepareLink(client, canonicalWatchUrl(embed.videoId), {
        signal,
        onSteps: (steps) => {
          if (this.isCurrent(attempt)) this.setPrepare({ phase: 'preparing', steps, message: '' });
        },
        onLoading: (steps) => {
          if (this.isCurrent(attempt)) this.setPrepare({ phase: 'loading', steps, message: '' });
        },
      });
      // Whoever stopped the run has already said what the panel shows.
      if (!this.isCurrent(attempt) || outcome.kind === 'aborted') return;
      if (outcome.kind === 'failed') {
        this.failPrepare(attempt, outcome.message);
        return;
      }

      // The same decoding as a dropped file, filed under the video's own key
      // so the takes made over the video and over this audio share a list.
      const file = new File([outcome.bytes], `${embed.videoId}.flac`, { type: 'audio/flac' });
      try {
        await parts.player.load(file, embed.info?.name, `yt-${embed.videoId}`);
      } catch (error) {
        // A newer load took the player, which rejects this one; it has the
        // status line.
        if (this.isCurrent(attempt)) {
          this.failPrepare(attempt, `The prepared audio could not be loaded: ${messageOf(error)}`);
        }
        return;
      }
      // The switch would pull the clock from under a take being recorded on the
      // video, so it waits until that take is saved. It also waits for the
      // audio context to run, so the engine's clock is moving the moment it
      // starts: a context still resuming holds that clock where the song was
      // left while the video plays on, and the song would then start late
      // beside a picture that did not. A take can begin during that wait.
      do {
        while (this.isCurrent(attempt) && this.recordingBusy()) {
          this.setPrepare({ phase: 'waiting', steps: null, message: WAITING_NOTE });
          await this.waitForKick(signal);
        }
        if (!this.isCurrent(attempt)) return;
        await parts.engine.ensureRunning(CONTEXT_START_WAIT_MS);
        if (!this.isCurrent(attempt)) return;
      } while (this.recordingBusy());
      this.switchToPrepared(embed, parts);
    } catch (error) {
      if (this.isCurrent(attempt)) {
        this.failPrepare(attempt, `Could not prepare the song: ${messageOf(error)}`);
      }
    }
  }

  /** Ends the run with a reason the panel shows and Add again can retry. */
  private failPrepare(attempt: PrepareAttempt, message: string): void {
    if (this.attempt === attempt) this.attempt = null;
    this.setPrepare({ phase: 'failed', steps: null, message });
    this.core.store.setStatus(message, 'error');
  }

  /** True while a take is being recorded, or is about to be. */
  private recordingBusy(): boolean {
    return this.core.store.state.recording || this.core.takes.startingRecord;
  }

  /** Tells a prepared song waiting for a take that the take has ended. */
  kickSwitch(): void {
    for (const wake of [...this.switchWaiters]) wake();
  }

  /** Resolves at the next kickSwitch, or when `signal` aborts. */
  private waitForKick(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        this.switchWaiters.delete(wake);
        signal.removeEventListener('abort', wake);
        resolve();
      };
      this.switchWaiters.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });
  }

  /**
   * Hands the song from the video to the audio engine, whose Player already
   * holds the prepared audio. The position, the loop and whether it was going
   * carry over; the video is muted and made a follower, and stays on the page.
   * Synchronous, so nothing can start a take between the check and the swap.
   * The audio context has been waited for by now, so a song that was going
   * starts on a clock that moves; if the browser would not run it in time, the
   * follower waits for the clock and the sound joins the video where it is.
   */
  private switchToPrepared(embed: YouTubeTransport, parts: SessionParts): void {
    const { player } = parts;
    const startS = embed.positionS;
    const going = isRunning(embed.state);
    const { loop } = embed;
    this.attempt = null;
    // Muted first, so the two sounds never overlap.
    embed.mute();
    player.seek(startS);
    if (loop) player.setLoop(loop);
    this.core.songs.activate(player, { pausePrevious: false });
    const follower = new EmbedFollower({ engine: player, embed, hooks: this.followerHooks(embed) });
    this.follower = follower;
    follower.start();
    this.setPrepare({ phase: 'prepared', steps: null, message: PREPARED_NOTE });
    this.core.store.setStatus(PREPARED_STATUS);
    // Through play(), so the guards on the app's own Play apply to it too.
    if (going) this.core.playback.play();
  }

  /**
   * What the person does with the video's own controls, applied to the song
   * through the same intents as the app's controls.
   */
  private followerHooks(embed: YouTubeTransport): FollowerHooks {
    return {
      play: () => {
        if (this.core.store.state.calibrating) {
          // The video would drown the chirps; the Play button is off for the
          // same reason.
          embed.pause();
          this.core.store.setStatus(CALIBRATING_VIDEO_STATUS, 'warn');
          return;
        }
        this.core.playback.play();
      },
      pause: () => this.core.playback.pause(),
      seek: (positionS) => this.core.playback.seek(positionS),
    };
  }
}
