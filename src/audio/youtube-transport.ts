/**
 * YouTubeTransport: the Transport (src/audio/transport.ts) for a song that
 * plays in YouTube's embedded player. The player supplies the sound and the
 * picture; the app follows its clock. It is the one place that knows the
 * IFrame API's habits, so the rest of the app sees only a Transport:
 *
 * - the clock: `positionS` reads `getCurrentTime()` on every query and passes
 *   it through the guard in embed-clock.ts (held backward steps, jumps and
 *   stalls reported as 'seek');
 * - the state: YouTube's own events, including those from its on-page
 *   controls, become `state`; an advertisement in the iframe becomes 'ad' (not
 *   playing, so nothing is stamped or recorded) and the clock is frozen at the
 *   last song position until it ends;
 * - start-up: playback begins only when the app's Play is pressed, which is a
 *   user gesture; nothing here relies on autoplay;
 * - failure: error codes and blocked autoplay become plain messages. While
 *   `load` is still settling they reject it (a video that cannot be embedded
 *   reports that just after the player is ready); afterwards they arrive
 *   through `onNotice`;
 * - prepared mode: once the song is prepared the transport stops being the
 *   active one. The app mutes it (`mute`) and moves it with the ordinary
 *   controls from embed-follower.ts, so it stays a picture of the song.
 *
 * The player lives in the nocookie host (privacy-enhanced mode). The DOM is
 * reached only through an injected EmbedHost, and time and timers are
 * injectable, so the whole class runs under test with a fake player.
 */
import { EmbedClock, isAdPlaying } from './embed-clock';
import type { ClockPlayState } from './embed-clock';
import { clampSeek, normaliseLoop } from './player';
import type { LoopRegion, TrackInfo, Transport, TransportEvent, TransportState } from './transport';
import { API_UNREACHABLE, YT_STATE } from './youtube-api';
import type { YouTubeApi, YouTubePlayer, YouTubePlayerEvent } from './youtube-api';

/** The privacy-enhanced embed host; sets no cookies until playback. */
export const NOCOOKIE_HOST = 'https://www.youtube-nocookie.com';

/**
 * How often the transport checks the player for changes events may miss, and
 * so how far a loop can overshoot its end before the wrap is noticed.
 */
export const POLL_MS = 100;

/** How long the player gets to report ready before the load fails. */
export const READY_TIMEOUT_MS = 15_000;

/**
 * After ready, how long load() waits for the video to cue (or to fail) before
 * it calls the player usable. A video that cannot be embedded says so a few
 * hundred milliseconds after ready, and that must reject the load, not arrive
 * as a message about a video that looked loaded.
 */
export const SETTLE_MS = 1000;

/** Shown when the browser blocks the video from starting by itself. */
export const AUTOPLAY_BLOCKED = 'Press Play to start the video.';

/**
 * After a seek of our own, the player's reading can still be the old time for
 * a moment. For up to this long the target is reported instead, unless the
 * reading comes within SEEK_SETTLE_S of it first.
 */
const SEEK_PENDING_S = 1.5;
const SEEK_SETTLE_S = 0.5;

/** The plain-language reason for an IFrame API error code. */
export function describeYouTubeError(code: number): string {
  switch (code) {
    case 2:
      return "That link's video id is not valid.";
    case 5:
      return 'The YouTube player hit an error. Reload the page and try again.';
    case 100:
      return 'That video is private or was removed.';
    case 101:
    case 150:
      // YouTube sends these for an id that does not exist as well as for a
      // video whose owner blocks embedding, and cannot tell them apart, so
      // the message must not blame the owner alone.
      return 'YouTube would not play that video here: it may not exist or its owner blocks other apps. Check the link.';
    case 153:
      return 'YouTube refused the embed because no referrer reached it.';
    default:
      return `YouTube could not play that video (error ${code}).`;
  }
}

/** A place for one player: the element the API replaces, and its cleanup. */
export interface EmbedMount {
  element: HTMLElement;
  /** Removes whatever is left of this player from the page. */
  dispose(): void;
}

/** The page's player pane, as the transport needs it. */
export interface EmbedHost {
  /**
   * Makes room for one new player. A player already in the pane stays in
   * front and in use; the new one loads behind it, out of reach, and is the
   * one in use once the older is gone.
   */
  mount(): EmbedMount;
}

