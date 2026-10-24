/**
 * Prepared mode's second half: the YouTube player as a muted picture that
 * follows the app's own audio (see "Two modes, one clock" in
 * docs/ARCHITECTURE.md). Once a linked song is prepared, the audio engine
 * supplies the sound and the clock and the embed only shows the video. The
 * traffic is mostly one way. Play, pause, seek, stop, loop and the end of the
 * song on the engine are copied to the embed, and every FOLLOW_INTERVAL_MS the
 * embed is moved onto the engine's position if the two have drifted apart by
 * more than DRIFT_LIMIT_S while both play, paused if it is left playing beside
 * a song that is not, and played again if it is left paused beside a song that
 * is. The playback rate is never touched: the API treats it as a suggestion.
 *
 * What the person does with YouTube's own controls goes the other way, through
 * the hooks, so the Session can apply the guards the app's controls have (no
 * playback during calibration, for one). The video leaves `playing` for
 * reasons that are not the person's, such as buffering, an ad or reaching its
 * end a moment before the audio does, and the embed's own clock can stall or
 * jitter, so `classifyEmbedEvent` accepts only a clear play, a clear pause and
 * a jump far from the engine, a scrub that goes through buffering included
 * (told from a stall by how far behind the video comes back). The follower's
 * own commands come back as events from the iframe up to a few hundred
 * milliseconds later, so for ECHO_MS after each command those are ignored.
 *
 * The loop is given to the video, which wraps it by itself; the engine's wraps
 * announce nothing, so the picture could not be told when to wrap. The two
 * wrap a fraction of a second apart, the video's coming first when it runs
 * ahead, and its wrap is a seek of its own clock to the loop's start. That is
 * never the person scrubbing, so `classifyEmbedEvent` is told the video's loop
 * and passes over a landing at its start, whatever the sound is doing then.
 *
 * A sound that has been told to play has not always started. The audio context
 * can still be resuming, and until it runs the engine's clock stands at the
 * place it was left while the video, which needs no context, plays on. Reading
 * that gap as the person using the video's controls would carry the sound off
 * after the picture, a skip they would hear, so from the engine's `play` until
 * its clock is seen to move (`CLOCK_POLL_MS` apart) the follower is `pending`.
 * A pending sound is not compared with the picture: the picture is held back
 * if it was not going, and what it seems to do besides pausing is left alone.
 * When the clock does move, a picture that was going before the sound was told
 * to start (the person played the video, or the song was handed over from it)
 * is told nothing, and if it has run ahead the sound joins it, taking up where
 * the picture is, so that nothing is pulled back; any other picture is started
 * from the sound.
 *
 * The decisions are pure functions (`driftAction`, `classifyEmbedEvent`) and
 * the class takes its clock and timers as options, so the whole thing runs
 * under test with fake transports. DOM-free.
 */
import { isRunning } from './transport';
import type { LoopRegion, Transport, TransportEvent, TransportState } from './transport';

/** A drift beyond this many seconds is corrected on the next check. */
export const DRIFT_LIMIT_S = 0.5;

/** How often the embed is compared with the engine. */
export const FOLLOW_INTERVAL_MS = 2000;

/**
 * A jump of the embed's clock counts as the person scrubbing the video only
 * when it lands this many seconds from the engine. Nearer than that it is
 * more likely a stall or jitter, which the periodic check handles.
 */
export const EMBED_SEEK_S = 1;

/**
 * A video that loops wraps by itself back to the loop's start. A move of its
 * clock that lands this close to that start is the wrap, not the person
 * scrubbing. It can come before the sound's own wrap or after it, so where
 * the sound is does not enter into it.
 */
export const LOOP_WRAP_S = 0.5;

/** After a command to the embed, its own events are ignored for this long. */
export const ECHO_MS = 800;

/** How often a sound told to play is looked at for its clock moving. */
export const CLOCK_POLL_MS = 20;

/**
 * How long that look goes on at CLOCK_POLL_MS. A clock still standing by then
 * belongs to a context that is not about to start; the periodic check keeps
 * looking, without a timer of its own.
 */
export const CLOCK_WAIT_MS = 5000;

/** A video this close to its end has not been paused by anyone. */
const END_SLACK_S = 1;

/** What a muted video needs on top of being a Transport. */
export interface FollowedEmbed extends Transport {
  /** Silences the video's own sound. */
  mute(): void;
  /** True while the video's sound is off. */
  readonly muted: boolean;
}

/** What the periodic check decides. */
export type FollowAction = 'none' | 'seek';

/** What the check looks at: both clocks and both states. */
export interface DriftInput {
  engineS: number;
  embedS: number;
  engineState: TransportState;
  embedState: TransportState;
}

