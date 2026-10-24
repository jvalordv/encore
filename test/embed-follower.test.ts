/**
 * Tests for the follower that keeps a muted YouTube video in step with the
 * audio engine once a song is prepared. The two decisions are pure functions
 * and are checked as tables: when drift is corrected (more than 0.5 s, only
 * while both play, never while the video buffers or shows an ad) and which
 * events from the video count as the person using its own controls, the video
 * wrapping its own loop not among them. The class is then run against fake
 * transports, a manual clock and manual timers: what the engine does is copied
 * to the video, the video is moved by the 2 s check (and started again by it if
 * it is left paused beside a song that plays), what the person does in the
 * video goes to the hooks, the video's echo of the follower's own commands is
 * ignored, and stopping leaves nothing behind. A sound that is told to play
 * but whose clock does not move (a context still resuming) is waited for: the
 * picture does not start, and does not drag the sound after it, until it does.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOCK_POLL_MS,
  CLOCK_WAIT_MS,
  DRIFT_LIMIT_S,
  ECHO_MS,
  EMBED_SEEK_S,
  EmbedFollower,
  FOLLOW_INTERVAL_MS,
  LOOP_WRAP_S,
  classifyEmbedEvent,
  driftAction,
  isLoopWrap,
} from '../src/audio/embed-follower';
import type { EmbedEventContext, FollowerHooks, FollowerTimers } from '../src/audio/embed-follower';
import type { ClockKind, LoopRegion, TrackInfo, TransportEvent, TransportState } from '../src/audio/transport';

describe('driftAction', () => {
  const base = { engineS: 30, embedS: 30, engineState: 'playing', embedState: 'playing' } as const;

  it('leaves a video within half a second of the sound alone, ahead or behind', () => {
    expect(DRIFT_LIMIT_S).toBe(0.5);
    for (const embedS of [30, 30.3, 29.7, 30.5, 29.5]) {
      expect(driftAction({ ...base, embedS }), String(embedS)).toBe('none');
    }
  });

  it('moves a video that is more than half a second out, ahead or behind', () => {
    for (const embedS of [30.51, 29.49, 31, 25, 35, 300, 0]) {
      expect(driftAction({ ...base, embedS }), String(embedS)).toBe('seek');
    }
  });

  it('acts only while both play', () => {
    const far = { ...base, embedS: 10 };
    for (const embedState of ['paused', 'ready', 'empty', 'buffering', 'ad'] as const) {
      expect(driftAction({ ...far, embedState }), embedState).toBe('none');
    }
    for (const engineState of ['paused', 'ready', 'empty'] as const) {
      expect(driftAction({ ...far, engineState }), engineState).toBe('none');
    }
  });

  it('ignores a reading that is not a number', () => {
    expect(driftAction({ ...base, embedS: Number.NaN })).toBe('none');
    expect(driftAction({ ...base, engineS: Number.NaN })).toBe('none');
  });
});

describe('isLoopWrap', () => {
  const loop = { startS: 5, endS: 10 };

  it('is true for a landing within half a second of the loop\'s start, either side', () => {
    expect(LOOP_WRAP_S).toBe(0.5);
    for (const positionS of [5, 5.2, 4.8, 5.5, 4.5]) {
      expect(isLoopWrap(positionS, loop), String(positionS)).toBe(true);
    }
  });

  it('is false anywhere else in the loop, and outside it', () => {
    for (const positionS of [5.51, 4.49, 7, 9.9, 10, 0, 100]) {
      expect(isLoopWrap(positionS, loop), String(positionS)).toBe(false);
    }
  });

  it('is false for a video with no loop', () => {
    expect(isLoopWrap(5, null)).toBe(false);
    expect(isLoopWrap(5, undefined)).toBe(false);
  });
});

describe('classifyEmbedEvent', () => {
  function context(overrides: {
    event: EmbedEventContext['event'];
    embed?: Partial<EmbedEventContext['embed']>;
    engine?: Partial<EmbedEventContext['engine']>;
    stalledS?: number;
    loop?: EmbedEventContext['loop'];
  }): EmbedEventContext {
    return {
      event: overrides.event,
      embed: { state: 'playing', positionS: 40, durationS: 213, ...overrides.embed },
      engine: { state: 'playing', positionS: 40, ...overrides.engine },
      stalledS: overrides.stalledS,
      loop: overrides.loop,
    };
  }

  it('reads a play when the video plays and the sound does not, with the video\'s position', () => {
    for (const state of ['paused', 'ready', 'empty'] as const) {
      expect(classifyEmbedEvent(context({ event: 'play', engine: { state }, embed: { positionS: 77 } })), state).toEqual({
        kind: 'play',
        positionS: 77,
      });
    }
  });

  it('ignores a play the sound already has, and a "play" that is not playing', () => {
    expect(classifyEmbedEvent(context({ event: 'play' }))).toBeNull();
    for (const state of ['paused', 'buffering', 'ad', 'ready'] as const) {
      expect(classifyEmbedEvent(context({ event: 'play', embed: { state }, engine: { state: 'paused' } })), state).toBeNull();
    }
  });

  it('reads a video that comes back from buffering somewhere else as scrubbed', () => {
    // The sound is at 40; a stall of 0.8 s would leave the video at 39.2.
    for (const positionS of [75, 10, 41.5, 37]) {
      const resumed = context({ event: 'play', embed: { positionS }, stalledS: 0.8 });
      expect(classifyEmbedEvent(resumed), String(positionS)).toEqual({ kind: 'seek', positionS });
    }
  });

  it('does not read a video that comes back from a stall, an ad or a slow start as scrubbed', () => {
    // It stood still for 5 s, so it is 5 s behind the sound; a video that was
    // away for 15 s in an ad is 15 s behind.
    for (const [stalledS, positionS] of [
      [5, 35],
      [5, 34.5],
      [15, 25],
      [0.4, 39.6],
      [0, 40],
      [0, 39.2],
    ]) {
      const resumed = context({ event: 'play', embed: { positionS }, stalledS });
      expect(classifyEmbedEvent(resumed), `${stalledS} s: ${positionS}`).toBeNull();
    }
  });

  it('reads a video that stalled and also moved as scrubbed, and one that jumped with no stall', () => {
    expect(classifyEmbedEvent(context({ event: 'play', embed: { positionS: 20 }, stalledS: 5 }))).toEqual({
      kind: 'seek',
      positionS: 20,
    });
    expect(classifyEmbedEvent(context({ event: 'play', embed: { positionS: 20 } }))).toEqual({
      kind: 'seek',
      positionS: 20,
    });
  });

  it('reads a pause only when the video is paused while the sound plays', () => {
    expect(classifyEmbedEvent(context({ event: 'pause', embed: { state: 'paused' } }))).toEqual({ kind: 'pause' });
    // Buffering, an ad and a stop are the video leaving "playing", not a pause.
    for (const state of ['buffering', 'ad', 'ready', 'playing'] as const) {
      expect(classifyEmbedEvent(context({ event: 'pause', embed: { state } })), state).toBeNull();
    }
    expect(classifyEmbedEvent(context({ event: 'pause', embed: { state: 'paused' }, engine: { state: 'paused' } }))).toBeNull();
  });

  it('does not take the video reaching its end first for the person pausing', () => {
    const ended = { state: 'paused', positionS: 212.5 } as const;
    expect(classifyEmbedEvent(context({ event: 'pause', embed: ended }))).toBeNull();
    expect(classifyEmbedEvent(context({ event: 'pause', embed: { state: 'paused', positionS: 211 } }))).toEqual({
      kind: 'pause',
    });
    // A length not known yet cannot say the video has ended.
    expect(classifyEmbedEvent(context({ event: 'pause', embed: { ...ended, durationS: 0 } }))).toEqual({ kind: 'pause' });
  });

  it('reads a seek only when the video\'s clock lands more than a second from the sound', () => {
    expect(EMBED_SEEK_S).toBe(1);
    for (const positionS of [100, 5, 41.01, 38.99]) {
      expect(classifyEmbedEvent(context({ event: 'seek', embed: { positionS } })), String(positionS)).toEqual({
        kind: 'seek',
        positionS,
      });
    }
    // A stall or jitter lands near the sound; the check has it.
    for (const positionS of [40, 40.6, 39.2, 41, 39]) {
      expect(classifyEmbedEvent(context({ event: 'seek', embed: { positionS } })), String(positionS)).toBeNull();
    }
  });

  it('reads a seek only while both play', () => {
    const far = { positionS: 100 };
    expect(classifyEmbedEvent(context({ event: 'seek', embed: { ...far, state: 'paused' } }))).toBeNull();
    expect(classifyEmbedEvent(context({ event: 'seek', embed: { ...far, state: 'buffering' } }))).toBeNull();
    expect(classifyEmbedEvent(context({ event: 'seek', embed: far, engine: { state: 'paused' } }))).toBeNull();
  });

  describe('with the loop the video wraps by itself', () => {
    const loop = { startS: 5, endS: 10 };

    it('does not read the video\'s own wrap as a scrub, wherever the sound is', () => {
      // Before its wrap (the video ran ahead), just after it, a whole pass
      // away, and nowhere near the loop at all.
      for (const engineS of [9.8, 9.2, 5.2, 6.4, 7.5, 40]) {
        for (const positionS of [5, 5.3, 4.6, 5.5]) {
          const wrapped = context({ event: 'seek', loop, embed: { positionS }, engine: { positionS: engineS } });
          expect(classifyEmbedEvent(wrapped), `${engineS}: ${positionS}`).toBeNull();
        }
      }
    });

    it('does not read a play that follows the wrap through buffering as a scrub either', () => {
      for (const stalledS of [undefined, 0, 0.3, 2]) {
        const resumed = context({ event: 'play', loop, embed: { positionS: 5.1 }, engine: { positionS: 9.5 }, stalledS });
        expect(classifyEmbedEvent(resumed), String(stalledS)).toBeNull();
      }
    });

    it('still reads a landing anywhere else as the person moving the video', () => {
      for (const positionS of [5.51, 4.49, 7.5, 12, 100, 0]) {
        const scrubbed = context({ event: 'seek', loop, embed: { positionS }, engine: { positionS: 9.8 } });
        expect(classifyEmbedEvent(scrubbed), String(positionS)).toEqual({ kind: 'seek', positionS });
      }
      const resumed = context({ event: 'play', loop, embed: { positionS: 7.5 }, engine: { positionS: 9.5 }, stalledS: 0.3 });
      expect(classifyEmbedEvent(resumed)).toEqual({ kind: 'seek', positionS: 7.5 });
    });

    it('reads a landing at that place as a scrub when the video has no loop', () => {
      for (const noLoop of [null, undefined]) {
        const scrubbed = context({ event: 'seek', loop: noLoop, embed: { positionS: 5 }, engine: { positionS: 9.8 } });
        expect(classifyEmbedEvent(scrubbed)).toEqual({ kind: 'seek', positionS: 5 });
      }
    });

    it('leaves a play beside a sound that is not playing to start it, loop or not', () => {
      const started = context({ event: 'play', loop, embed: { positionS: 5 }, engine: { state: 'paused', positionS: 9 } });
      expect(classifyEmbedEvent(started)).toEqual({ kind: 'play', positionS: 5 });
    });
  });
});

/** A transport double: records the commands it is given and speaks like one. */
class FakeTransport {
  readonly clock: ClockKind = 'engine';
  state: TransportState = 'ready';
  positionS = 0;
  durationS = 213;
  info: TrackInfo | null = null;
  loop: LoopRegion | null = null;
  muted = false;
  readonly calls: string[] = [];
  private readonly listeners = new Map<TransportEvent, Set<() => void>>();