/**
 * An EmbedHost over a container element. The API replaces the element it is
 * handed with the iframe, so each player gets a slot of its own; removing the
 * slot removes exactly that player and nothing a newer one built. Slots lie on
 * top of one another in the player's box, the oldest on top (a newer slot is
 * put first in the container), so a video still loading can never cover the
 * one in use. A slot behind another is inert, which keeps it out of the tab
 * order and the accessibility tree, until every older slot has gone.
 */
export function domEmbedHost(container: HTMLElement): EmbedHost {
  // The slots in the pane, oldest first; the first is the one in use.
  const slots: HTMLElement[] = [];
  return {
    mount() {
      const doc = container.ownerDocument;
      const slot = doc.createElement('div');
      slot.className = 'embed-slot';
      const element = doc.createElement('div');
      slot.append(element);
      slot.inert = slots.length > 0;
      slots.push(slot);
      container.prepend(slot);
      return {
        element,
        dispose: () => {
          slot.remove();
          const at = slots.indexOf(slot);
          if (at >= 0) slots.splice(at, 1);
          if (slots.length > 0) slots[0].inert = false;
        },
      };
    },
  };
}

/** Something to tell the singer once the player is up. */
export interface EmbedNotice {
  kind: 'warn' | 'error';
  text: string;
}

/** `load` rejects with this when the transport is destroyed first. */
export class EmbedClosedError extends Error {
  constructor() {
    super('The YouTube player was closed before it was ready.');
    this.name = 'EmbedClosedError';
  }
}

/** Timers the transport uses; the defaults are the page's own. */
export interface EmbedTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Everything injectable; only `api` and `host` are required. */
export interface YouTubeTransportOptions {
  /** The loaded IFrame API (`loadYouTubeApi`). */
  api: YouTubeApi;
  /** Where the player goes. */
  host: EmbedHost;
  /** `location.origin`, so the iframe accepts messages from this page. */
  origin?: string;
  /** A monotonic clock in milliseconds; default `performance.now`. */
  now?: () => number;
  timers?: EmbedTimers;
}

const pageTimers: EmbedTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as number),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/** Runs `read`; undefined if the player throws, as it does before ready. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A YouTube video, played in its embedded player, as a Transport. */
export class YouTubeTransport implements Transport {
  readonly clock = 'embed';

  private readonly api: YouTubeApi;
  private readonly host: EmbedHost;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly timers: EmbedTimers;
  private readonly listeners = new Map<TransportEvent, Set<() => void>>();
  private readonly noticeListeners = new Set<(notice: EmbedNotice) => void>();
  private readonly guard = new EmbedClock();

  private mount: EmbedMount | null = null;
  private player: YouTubePlayer | null = null;
  private requestedId = '';
  private ready = false;
  private destroyed = false;
  // The player's own state number, kept current by its events and by polling.
  private ytState: number = YT_STATE.UNSTARTED;
  // True from load and stop() until the video plays: 'ready', not 'paused'.
  private stopped = true;
  // True while playback is wanted (our Play, or YouTube's own button).
  private wantPlay = false;
  private failure: string | null = null;
  private title = '';
  // The requested video's own length, once seen; a different one is an ad's.
  private knownDurationS: number | null = null;
  private adActive = false;
  private infoValue: TrackInfo | null = null;
  private loopValue: LoopRegion | null = null;
  private pendingSeek: { targetS: number; atMs: number } | null = null;
  private lastPositionS = 0;
  // The song position when an ad began, reported until it ends.
  private frozenS = 0;
  private pollHandle: unknown = null;
  // The two timers a pending load() runs against: ready, then settle.
  private readyTimer: unknown = null;
  private settleTimer: unknown = null;
  // True while lookForAd is announcing, so its listeners' reads do not nest.
  private checking = false;
  private loading: { resolve: (info: TrackInfo) => void; reject: (error: Error) => void } | null =
    null;

  constructor(options: YouTubeTransportOptions) {
    this.api = options.api;
    this.host = options.host;
    this.origin = options.origin ?? '';
    this.now = options.now ?? (() => performance.now());
    this.timers = options.timers ?? pageTimers;
  }