/**
 * Whether the embed must be moved to the engine's position: only while both
 * play, and only when they are further apart than DRIFT_LIMIT_S either way.
 * An embed that is buffering, showing an ad or paused is not drifting, it is
 * waiting, and seeking it then would only fight the player.
 */
export function driftAction(input: DriftInput): FollowAction {
  if (input.engineState !== 'playing' || input.embedState !== 'playing') return 'none';
  return Math.abs(input.engineS - input.embedS) > DRIFT_LIMIT_S ? 'seek' : 'none';
}

/** The embed events that can mean the person used YouTube's controls. */
export type EmbedEventName = 'play' | 'pause' | 'seek';

/** A reading of one clock and state. */
interface Reading {
  state: TransportState;
  positionS: number;
}

/** What the person did in the video, in terms of the engine. */
export type EmbedAction =
  | { kind: 'play'; positionS: number }
  | { kind: 'pause' }
  | { kind: 'seek'; positionS: number };

/** Everything `classifyEmbedEvent` needs to judge one embed event. */
export interface EmbedEventContext {
  event: EmbedEventName;
  embed: Reading & { durationS: number };
  engine: Reading;
  /**
   * For a play: how long the video stood still (buffering, or showing an ad)
   * before it, in seconds. Absent or 0 when it did not.
   */
  stalledS?: number;
  /**
   * The loop the video was given, or null or absent when it has none. The
   * video wraps it by itself, so a landing at its start is that wrap.
   */
  loop?: LoopRegion | null;
}

/** True when a video's clock has run to its end, which is no one's pause. */
function hasEnded(video: { positionS: number; durationS: number }): boolean {
  return video.durationS > 0 && video.positionS >= video.durationS - END_SLACK_S;
}

/** True when `positionS` is where a video with this loop starts over. */
export function isLoopWrap(positionS: number, loop: LoopRegion | null | undefined): boolean {
  if (!loop) return false;
  return Math.abs(positionS - loop.startS) <= LOOP_WRAP_S;
}

/**
 * Turns an event from the embed into what the person did, or null when it
 * was something else. A play counts when the video is playing and the sound
 * is not; a pause when the video is really paused (not buffering, not in an
 * ad, not just ended) while the sound plays; a seek when the video's clock
 * jumped to somewhere EMBED_SEEK_S or more from the sound, unless it landed
 * at the start of the loop the video has, which is the video wrapping it.
 *
 * A scrub of the real video usually goes through buffering, and the clock guard
 * flags no jump across one, so a play that resumes a video beside a playing
 * sound is judged by where it landed, by the same two rules. A video that
 * stood still for `stalledS` seconds comes back that far behind the sound, and
 * is not scrubbed; one that comes back anywhere else, more than EMBED_SEEK_S
 * from where a stall would have left it, was moved by the person.
 */
export function classifyEmbedEvent(context: EmbedEventContext): EmbedAction | null {
  const { event, embed, engine } = context;
  switch (event) {
    case 'play': {
      if (embed.state !== 'playing') return null;
      if (engine.state !== 'playing') return { kind: 'play', positionS: embed.positionS };
      if (isLoopWrap(embed.positionS, context.loop)) return null;
      const behindS = engine.positionS - embed.positionS;
      const unexplainedS = behindS - (context.stalledS ?? 0);
      const scrubbed = Math.abs(behindS) > EMBED_SEEK_S && Math.abs(unexplainedS) > EMBED_SEEK_S;
      return scrubbed ? { kind: 'seek', positionS: embed.positionS } : null;
    }
    case 'pause': {
      if (embed.state !== 'paused' || engine.state !== 'playing') return null;
      return hasEnded(embed) ? null : { kind: 'pause' };
    }
    case 'seek': {
      if (embed.state !== 'playing' || engine.state !== 'playing') return null;
      if (isLoopWrap(embed.positionS, context.loop)) return null;
      const apart = Math.abs(embed.positionS - engine.positionS) > EMBED_SEEK_S;
      return apart ? { kind: 'seek', positionS: embed.positionS } : null;
    }
  }
}

/** What the person does in the video, applied to the app by its owner. */
export interface FollowerHooks {
  /** The video was started with its own controls. */
  play(): void;
  /** The video was paused with its own controls. */
  pause(): void;
  /** The video was moved with its own controls, or started from elsewhere. */
  seek(positionS: number): void;
}

/** The two timer calls the follower makes; the defaults are the page's. */
export interface FollowerTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const pageTimers: FollowerTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as number),
};