  on(event: TransportEvent, listener: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => void set.delete(listener);
  }
  emit(event: TransportEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  play(): void {
    this.calls.push('play');
  }
  pause(): void {
    this.calls.push('pause');
  }
  stop(): void {
    this.calls.push('stop');
  }
  // Like the real video, it announces a seek of its own at once.
  seek(positionS: number): void {
    this.calls.push(`seek:${positionS}`);
    this.positionS = positionS;
    this.emit('seek');
  }
  setLoop(region: LoopRegion | null): void {
    this.calls.push(region ? `loop:${region.startS}-${region.endS}` : 'loop:none');
    this.loop = region;
  }
  mute(): void {
    this.calls.push('mute');
    this.muted = true;
  }
}

/** Timers that run only when the test says so. */
class ManualTimers implements FollowerTimers {
  readonly intervals = new Map<number, { callback: () => void; ms: number }>();
  private next = 1;
  setInterval(callback: () => void, ms: number): number {
    const id = this.next++;
    this.intervals.set(id, { callback, ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  /** One round of the periodic check. */
  check(): void {
    this.fire(FOLLOW_INTERVAL_MS);
  }
  /** One look at the sound's clock. */
  tickClock(): void {
    this.fire(CLOCK_POLL_MS);
  }
  /** How many timers of this period are running. */
  count(ms: number): number {
    return [...this.intervals.values()].filter((timer) => timer.ms === ms).length;
  }
  private fire(ms: number): void {
    for (const timer of [...this.intervals.values()]) if (timer.ms === ms) timer.callback();
  }
}

/** A follower on fake transports; the hooks do what the Session's would. */
function setup() {
  const engine = new FakeTransport();
  const embed = new FakeTransport();
  const clock = { ms: 10_000 };
  const timers = new ManualTimers();
  const hookCalls: string[] = [];
  const hooks: FollowerHooks = {
    play: () => {
      hookCalls.push('play');
      engine.state = 'playing';
      engine.emit('play');
    },
    pause: () => {
      hookCalls.push('pause');
      engine.state = 'paused';
      engine.emit('pause');
    },
    seek: (positionS) => {
      hookCalls.push(`seek:${positionS}`);
      engine.positionS = positionS;
      engine.emit('seek');
    },
  };
  const follower = new EmbedFollower({ engine, embed, hooks, now: () => clock.ms, timers });
  return { engine, embed, clock, timers, hookCalls, hooks, follower };
}

/** Both playing together at `s`, the follower started, calls cleared. */
function following(s = 30) {
  const t = setup();
  t.engine.state = 'playing';
  t.engine.positionS = s;
  t.embed.state = 'playing';
  t.embed.positionS = s;
  t.follower.start();
  t.embed.calls.length = 0;
  return t;
}

/** The video buffers, stands still for `ms`, then plays at `positionS`. */
function bufferThenPlay(t: ReturnType<typeof following>, ms: number, positionS: number): void {
  t.embed.state = 'buffering';
  t.embed.emit('pause');
  t.embed.emit('state');
  t.clock.ms += ms;
  t.embed.state = 'playing';
  t.embed.positionS = positionS;
  // The transport announces the play before the state change that follows.
  t.embed.emit('play');
  t.embed.emit('state');
}

describe('EmbedFollower start and stop', () => {
  it('mutes the video once, and a second start changes nothing', () => {
    const t = setup();
    t.follower.start();
    t.follower.start();
    expect(t.embed.calls).toEqual(['mute']);
    expect(t.timers.intervals.size).toBe(1);
    expect([...t.timers.intervals.values()][0].ms).toBe(FOLLOW_INTERVAL_MS);
    expect(FOLLOW_INTERVAL_MS).toBe(2000);
  });

  it('sends nothing to the video before it starts', () => {
    const t = setup();
    t.engine.emit('play');
    t.engine.emit('seek');
    expect(t.embed.calls).toEqual([]);
  });

  it('stops listening to both and clears its timer', () => {
    const t = following();
    expect(t.engine.listenerCount()).toBeGreaterThan(0);
    expect(t.embed.listenerCount()).toBeGreaterThan(0);
    t.follower.stop();
    expect(t.engine.listenerCount()).toBe(0);
    expect(t.embed.listenerCount()).toBe(0);
    expect(t.timers.intervals.size).toBe(0);
    t.engine.emit('pause');
    t.embed.emit('pause');
    expect(t.embed.calls).toEqual([]);
    expect(t.hookCalls).toEqual([]);
    expect(() => t.follower.stop()).not.toThrow();
  });
});

describe('EmbedFollower copies the engine to the video', () => {
  it('plays the video when the sound plays, without a seek when they agree', () => {
    const t = setup();
    t.engine.positionS = 12;
    t.embed.positionS = 12.2;
    t.follower.start();
    t.embed.calls.length = 0;
    t.engine.state = 'playing';
    t.engine.emit('play');
    // Not before the sound's clock has moved.
    expect(t.embed.calls).toEqual([]);
    t.engine.positionS = 12.03;
    t.timers.tickClock();
    expect(t.embed.calls).toEqual(['play']);
  });

  it('lines the video up first when it has wandered, then plays it', () => {
    const t = setup();
    t.engine.positionS = 12;
    t.embed.positionS = 3;
    t.follower.start();
    t.embed.calls.length = 0;
    t.engine.state = 'playing';
    t.engine.emit('play');
    t.engine.positionS = 12.04;
    t.timers.tickClock();
    expect(t.embed.calls).toEqual(['seek:12.04', 'play']);
  });

  it('pauses the video when the sound pauses or reaches its end', () => {
    const t = following();
    t.engine.emit('pause');
    t.engine.emit('ended');
    expect(t.embed.calls).toEqual(['pause', 'pause']);
  });

  it('moves the video to where the sound was moved', () => {
    const t = following();
    t.engine.positionS = 95;
    t.engine.emit('seek');
    expect(t.embed.calls).toEqual(['seek:95']);
  });

  it('gives the video the sound\'s loop, and clears it', () => {
    const t = following();
    t.engine.loop = { startS: 10, endS: 18 };
    t.engine.emit('loop');
    t.engine.loop = null;
    t.engine.emit('loop');
    expect(t.embed.calls).toEqual(['loop:10-18', 'loop:none']);
  });

  it('copies nothing from the engine that the person\'s own action in the video caused', () => {
    const t = following();
    t.embed.state = 'paused';
    t.embed.emit('pause');
    // The hook paused the engine, which told its listeners; the video was
    // paused already, so nothing goes back to it.
    expect(t.hookCalls).toEqual(['pause']);
    expect(t.embed.calls).toEqual([]);
  });
});

describe('EmbedFollower checks every two seconds', () => {
  it('moves a video more than half a second out to the sound\'s position', () => {
    const t = following(30);
    t.embed.positionS = 31.2;
    t.timers.check();
    expect(t.embed.calls).toEqual(['seek:30']);
    t.embed.calls.length = 0;
    t.embed.positionS = 28;
    t.engine.positionS = 34;
    t.timers.check();
    expect(t.embed.calls).toEqual(['seek:34']);
  });

  it('leaves a video within half a second alone', () => {
    const t = following(30);
    t.embed.positionS = 30.4;
    t.timers.check();
    t.embed.positionS = 29.6;
    t.timers.check();
    expect(t.embed.calls).toEqual([]);
  });

  it('does not touch a video that is buffering or in an ad, however far out', () => {
    for (const state of ['buffering', 'ad'] as const) {
      const t = following(30);
      t.embed.state = state;
      t.embed.positionS = 5;
      t.timers.check();
      expect(t.embed.calls, state).toEqual([]);
    }
  });

  it('plays a video left paused beside a song that plays, as it is when it is near the sound', () => {
    const t = following(30);
    t.embed.state = 'paused';
    t.embed.positionS = 30.2;
    t.timers.check();
    expect(t.embed.calls).toEqual(['play']);
    // The sound is the master: nothing was asked of it.
    expect(t.hookCalls).toEqual([]);
  });

  it('lines a paused video up with the sound first when it is further than half a second out', () => {
    const t = following(30);
    t.embed.state = 'paused';
    t.embed.positionS = 12;
    t.timers.check();
    expect(t.embed.calls).toEqual(['seek:30', 'play']);
    expect(t.hookCalls).toEqual([]);
  });

  it('plays a video cued and never started the same way', () => {
    const t = following(30);
    t.embed.state = 'ready';
    t.embed.positionS = 0;
    t.timers.check();
    expect(t.embed.calls).toEqual(['seek:30', 'play']);
  });

  it('leaves a video alone that ran to its end before the sound did', () => {
    const t = following(212.4);
    t.embed.state = 'paused';
    t.embed.positionS = 212.9;
    t.timers.check();
    expect(t.embed.calls).toEqual([]);
    // One paused further from its end than the slack is not at it.
    t.embed.positionS = 211.2;
    t.timers.check();
    expect(t.embed.calls).toEqual(['seek:212.4', 'play']);
  });

  it('plays a video that does not take the first play again at the next check, and only then', () => {
    const t = following(30);
    t.embed.state = 'paused';
    t.timers.check();
    expect(t.embed.calls).toEqual(['play']);
    // The video\'s answer to our play may still be on its way: a check inside
    // the quiet that follows a command does not send another.
    t.clock.ms += ECHO_MS - 1;
    t.timers.check();
    expect(t.embed.calls).toEqual(['play']);
    t.clock.ms += 1;
    t.timers.check();
    expect(t.embed.calls).toEqual(['play', 'play']);
  });

  it('stops asking once the video plays', () => {
    const t = following(30);
    t.embed.state = 'paused';
    t.timers.check();
    t.clock.ms += FOLLOW_INTERVAL_MS;
    t.embed.state = 'playing';
    t.timers.check();
    expect(t.embed.calls).toEqual(['play']);
  });

  it('does not move a paused video however far from a paused song', () => {
    const t = following(30);
    t.engine.state = 'paused';
    t.embed.state = 'paused';
    t.embed.positionS = 5;
    t.timers.check();
    expect(t.embed.calls).toEqual([]);
  });

  it('never changes the playback rate: the only commands are seeks', () => {
    const t = following(30);
    for (const drift of [0.6, 1, 4, -2]) {
      t.embed.positionS = 30 + drift;
      t.timers.check();
    }
    expect(t.embed.calls.every((call) => call.startsWith('seek:'))).toBe(true);
  });

  it('pauses a video left playing beside a song that is not, and says nothing of a song that plays', () => {
    const t = following(30);
    t.timers.check();
    expect(t.embed.calls).toEqual([]);
    for (const state of ['paused', 'ready', 'empty'] as const) {
      const stopped = following(30);
      stopped.engine.state = state;
      stopped.timers.check();
      expect(stopped.embed.calls, state).toEqual(['pause']);
    }
  });

  it('leaves a paused or buffering video alone when the song is stopped', () => {
    for (const state of ['paused', 'buffering', 'ready'] as const) {
      const t = following(30);
      t.engine.state = 'paused';
      t.embed.state = state;
      t.timers.check();
      expect(t.embed.calls, state).toEqual([]);
    }
  });

  it('mutes a video the person has unmuted, and only then', () => {
    const t = following(30);
    t.timers.check();
    expect(t.embed.calls).toEqual([]);
    t.embed.muted = false;
    t.timers.check();
    expect(t.embed.calls).toEqual(['mute']);
  });
});

describe('EmbedFollower hands what the person does in the video to the hooks', () => {
  it('turns the sound on when the video is played with its own button, from where the video is', () => {
    const t = setup();
    t.engine.state = 'paused';
    t.engine.positionS = 30;
    t.follower.start();
    t.embed.calls.length = 0;
    t.embed.state = 'playing';
    t.embed.positionS = 30.2;
    t.embed.emit('play');
    expect(t.hookCalls).toEqual(['play']);
    // The hook started the engine; the video plays already, so is told nothing.
    expect(t.embed.calls).toEqual([]);
  });

  it('moves the sound to the video first when it was started from somewhere else', () => {
    const t = setup();
    t.engine.state = 'paused';
    t.engine.positionS = 30;
    t.follower.start();
    t.embed.state = 'playing';
    t.embed.positionS = 120;
    t.embed.emit('play');
    expect(t.hookCalls).toEqual(['seek:120', 'play']);
  });

  it('pauses the sound when the video is paused with its own button', () => {
    const t = following();
    t.embed.state = 'paused';
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual(['pause']);
  });

  it('does not pause the sound for the video buffering, showing an ad or reaching its end', () => {
    const t = following(212.4);
    t.embed.state = 'buffering';
    t.embed.emit('pause');
    t.embed.state = 'ad';
    t.embed.emit('pause');
    t.embed.state = 'paused';
    t.embed.positionS = 212.9;
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual([]);
  });

  it('moves the sound when the video is scrubbed far, and not for a stall', () => {
    const t = following(30);
    t.embed.positionS = 30.8;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual([]);
    t.embed.positionS = 75;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual(['seek:75']);
    // Not copied back to the video: it is already there.
    expect(t.embed.calls).toEqual([]);
  });

  it('moves the sound when the video is scrubbed through a spell of buffering', () => {
    const t = following(30);
    t.engine.positionS = 30.8;
    bufferThenPlay(t, 800, 75);
    expect(t.hookCalls).toEqual(['seek:75']);
    expect(t.embed.calls).toEqual([]);
  });

  it('leaves the sound alone when the video comes back from a stall, behind it by the stall', () => {
    const t = following(30);
    // The video stood still at 30 for four seconds while the sound went on.
    t.engine.positionS = 34;
    bufferThenPlay(t, 4000, 30);
    expect(t.hookCalls).toEqual([]);
    // The periodic check is what brings the video back.
    t.timers.check();
    expect(t.embed.calls).toEqual(['seek:34']);
  });

  it('treats an ad in the video as a stall', () => {
    const t = following(30);
    t.embed.state = 'ad';
    t.embed.emit('pause');
    t.embed.emit('state');
    t.clock.ms += 15_000;
    t.engine.positionS = 45;
    t.embed.state = 'playing';
    t.embed.positionS = 30;
    t.embed.emit('play');
    t.embed.emit('state');
    expect(t.hookCalls).toEqual([]);
  });

  it('counts a stall from the moment it began, and a second one afresh', () => {
    const t = following(30);
    t.engine.positionS = 32;
    bufferThenPlay(t, 2000, 30);
    expect(t.hookCalls).toEqual([]);
    // A second stall of 3 s: 3 s more behind, which is also explained.
    t.engine.positionS = 36;
    bufferThenPlay(t, 3000, 32);
    expect(t.hookCalls).toEqual([]);
    // Resumed with no stall at all, a video 4 s behind was moved.
    t.embed.positionS = 32;
    t.embed.emit('play');
    expect(t.hookCalls).toEqual(['seek:32']);
  });

  it('counts a stall that was already going when it started following', () => {
    const t = setup();
    t.engine.state = 'playing';
    t.engine.positionS = 30;
    t.embed.state = 'buffering';
    t.follower.start();
    t.clock.ms += 3000;
    t.engine.positionS = 33;
    t.embed.state = 'playing';
    t.embed.positionS = 30;
    t.embed.emit('play');
    expect(t.hookCalls).toEqual([]);
  });

  it('forgets a stall that ended in a pause', () => {
    const t = following(30);
    t.embed.state = 'buffering';
    t.embed.emit('state');
    t.clock.ms += 5000;
    t.embed.state = 'paused';
    t.embed.emit('state');
    t.clock.ms += 5000;
    // Played again beside a sound that went on; no stall explains the gap.
    t.engine.positionS = 40;
    t.embed.state = 'playing';
    t.embed.positionS = 30;
    t.embed.emit('play');
    expect(t.hookCalls).toEqual(['seek:30']);
  });

  it('does not take what a hook does to the video for the person using it', () => {
    const t = following(30);
    // A hook that moves the video (the video announces its own seek at once)
    // is not the person scrubbing, and must not start another hook.
    const pause = t.hooks.pause;
    t.hooks.pause = () => {
      pause();
      // As if the sound went on and the video jumped, mid-hook.
      t.engine.state = 'playing';
      t.embed.state = 'playing';
      t.embed.positionS = 90;
      t.embed.emit('seek');
    };
    t.engine.state = 'playing';
    t.embed.state = 'paused';
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual(['pause']);
  });

  it('gives the hooks no chance to start a loop of commands', () => {
    const t = following(30);
    t.embed.positionS = 75;
    t.embed.emit('seek');
    t.embed.state = 'paused';
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual(['seek:75', 'pause']);
    expect(t.embed.calls).toEqual([]);
  });
});

describe('EmbedFollower ignores the video\'s echo of its own commands', () => {
  it('does not take the pause that follows a command for the person pausing', () => {
    const t = following(30);
    // The person pauses and plays again at once; YouTube reports the pause
    // late, after the play was sent.
    t.engine.emit('pause');
    t.clock.ms += 200;
    t.engine.state = 'playing';
    t.engine.emit('play');
    t.clock.ms += 300;
    t.embed.state = 'paused';
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual([]);
  });

  it('does not take its own seek, announced by the video at once, for the person scrubbing', () => {
    const t = following(30);
    t.engine.positionS = 95;
    t.engine.emit('seek');
    // The fake video announced the seek synchronously, as the real one does.
    expect(t.hookCalls).toEqual([]);
    expect(t.embed.calls).toEqual(['seek:95']);
  });

  it('listens again once the echo window has passed', () => {
    expect(ECHO_MS).toBe(800);
    const t = following(30);
    t.engine.emit('pause');
    t.embed.state = 'paused';
    t.engine.state = 'playing';
    t.clock.ms += ECHO_MS - 1;
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual([]);
    t.clock.ms += 1;
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual(['pause']);
  });

  it('gives its own drift correction the same quiet', () => {
    const t = following(30);
    t.embed.positionS = 36;
    t.timers.check();
    t.embed.positionS = 90;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual([]);
  });

  it('does not leave the picture frozen beside a sound that plays on when a pause falls in the quiet', () => {
    const t = setup();
    t.engine.state = 'paused';
    t.engine.positionS = 30;
    t.embed.positionS = 30;
    t.follower.start();
    t.embed.calls.length = 0;
    // The sound starts and the video is told to play. 300 ms on, the person
    // pauses it with its own button: inside the quiet, so it passes unheard.
    t.engine.state = 'playing';
    t.engine.emit('play');
    t.engine.positionS = 30.03;
    t.timers.tickClock();
    t.clock.ms += 300;
    t.embed.state = 'paused';
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual([]);
    expect(t.embed.calls).toEqual(['play']);
    // A check still inside the quiet waits; the first one after it finds the
    // sound going and the picture not, and the sound is the master.
    t.clock.ms += 400;
    t.timers.check();
    expect(t.embed.calls).toEqual(['play']);
    t.clock.ms += FOLLOW_INTERVAL_MS;
    t.timers.check();
    expect(t.embed.calls).toEqual(['play', 'play']);
    expect(t.hookCalls).toEqual([]);
    expect(t.engine.state).toBe('playing');
  });

  it('hears a pause made in the video once the quiet is over, as before', () => {
    const t = setup();
    t.engine.state = 'paused';
    t.engine.positionS = 30;
    t.follower.start();
    t.engine.state = 'playing';
    t.engine.emit('play');
    t.clock.ms += ECHO_MS;
    t.embed.state = 'paused';
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual(['pause']);
    // The sound is paused too now, so the check has nothing to put right.
    t.embed.calls.length = 0;
    t.clock.ms += FOLLOW_INTERVAL_MS;
    t.timers.check();
    expect(t.embed.calls).toEqual([]);
  });
});

describe('EmbedFollower and the loop the video wraps by itself', () => {
  /** Both playing, the loop set on the engine and handed on to the video. */
  function looping(engineS: number, embedS: number, loop: LoopRegion) {
    const t = following(engineS);
    t.embed.positionS = embedS;
    t.engine.loop = loop;
    t.engine.emit('loop');
    expect(t.embed.calls).toEqual([`loop:${loop.startS}-${loop.endS}`]);
    return t;
  }

  it('does not pull the sound back when the video, a little ahead of it, wraps first', () => {
    // Loop 5..10. The sound is at 9.8 and the video 0.3 s ahead of it, which is
    // inside the drift that is allowed. The video reaches the end first and
    // seeks itself to the start; the transport announces that as a seek.
    const t = looping(9.8, 10.1, { startS: 5, endS: 10 });
    t.embed.seek(5);
    expect(t.hookCalls).toEqual([]);
    expect(t.engine.positionS).toBe(9.8);
    // And the follower sent the video nothing in answer.
    expect(t.embed.calls).toEqual(['loop:5-10', 'seek:5']);
  });

  it('does the same on every pass and anywhere in the song', () => {
    const t = looping(19.7, 20, { startS: 10, endS: 20 });
    t.embed.seek(10);
    expect(t.hookCalls).toEqual([]);
    expect(t.engine.positionS).toBe(19.7);
    // The sound wraps without a word and both go round again.
    t.engine.positionS = 19.8;
    t.embed.positionS = 20.1;
    t.embed.seek(10);
    expect(t.hookCalls).toEqual([]);
    expect(t.engine.positionS).toBe(19.8);
  });

  it('does not take the video wrapping after the sound did for the person scrubbing', () => {
    // The sound wrapped first and is 1.3 s into its next pass; the video, that
    // far behind it, wraps now.
    const t = looping(6.3, 9.9, { startS: 5, endS: 10 });
    t.embed.seek(5);
    expect(t.hookCalls).toEqual([]);
  });

  it('does not take the wrap for a scrub when the video comes back through buffering', () => {
    const t = looping(9.7, 10, { startS: 5, endS: 10 });
    t.embed.seek(5);
    bufferThenPlay(t, 300, 5);
    expect(t.hookCalls).toEqual([]);
  });

  it('still moves the sound when the video is scrubbed elsewhere in the loop, or out of it', () => {
    const t = looping(6, 6, { startS: 5, endS: 10 });
    t.embed.positionS = 8;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual(['seek:8']);
    t.embed.positionS = 100;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual(['seek:8', 'seek:100']);
  });

  it('reads a landing at that place as a scrub when the sound has no loop, or no longer has', () => {
    const t = following(40);
    t.embed.positionS = 5;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual(['seek:5']);

    const cleared = looping(9.8, 10.1, { startS: 5, endS: 10 });
    cleared.engine.loop = null;
    cleared.engine.emit('loop');
    expect(cleared.embed.loop).toBeNull();
    cleared.embed.seek(5);
    expect(cleared.hookCalls).toEqual(['seek:5']);
  });

  it('keeps the periodic check for the video drifting from the sound within a loop', () => {
    const t = looping(7, 7, { startS: 5, endS: 10 });
    t.embed.positionS = 8;
    t.timers.check();
    expect(t.embed.calls).toEqual(['loop:5-10', 'seek:7']);
  });
});

describe('EmbedFollower and a sound that is slow to start', () => {
  /**
   * The sound told to play from `s`, its clock not yet moving, beside a video
   * in `embedState` at `embedS`. The follower was started with the sound idle.
   */
  function starting(options: { s?: number; embedState?: TransportState; embedS?: number } = {}) {
    const { s = 30, embedState = 'paused', embedS = s } = options;
    const t = setup();
    t.engine.positionS = s;
    t.embed.state = embedState;
    t.embed.positionS = embedS;
    t.follower.start();
    t.embed.calls.length = 0;
    t.engine.state = 'playing';
    t.engine.emit('play');
    return t;
  }

  /** Time passes with the sound's clock standing still, as the poll sees it. */
  function waitFor(t: ReturnType<typeof starting>, ms: number): void {
    for (let spent = 0; spent < ms; spent += CLOCK_POLL_MS) {
      t.clock.ms += CLOCK_POLL_MS;
      t.timers.tickClock();
    }
  }

  it("looks at the sound's clock every 20 ms from its play, and from nothing else", () => {
    expect(CLOCK_POLL_MS).toBe(20);
    const t = setup();
    t.follower.start();
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(0);
    t.engine.state = 'playing';
    t.engine.emit('play');
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(1);
    // A play heard twice is still one wait.
    t.engine.emit('play');
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(1);
  });

  it('holds the picture while the sound stands still, and plays it once the sound moves', () => {
    const t = starting({ embedState: 'paused' });
    waitFor(t, 1500);
    expect(t.embed.calls).toEqual([]);
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    expect(t.embed.calls).toEqual(['play']);
    // Nothing is left to look at once it has moved.
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(0);
  });

  it('starts the picture from the sound, lined up first, when the picture was not going', () => {
    const t = starting({ embedState: 'paused', embedS: 10 });
    waitFor(t, 200);
    t.engine.positionS = 30.03;
    t.timers.tickClock();
    expect(t.embed.calls).toEqual(['seek:30.03', 'play']);
    expect(t.hookCalls).toEqual([]);
  });

  it('does not take a picture that ran on beside a standing sound for the person scrubbing it', () => {
    // The video plays by itself while the sound's clock does not move, and two
    // seconds on it is more than a second from the sound: what a scrub looks
    // like, were the sound's clock to be believed.
    const t = starting({ embedState: 'playing', s: 30, embedS: 30 });
    t.clock.ms += 2000;
    t.embed.positionS = 32;
    t.embed.emit('seek');
    t.embed.emit('play');
    t.embed.emit('state');
    expect(t.hookCalls).toEqual([]);
    expect(t.engine.positionS).toBe(30);
  });

  it('would have taken it for one had the sound been running', () => {
    // The same picture and sound once the sound's clock has moved to 30.02, 2 s
    // behind the picture: the rule the wait above stands in for.
    const t = starting({ embedState: 'playing', s: 30, embedS: 30 });
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    t.clock.ms += 2000;
    t.embed.positionS = 32;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual(['seek:32']);
  });

  it('joins a picture that was going and has run ahead: the sound takes up where it is', () => {
    const t = starting({ embedState: 'playing', s: 30, embedS: 30 });
    waitFor(t, 1000);
    t.embed.positionS = 31.1;
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    expect(t.hookCalls).toEqual(['seek:31.1']);
    // The picture is not pulled back, and is told nothing.
    expect(t.embed.calls).toEqual([]);
    expect(t.engine.positionS).toBe(31.1);
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(0);
  });

  it("joins a picture that is buffering when the sound's clock starts, as one that plays", () => {
    const t = starting({ embedState: 'playing', s: 30, embedS: 30 });
    waitFor(t, 1000);
    // A spell of buffering is the video's, not a reason to pull it back.
    t.embed.state = 'buffering';
    t.embed.positionS = 31.2;
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    expect(t.hookCalls).toEqual(['seek:31.2']);
    expect(t.embed.calls).toEqual([]);
  });

  it('counts a picture buffering or in an ad when the sound is told to play as going', () => {
    for (const embedState of ['buffering', 'ad'] as const) {
      const t = starting({ embedState, s: 30, embedS: 30 });
      t.embed.positionS = 31.4;
      t.engine.positionS = 30.02;
      t.timers.tickClock();
      expect(t.hookCalls, embedState).toEqual(['seek:31.4']);
      expect(t.embed.calls, embedState).toEqual([]);
    }
  });

  it('leaves a picture that was going alone when it is no more than half a second ahead', () => {
    const t = starting({ embedState: 'playing', s: 30, embedS: 30 });
    t.embed.positionS = 30.4;
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    // Nothing for the sound to join and nothing to tell a picture that plays.
    expect(t.hookCalls).toEqual([]);
    expect(t.embed.calls).toEqual([]);
  });

  it('does not join a picture that is behind the sound, and leaves it to the periodic check', () => {
    const t = starting({ embedState: 'playing', s: 30, embedS: 30 });
    t.embed.positionS = 28;
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    expect(t.hookCalls).toEqual([]);
    expect(t.embed.calls).toEqual([]);
    t.timers.check();
    expect(t.embed.calls).toEqual(['seek:30.02']);
  });

  it('hears a pause made in the video just after it played: it sent the video nothing to echo', () => {
    const t = setup();
    t.engine.state = 'paused';
    t.engine.positionS = 30;
    t.follower.start();
    t.embed.calls.length = 0;
    t.embed.state = 'playing';
    t.embed.positionS = 30.1;
    t.embed.emit('play');
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    expect(t.embed.calls).toEqual([]);
    t.clock.ms += 100;
    t.embed.state = 'paused';
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual(['play', 'pause']);
  });

  it('does not join a picture that was not going, however far it has wandered', () => {
    const t = starting({ embedState: 'paused', s: 30, embedS: 30 });
    t.embed.positionS = 80;
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    expect(t.hookCalls).toEqual([]);
    expect(t.embed.calls).toEqual(['seek:30.02', 'play']);
  });

  it('joins a picture the person played, the sound they started from it being the one waited for', () => {
    const t = setup();
    t.engine.state = 'paused';
    t.engine.positionS = 30;
    t.follower.start();
    t.embed.calls.length = 0;
    // The person plays the video with its own button; the hook starts the sound
    // (whose clock stands) and the video runs on.
    t.embed.state = 'playing';
    t.embed.positionS = 30.1;
    t.embed.emit('play');
    expect(t.hookCalls).toEqual(['play']);
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(1);
    t.clock.ms += 1000;
    t.embed.positionS = 31.2;
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    expect(t.hookCalls).toEqual(['play', 'seek:31.2']);
    expect(t.embed.calls).toEqual([]);
  });

  it('starts a picture it paused a moment ago, however it still reads', () => {
    const t = following(30);
    t.engine.state = 'paused';
    t.engine.emit('pause');
    expect(t.embed.calls).toEqual(['pause']);
    // The video has not yet said that it paused, so it still reads as playing:
    // that is not the person's doing, and it is not left alone.
    t.clock.ms += 200;
    t.engine.state = 'playing';
    t.engine.emit('play');
    t.engine.positionS = 30.03;
    t.timers.tickClock();
    expect(t.embed.calls).toEqual(['pause', 'play']);
    expect(t.hookCalls).toEqual([]);
  });

  it('hears a pause made in the video while the sound waits, and stops waiting', () => {
    const t = starting({ embedState: 'playing' });
    t.embed.state = 'paused';
    t.embed.emit('pause');
    expect(t.hookCalls).toEqual(['pause']);
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(0);
  });

  it('stops waiting when the sound pauses or ends, and starts no picture after', () => {
    for (const event of ['pause', 'ended'] as const) {
      const t = starting();
      t.engine.state = 'paused';
      t.engine.emit(event);
      expect(t.timers.count(CLOCK_POLL_MS), event).toBe(0);
      t.engine.positionS = 40;
      t.timers.tickClock();
      expect(t.embed.calls, event).toEqual(['pause']);
    }
  });

  it('stops waiting if the sound is found not to be playing, without an event to say so', () => {
    const t = starting();
    t.engine.state = 'paused';
    t.timers.tickClock();
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(0);
    expect(t.embed.calls).toEqual([]);
  });

  it('does not take a seek of the sound for its clock moving', () => {
    const t = starting();
    t.engine.positionS = 80;
    t.engine.emit('seek');
    expect(t.embed.calls).toEqual(['seek:80']);
    t.timers.tickClock();
    expect(t.embed.calls).toEqual(['seek:80']);
    t.engine.positionS = 80.02;
    t.timers.tickClock();
    expect(t.embed.calls).toEqual(['seek:80', 'play']);
  });

  it('listens to what the person does in the video once the sound is going', () => {
    const t = starting({ embedState: 'paused' });
    t.engine.positionS = 30.02;
    t.timers.tickClock();
    // Past the quiet that follows its own play.
    t.clock.ms += ECHO_MS;
    t.embed.state = 'playing';
    t.embed.positionS = 90;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual(['seek:90']);
  });

  it('leaves the periodic check nothing to correct while the sound waits', () => {
    const t = starting({ embedState: 'playing', s: 30, embedS: 30 });
    t.embed.positionS = 33;
    t.timers.check();
    expect(t.embed.calls).toEqual([]);
    expect(t.hookCalls).toEqual([]);
    // A video that is paused beside it is not started by the check either.
    const idle = starting({ embedState: 'paused' });
    idle.timers.check();
    expect(idle.embed.calls).toEqual([]);
  });

  it('still mutes an unmuted video at the periodic check while the sound waits', () => {
    const t = starting({ embedState: 'playing' });
    t.embed.muted = false;
    t.timers.check();
    expect(t.embed.calls).toEqual(['mute']);
  });

  it('stops looking after CLOCK_WAIT_MS, and the periodic check picks the wait up', () => {
    expect(CLOCK_WAIT_MS).toBe(5000);
    const t = starting({ embedState: 'paused' });
    waitFor(t, CLOCK_WAIT_MS);
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(1);
    waitFor(t, CLOCK_POLL_MS);
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(0);
    // The check finds it standing still and leaves everything alone...
    t.timers.check();
    expect(t.embed.calls).toEqual([]);
    // ...and finds it going, when it does, and starts the picture.
    t.engine.positionS = 30.2;
    t.timers.check();
    expect(t.embed.calls).toEqual(['play']);
    expect(t.hookCalls).toEqual([]);
  });

  it('clears its look at the clock when it is stopped', () => {
    const t = starting();
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(1);
    t.follower.stop();
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(0);
    expect(t.timers.intervals.size).toBe(0);
    t.engine.positionS = 31;
    t.timers.tickClock();
    expect(t.embed.calls).toEqual([]);
  });

  it('takes a sound that plays when it starts following to be running', () => {
    const t = following(30);
    expect(t.timers.count(CLOCK_POLL_MS)).toBe(0);
    // So the video is compared with it at once.
    t.embed.positionS = 75;
    t.embed.emit('seek');
    expect(t.hookCalls).toEqual(['seek:75']);
  });
});