  /** The video this transport was asked to play; empty before load. */
  get videoId(): string {
    return this.requestedId;
  }

  get info(): TrackInfo | null {
    return this.infoValue;
  }

  get durationS(): number {
    return this.knownDurationS ?? 0;
  }

  get loop(): LoopRegion | null {
    return this.loopValue;
  }

  get state(): TransportState {
    if (!this.ready || this.destroyed) return 'empty';
    if (this.adActive) return 'ad';
    switch (this.ytState) {
      case YT_STATE.PLAYING:
        return 'playing';
      case YT_STATE.BUFFERING:
        return 'buffering';
      default:
        return this.stopped ? 'ready' : 'paused';
    }
  }

  /**
   * Song time in seconds. Reads the player's clock through the guard each
   * time, so a jump or a stall is noticed on the first query after it and
   * announced as 'seek'. Frozen at the last song position during an ad.
   */
  get positionS(): number {
    if (!this.ready || this.destroyed || !this.player) return this.lastPositionS;
    // An ad shows itself in the video id and length, and its clock is not the
    // song's. Looking before reading the time keeps the ad's time from ever
    // being taken for the song's, even between two polls.
    if (this.isRunning()) this.lookForAd();
    if (this.adActive) return this.frozenS;
    const nowMs = this.now();
    const raw = this.rawTime();

    const pending = this.pendingSeek;
    if (pending) {
      const elapsedS = (nowMs - pending.atMs) / 1000;
      const settled = Math.abs(raw - pending.targetS) <= SEEK_SETTLE_S;
      if (!settled && elapsedS < SEEK_PENDING_S) {
        this.lastPositionS = pending.targetS;
        return pending.targetS;
      }
      this.pendingSeek = null;
      this.guard.reset();
    }

    const reading = this.guard.sample({
      reportedS: raw,
      state: this.clockState(),
      wallMs: nowMs,
      rate: this.rate(),
    });
    this.lastPositionS = reading.positionS;
    if (reading.discontinuity) this.emit('seek');
    return reading.positionS;
  }

  /**
   * Builds the player for `videoId` (cued at `startS` when given, never
   * playing) and resolves once it is ready and cued, or has had SETTLE_MS to
   * say otherwise. Rejects with a plain message if the player errors first or
   * never answers, and with EmbedClosedError if the transport is destroyed
   * meanwhile.
   */
  load(videoId: string, startS?: number): Promise<TrackInfo> {
    if (this.destroyed) return Promise.reject(new EmbedClosedError());
    if (this.mount) return Promise.reject(new Error('This transport already has a video.'));
    this.requestedId = videoId;
    this.lastPositionS = startS ?? 0;

    return new Promise<TrackInfo>((resolve, reject) => {
      this.loading = { resolve, reject };
      const mount = this.host.mount();
      this.mount = mount;
      const playerVars: Record<string, string | number> = {
        enablejsapi: 1,
        ...(this.origin !== '' && this.origin !== 'null' ? { origin: this.origin } : {}),
        playsinline: 1,
        rel: 0,
        controls: 1,
        ...(startS !== undefined && startS > 0 ? { start: Math.floor(startS) } : {}),
      };
      this.readyTimer = this.timers.setTimeout(() => this.failLoad(API_UNREACHABLE), READY_TIMEOUT_MS);
      try {
        this.player = new this.api.Player(mount.element, {
          host: NOCOOKIE_HOST,
          videoId,
          width: '100%',
          height: '100%',
          playerVars,
          events: {
            onReady: (event) => this.onReady(event),
            onStateChange: (event) => this.onStateChange(event),
            onError: (event) => this.onError(event),
            onAutoplayBlocked: () => this.onAutoplayBlocked(),
          },
        });
      } catch {
        this.failLoad(API_UNREACHABLE);
      }
    });
  }

  /** Starts or resumes the video; from the start if it had ended. */
  play(): void {
    const player = this.usablePlayer();
    if (!player) return;
    if (this.failure !== null) {
      this.notify({ kind: 'error', text: this.failure });
      return;
    }
    // The ad is YouTube's to run; its own controls are on screen.
    if (this.adActive) return;
    this.wantPlay = true;
    if (this.ytState === YT_STATE.ENDED && this.pendingSeek === null) {
      this.landAt(0);
      attempt(() => player.seekTo(0, true));
    }
    attempt(() => player.playVideo());
  }