/** Everything the follower is built from; the clock and timers are optional. */
export interface EmbedFollowerOptions {
  /** The audio engine's transport: the master. */
  engine: Transport;
  /** The video, muted and following. */
  embed: FollowedEmbed;
  hooks: FollowerHooks;
  /** A monotonic clock in milliseconds; default `performance.now`. */
  now?: () => number;
  timers?: FollowerTimers;
}

/** A start the sound has been told to make and has not yet shown. */
interface PendingStart {
  /** Where the sound stood when told, to tell its clock moving from a seek. */
  fromS: number;
  /** True when the video was already playing: the sound joins it. */
  embedLed: boolean;
  /** When the sound was told, on `now`. */
  sinceMs: number;
}

/** Keeps a muted video in step with the engine until stopped. */
export class EmbedFollower {
  private readonly engine: Transport;
  private readonly embed: FollowedEmbed;
  private readonly hooks: FollowerHooks;
  private readonly now: () => number;
  private readonly timers: FollowerTimers;
  private readonly unsubscribe: Array<() => void> = [];
  private timer: unknown = null;
  private running = false;
  // Before this time on `now`, events from the embed are our own echo.
  private quietUntilMs = Number.NEGATIVE_INFINITY;
  // True while a hook runs, so what it does to the engine is not copied back.
  private applying = false;
  // When the video last stopped advancing (buffering, an ad), or null.
  private stalledSinceMs: number | null = null;
  // The sound's start, from its `play` until its clock is seen to move.
  private pending: PendingStart | null = null;
  private clockTimer: unknown = null;

  constructor(options: EmbedFollowerOptions) {
    this.engine = options.engine;
    this.embed = options.embed;
    this.hooks = options.hooks;
    this.now = options.now ?? (() => performance.now());
    this.timers = options.timers ?? pageTimers;
  }

  /**
   * Mutes the video and starts following; a second call does nothing. A sound
   * that is playing already is taken to be running; one that is started after
   * this is waited for (see the module note).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.embed.mute();
    this.follow(this.engine, 'play', () => this.enginePlayed());
    this.follow(this.engine, 'pause', () => this.enginePaused());
    this.follow(this.engine, 'ended', () => this.enginePaused());
    this.follow(this.engine, 'seek', () => this.engineSought());
    this.follow(this.engine, 'loop', () => this.copyLoop(this.engine.loop));
    for (const event of ['play', 'pause', 'seek'] as const) {
      this.follow(this.embed, event, () => this.embedMoved(event));
    }
    this.follow(this.embed, 'state', () => this.noteStall());
    this.noteStall();
    this.timer = this.timers.setInterval(() => this.check(), FOLLOW_INTERVAL_MS);
  }

  /** Stops following: no more commands, no more checks. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.endStart();
  }

  private follow(transport: Transport, event: TransportEvent, listener: () => void): void {
    this.unsubscribe.push(transport.on(event, listener));
  }

  /** Runs a command to the embed; its echo is ignored for a while. */
  private copy(command: () => void): void {
    if (this.applying) return;
    this.quietUntilMs = this.now() + ECHO_MS;
    command();
  }

  private copyLoop(loop: LoopRegion | null): void {
    if (!this.applying) this.embed.setLoop(loop);
  }

  /**
   * The sound was told to play. Its clock may not move for a while yet, so the
   * picture is not started, nor compared with the sound, until it does. This
   * runs for a play the person made in the video as well (it is not copied
   * back to the video, but it is waited for).
   */
  private enginePlayed(): void {
    this.endStart();
    this.pending = {
      fromS: this.engine.positionS,
      // A video still going inside the quiet that follows our own command is
      // not the person's: it was told to pause a moment ago, and will have.
      embedLed: isRunning(this.embed.state) && this.now() >= this.quietUntilMs,
      sinceMs: this.now(),
    };
    this.clockTimer = this.timers.setInterval(() => this.watchClock(), CLOCK_POLL_MS);
  }

  /** The sound paused or ended: stop waiting to start, and pause the video. */
  private enginePaused(): void {
    this.endStart();
    this.copy(() => this.embed.pause());
  }

  /** The sound was moved: move the video, and wait for the clock from there. */
  private engineSought(): void {
    // A seek moves the position at once, which is not the clock starting.
    if (this.pending) this.pending.fromS = this.engine.positionS;
    this.copy(() => this.embed.seek(this.engine.positionS));
  }

  /** Looks for the sound's clock moving since it was told to play. */
  private watchClock(): void {
    const pending = this.pending;
    if (!pending) {
      this.stopClockTimer();
      return;
    }
    if (this.engine.state !== 'playing') {
      this.endStart();
      return;
    }
    if (this.engine.positionS !== pending.fromS) {
      this.clockStarted(pending);
      return;
    }
    if (this.now() - pending.sinceMs > CLOCK_WAIT_MS) this.stopClockTimer();
  }