  /** Pauses the video where it is. */
  pause(): void {
    const player = this.usablePlayer();
    if (!player) return;
    this.wantPlay = false;
    attempt(() => player.pauseVideo());
  }

  /** Pauses and returns to the start, leaving the transport 'ready'. */
  stop(): void {
    const player = this.usablePlayer();
    if (!player || this.adActive) return;
    const before = this.state;
    const cold = this.coldState();
    this.wantPlay = false;
    this.stopped = true;
    if (cold) {
      attempt(() => player.cueVideoById({ videoId: this.requestedId, startSeconds: 0 }));
    } else {
      attempt(() => player.pauseVideo());
      attempt(() => player.seekTo(0, true));
    }
    this.landAt(0);
    this.announce(before);
    this.emit('seek');
  }

  /** Moves the playhead, clamped to the video; never starts a stopped one. */
  seek(positionS: number): void {
    const player = this.usablePlayer();
    if (!player || this.adActive) return;
    const target = clampSeek(positionS, this.durationS > 0 ? this.durationS : Number.POSITIVE_INFINITY);
    // seekTo from a cued or ended video starts it playing, and playback must
    // begin with the app's Play; re-cueing at the new time does not.
    if (this.coldState()) {
      attempt(() => player.cueVideoById({ videoId: this.requestedId, startSeconds: target }));
    } else {
      attempt(() => player.seekTo(target, true));
    }
    this.landAt(target);
    this.emit('seek');
  }

  /**
   * Sets or clears the loop. A region too short to loop, or one set before
   * the length of the video is known, clears it.
   */
  setLoop(region: LoopRegion | null): void {
    const next = region && this.durationS > 0 ? normaliseLoop(region, this.durationS) : null;
    const prev = this.loopValue;
    if (next?.startS === prev?.startS && next?.endS === prev?.endS) return;
    this.loopValue = next;
    this.emit('loop');
  }

  /**
   * Silences the video's own sound and leaves the picture going. Used once a
   * song is prepared, when the app's audio engine is what the singer hears.
   */
  mute(): void {
    const player = this.usablePlayer();
    if (player) attempt(() => player.mute());
  }

  /** True while the player reports its sound off; false before it is ready. */
  get muted(): boolean {
    const player = this.usablePlayer();
    return player ? (attempt(() => player.isMuted()) ?? false) : false;
  }

  /** Subscribes to an event; returns the function that unsubscribes. */
  on(event: TransportEvent, listener: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => void set.delete(listener);
  }