  /**
   * The sound's clock moved: it is going. A video that was playing before the
   * sound was told to start has nothing to be told, and if it has run ahead of
   * the sound meanwhile the sound joins it; the video is never pulled back to a
   * sound that began late. Any other picture is started from the sound, lined
   * up first if it has wandered.
   */
  private clockStarted(pending: PendingStart): void {
    this.endStart();
    const { engine, embed } = this;
    // Buffering or showing an ad at this moment is still going: pulling it back
    // to the sound for that would undo the very thing being avoided.
    if (pending.embedLed && isRunning(embed.state)) {
      if (embed.positionS - engine.positionS > DRIFT_LIMIT_S) {
        this.applying = true;
        try {
          this.hooks.seek(embed.positionS);
        } finally {
          this.applying = false;
        }
      }
      return;
    }
    this.startPicture();
  }

  /** Plays the picture from the sound, lined up first if it has wandered. */
  private startPicture(): void {
    this.copy(() => {
      const target = this.engine.positionS;
      if (Math.abs(target - this.embed.positionS) > DRIFT_LIMIT_S) this.embed.seek(target);
      this.embed.play();
    });
  }

  /** Gives up waiting for the sound to start, and its timer. */
  private endStart(): void {
    this.pending = null;
    this.stopClockTimer();
  }

  private stopClockTimer(): void {
    if (this.clockTimer !== null) this.timers.clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  /**
   * Remembers when the video stopped advancing. The transport announces a
   * return to playing before the state change that follows it, so the play
   * handler reads this before it is cleared.
   */
  private noteStall(): void {
    const waiting = this.embed.state === 'buffering' || this.embed.state === 'ad';
    if (waiting) this.stalledSinceMs ??= this.now();
    else this.stalledSinceMs = null;
  }

  /** Seconds the video stood still before now, and forgets that it did. */
  private takeStall(): number {
    const since = this.stalledSinceMs;
    this.stalledSinceMs = null;
    return since === null ? 0 : Math.max(0, this.now() - since) / 1000;
  }

  /** The video reported a change: if it is the person's, hand it on. */
  private embedMoved(event: EmbedEventName): void {
    const stalledS = event === 'play' ? this.takeStall() : 0;
    if (this.applying || this.now() < this.quietUntilMs) return;
    const { engine, embed } = this;
    const action = classifyEmbedEvent({
      event,
      embed: { state: embed.state, positionS: embed.positionS, durationS: embed.durationS },
      engine: { state: engine.state, positionS: engine.positionS },
      stalledS,
      loop: embed.loop,
    });
    if (!action) return;
    // While the sound waits to start, its position is where it was left and
    // the picture is somewhere it ran to by itself, so a gap between them says
    // nothing about the person. Only a pause is theirs for certain.
    if (this.pending && action.kind !== 'pause') return;
    this.applying = true;
    try {
      switch (action.kind) {
        case 'pause':
          this.hooks.pause();
          break;
        case 'seek':
          this.hooks.seek(action.positionS);
          break;
        case 'play': {
          // Started from somewhere else: that is where the person means to be.
          const apart = Math.abs(action.positionS - engine.positionS) > DRIFT_LIMIT_S;
          if (apart) this.hooks.seek(action.positionS);
          this.hooks.play();
          break;
        }
      }
    } finally {
      this.applying = false;
    }
  }

  /** The periodic check: keep the video silent, and on the engine's time. */
  private check(): void {
    const { engine, embed } = this;
    if (!embed.muted) embed.mute();
    // A sound still to show its clock is not compared with anything; this is
    // where a wait that outlasted its timer is picked up again.
    if (this.pending) {
      this.watchClock();
      return;
    }
    // The sound is the master. A video left playing beside a song that is not,
    // because the person's press in it fell inside an echo window, is stopped.
    if (engine.state !== 'playing' && embed.state === 'playing') {
      this.copy(() => embed.pause());
      return;
    }
    // And one left standing beside a song that plays is started again, from
    // the sound's position if it is far from it: the person's pause in the
    // video can fall inside an echo window too, and a play of ours can be lost
    // (to an ad, say). The window is waited out so a play that is on its way
    // is not sent twice. A video that ran to its end first is left there.
    const standing = embed.state === 'paused' || embed.state === 'ready';
    const quiet = this.now() >= this.quietUntilMs;
    if (engine.state === 'playing' && standing && quiet && !hasEnded(embed)) {
      this.startPicture();
      return;
    }
    const action = driftAction({
      engineS: engine.positionS,
      embedS: embed.positionS,
      engineState: engine.state,
      embedState: embed.state,
    });
    if (action === 'seek') this.copy(() => embed.seek(engine.positionS));
  }
}