  /** Subscribes to messages for the singer (errors, blocked autoplay). */
  onNotice(listener: (notice: EmbedNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => void this.noticeListeners.delete(listener);
  }

  /** Tears the player down: its iframe, its timers and every listener. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pollHandle !== null) this.timers.clearInterval(this.pollHandle);
    this.pollHandle = null;
    this.clearLoadTimers();
    const loading = this.loading;
    this.loading = null;
    const player = this.player;
    this.player = null;
    if (player) attempt(() => player.destroy());
    this.mount?.dispose();
    this.mount = null;
    this.listeners.clear();
    this.noticeListeners.clear();
    loading?.reject(new EmbedClosedError());
  }

  // ---- The player's events -------------------------------------------------

  private onReady(event: YouTubePlayerEvent): void {
    if (this.destroyed) return;
    // Events can arrive before the constructor has returned.
    this.player ??= event.target;
    this.clearLoadTimers();
    this.ready = true;
    const code = attempt(() => this.player?.getPlayerState());
    if (code !== undefined) this.setYtState(code);
    this.refreshMeta();
    this.infoValue ??= this.buildInfo();
    this.pollHandle = this.timers.setInterval(() => this.poll(), POLL_MS);
    // A video that is already cued is usable now. One still unstarted may be
    // about to say it cannot be played, so wait briefly for its cue or error.
    if (this.ytState !== YT_STATE.UNSTARTED) this.completeLoad();
    else this.settleTimer = this.timers.setTimeout(() => this.completeLoad(), SETTLE_MS);
  }

  private onStateChange(event: YouTubePlayerEvent): void {
    if (this.destroyed || !this.ready) return;
    const code = event.data ?? attempt(() => this.player?.getPlayerState());
    if (code === undefined) return;
    const wasAd = this.adActive;
    this.apply(() => this.setYtState(code));
    if (this.ytState !== YT_STATE.UNSTARTED) this.completeLoad();
    // An advertisement ending is not the song ending.
    if (code !== YT_STATE.ENDED || this.destroyed || wasAd || this.adActive) return;
    this.emit('ended');
    // A loop that reaches the end of the video starts over.
    if (this.loopValue) this.restartLoop(this.loopValue);
  }

  private onError(event: YouTubePlayerEvent): void {
    if (this.destroyed) return;
    const message = describeYouTubeError(event.data ?? -1);
    if (this.loading) {
      this.failLoad(message);
      return;
    }
    this.failure = message;
    this.notify({ kind: 'error', text: message });
  }

  private onAutoplayBlocked(): void {
    if (this.destroyed) return;
    this.wantPlay = false;
    this.notify({ kind: 'warn', text: AUTOPLAY_BLOCKED });
  }

  /** Ends a pending load() with what is known: the video is usable. */
  private completeLoad(): void {
    const loading = this.loading;
    if (!loading) return;
    this.loading = null;
    this.clearLoadTimers();
    loading.resolve(this.infoValue ?? this.buildInfo());
  }

  /** Ends a pending load() with a plain message. */
  private failLoad(message: string): void {
    const loading = this.loading;
    if (!loading) return;
    this.loading = null;
    this.clearLoadTimers();
    loading.reject(new Error(message));
  }

  private clearLoadTimers(): void {
    if (this.readyTimer !== null) this.timers.clearTimeout(this.readyTimer);
    if (this.settleTimer !== null) this.timers.clearTimeout(this.settleTimer);
    this.readyTimer = this.settleTimer = null;
  }

  // ---- State, metadata and polling -----------------------------------------

  /** Records the player's state number and what it implies about intent. */
  private setYtState(code: number): void {
    this.ytState = code;
    if (code === YT_STATE.PLAYING) this.stopped = false;
    if (code === YT_STATE.PLAYING || code === YT_STATE.BUFFERING) this.wantPlay = true;
    else if (code === YT_STATE.PAUSED || code === YT_STATE.ENDED || code === YT_STATE.CUED) {
      this.wantPlay = false;
    }
  }

  /**
   * Runs a change, then refreshes what is known about the video (a state
   * change is when the title, the length and an ad show up) and announces
   * whatever moved.
   */
  private apply(change: () => void): void {
    const before = this.state;
    const infoBefore = this.infoValue;
    change();
    this.refreshMeta();
    if (this.infoValue !== infoBefore) this.emit('load');
    this.announce(before);
  }

  /** Tells listeners about a change of `state` with the right event names. */
  private announce(before: TransportState): void {
    const after = this.state;
    if (after === before) return;
    if (after === 'playing') this.emit('play');
    else if (before === 'playing') this.emit('pause');
    this.emit('state');
  }

  /**
   * Reads the video's id, title and length: decides whether an ad is showing,
   * and learns the title and length from the requested video only (an ad's
   * would otherwise become the song's). Updates `info` when something new is
   * known; the caller announces.
   */
  private refreshMeta(): void {
    const player = this.player;
    if (!player || !this.ready) return;
    const data = attempt(() => player.getVideoData());
    const reportedId = data?.video_id || null;
    const reportedDurationS = attempt(() => player.getDuration()) ?? 0;
    const ad = isAdPlaying({
      requestedVideoId: this.requestedId,
      reportedVideoId: reportedId,
      knownDurationS: this.knownDurationS,
      reportedDurationS,
    });
    this.setAd(ad);
    if (ad) return;

    // Without a reported id, only a video that is not yet playing is trusted
    // to still be the requested one.
    const confirmed = reportedId === this.requestedId || (reportedId === null && !this.isRunning());
    if (!confirmed) return;
    let changed = false;
    if (this.knownDurationS === null && reportedDurationS > 0) {
      this.knownDurationS = reportedDurationS;
      changed = true;
    }
    const title = data?.title ?? '';
    if (title !== '' && title !== this.title) {
      this.title = title;
      changed = true;
    }
    if (changed || this.infoValue === null) this.infoValue = this.buildInfo();
  }

  private buildInfo(): TrackInfo {
    return {
      name: this.title !== '' ? this.title : `YouTube video ${this.requestedId}`,
      durationS: this.knownDurationS ?? 0,
      hash: `yt-${this.requestedId}`,
    };
  }

  /** Enters or leaves the ad state; the position stands still meanwhile. */
  private setAd(ad: boolean): void {
    if (ad === this.adActive) return;
    if (ad) {
      this.frozenS = this.lastPositionS;
      this.pendingSeek = null;
    }
    this.adActive = ad;
    // The clock jumps between ad and song; neither jump counts as a seek.
    this.guard.reset();
  }

  /**
   * Refreshes what is known about the video (the ad check among it) and
   * announces what changed. Not re-entered by the listeners it calls, which
   * read the position in turn.
   */
  private lookForAd(): void {
    if (this.checking) return;
    this.checking = true;
    try {
      this.apply(() => undefined);
    } finally {
      this.checking = false;
    }
  }

  /** The periodic check for what events miss: state, ads, metadata, loops. */
  private poll(): void {
    const player = this.player;
    if (this.destroyed || !player) return;
    this.apply(() => {
      const code = attempt(() => player.getPlayerState());
      if (code !== undefined && code !== this.ytState) this.setYtState(code);
    });
    if (this.destroyed) return;
    const loop = this.loopValue;
    if (loop && this.state === 'playing' && this.positionS >= loop.endS) this.seek(loop.startS);
    // Reading keeps the guard fed when nothing else is asking for the time.
    if (!this.destroyed) void this.positionS;
  }

  /** A loop that ran off the end of the video: back to its start, playing. */
  private restartLoop(loop: LoopRegion): void {
    const player = this.usablePlayer();
    if (!player) return;
    this.wantPlay = true;
    // From an ended video seekTo starts playback, which is what a loop needs.
    attempt(() => player.seekTo(loop.startS, true));
    attempt(() => player.playVideo());
    this.landAt(loop.startS);
    this.emit('seek');
  }

  // ---- Small helpers --------------------------------------------------------

  private usablePlayer(): YouTubePlayer | null {
    return this.ready && !this.destroyed ? this.player : null;
  }

  /** Cued, unstarted or ended and not asked to play: seekTo would start it. */
  private coldState(): boolean {
    const s = this.ytState;
    const idle = s === YT_STATE.CUED || s === YT_STATE.UNSTARTED || s === YT_STATE.ENDED;
    return idle && !this.wantPlay;
  }

  /** Trusts `targetS` over the player's reading just after a seek of ours. */
  private landAt(targetS: number): void {
    this.pendingSeek = { targetS, atMs: this.now() };
    this.guard.reset();
    this.lastPositionS = targetS;
  }

  /** Playing or buffering: the song is meant to be going. */
  private isRunning(): boolean {
    return this.ytState === YT_STATE.PLAYING || this.ytState === YT_STATE.BUFFERING;
  }

  private clockState(): ClockPlayState {
    if (this.ytState === YT_STATE.PLAYING) return 'playing';
    return this.ytState === YT_STATE.BUFFERING ? 'buffering' : 'paused';
  }

  private rawTime(): number {
    const player = this.player;
    const time = player ? attempt(() => player.getCurrentTime()) : undefined;
    return time ?? Number.NaN;
  }

  private rate(): number {
    const player = this.player;
    const rate = player ? attempt(() => player.getPlaybackRate()) : undefined;
    return rate !== undefined && rate > 0 ? rate : 1;
  }

  private emit(event: TransportEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener();
      } catch (error) {
        // One bad listener must not stop the others or corrupt the transport.
        console.error(`YouTubeTransport '${event}' listener failed`, error);
      }
    }
  }

  private notify(notice: EmbedNotice): void {
    for (const listener of [...this.noticeListeners]) {
      try {
        listener(notice);
      } catch (error) {
        console.error('YouTubeTransport notice listener failed', error);
      }
    }
  }
}
