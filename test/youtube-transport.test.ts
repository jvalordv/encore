/**
 * Tests for YouTubeTransport against a fake IFrame player, a manual clock and
 * manual timers, so nothing reaches YouTube and time only moves when a test
 * says so. They cover the construction options the embed rules ask for, the
 * mapping of the player's events (its own on-page controls included) onto
 * transport state and events, the guarded clock, ad handling, the controls
 * (including the cue-instead-of-seek rule that keeps a stopped video from
 * starting itself), loops, plain-language errors, and teardown.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TrackInfo, TransportEvent } from '../src/audio/transport';
import { YT_STATE } from '../src/audio/youtube-api';
import type {
  YouTubeApi,
  YouTubePlayer,
  YouTubePlayerEvents,
  YouTubePlayerOptions,
  YouTubeVideoData,
} from '../src/audio/youtube-api';
import {
  AUTOPLAY_BLOCKED,
  EmbedClosedError,
  NOCOOKIE_HOST,
  POLL_MS,
  READY_TIMEOUT_MS,
  SETTLE_MS,
  YouTubeTransport,
  describeYouTubeError,
  domEmbedHost,
} from '../src/audio/youtube-transport';
import type { EmbedHost, EmbedMount, EmbedNotice, EmbedTimers } from '../src/audio/youtube-transport';

const VIDEO = 'dQw4w9WgXcQ';
const AD_ID = 'adadadadada';
/** Errors 101 and 150: the video may not exist, or its owner blocks apps. */
const NOT_PLAYABLE =
  'YouTube would not play that video here: it may not exist or its owner blocks other apps. Check the link.';
const ALL_EVENTS: readonly TransportEvent[] = ['load', 'play', 'pause', 'seek', 'ended', 'loop', 'state'];

/** The IFrame player as the transport sees it, with controls for the test. */
class FakePlayer implements YouTubePlayer {
  time = 0;
  duration = 0;
  ytState: number = YT_STATE.UNSTARTED;
  rate = 1;
  videoData: YouTubeVideoData = { video_id: '', title: '' };
  calls: string[] = [];
  destroyed = false;
  private readonly events: YouTubePlayerEvents;

  constructor(
    readonly target: unknown,
    readonly options: YouTubePlayerOptions,
  ) {
    this.events = options.events ?? {};
  }

  getCurrentTime(): number {
    return this.time;
  }
  getDuration(): number {
    return this.duration;
  }
  getPlayerState(): number {
    return this.ytState;
  }
  getPlaybackRate(): number {
    return this.rate;
  }
  getVideoData(): YouTubeVideoData {
    return this.videoData;
  }
  playVideo(): void {
    this.calls.push('play');
  }
  pauseVideo(): void {
    this.calls.push('pause');
  }
  seekTo(seconds: number, allowSeekAhead: boolean): void {
    this.calls.push(`seekTo:${seconds}:${allowSeekAhead}`);
  }
  cueVideoById(options: { videoId: string; startSeconds?: number }): void {
    this.calls.push(`cue:${options.videoId}:${options.startSeconds ?? 0}`);
  }
  destroy(): void {
    this.destroyed = true;
    this.calls.push('destroy');
  }

  // ---- what the page's player would do on its own ----
  fireReady(): void {
    this.events.onReady?.({ target: this });
  }
  fireState(code: number): void {
    this.ytState = code;
    this.events.onStateChange?.({ target: this, data: code });
  }
  fireError(code: number): void {
    this.events.onError?.({ target: this, data: code });
  }
  fireAutoplayBlocked(): void {
    this.events.onAutoplayBlocked?.({ target: this });
  }
}

/** Timers that run only when the test says so. */
class ManualTimers implements EmbedTimers {
  intervals = new Map<number, { callback: () => void; ms: number }>();
  timeouts = new Map<number, { callback: () => void; ms: number }>();
  private next = 1;

  setInterval(callback: () => void, ms: number): number {
    const id = this.next++;
    this.intervals.set(id, { callback, ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  setTimeout(callback: () => void, ms: number): number {
    const id = this.next++;
    this.timeouts.set(id, { callback, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }
  /** One round of the poll. */
  poll(): void {
    for (const { callback } of [...this.intervals.values()]) callback();
  }
}

/** Everything a test needs: the transport, its fake page and its probes. */
function setup(options: { origin?: string } = {}) {
  const players: FakePlayer[] = [];
  const mounts: Array<EmbedMount & { disposed: boolean }> = [];
  const api = {
    Player: class {
      constructor(target: unknown, playerOptions: YouTubePlayerOptions) {
        const player = new FakePlayer(target, playerOptions);
        players.push(player);
        return player;
      }
    },
  } as unknown as YouTubeApi;
  const host: EmbedHost = {
    mount() {
      const mount = {
        element: { id: `slot-${mounts.length}` } as unknown as HTMLElement,
        disposed: false,
        dispose() {
          mount.disposed = true;
        },
      };
      mounts.push(mount);
      return mount;
    },
  };
  const timers = new ManualTimers();
  const clock = { ms: 1000 };
  const transport = new YouTubeTransport({
    api,
    host,
    origin: options.origin ?? 'http://localhost:4173',
    now: () => clock.ms,
    timers,
  });
  const seen: TransportEvent[] = [];
  for (const event of ALL_EVENTS) transport.on(event, () => seen.push(event));
  const notices: EmbedNotice[] = [];
  transport.onNotice((notice) => notices.push(notice));
  return { transport, players, mounts, timers, clock, seen, notices };
}

/** A transport that has loaded VIDEO and is cued, title and length known. */
async function loaded(startS?: number) {
  const t = setup();
  const loading = t.transport.load(VIDEO, startS);
  const player = t.players[0];
  player.videoData = { video_id: VIDEO, title: 'Song Title' };
  player.duration = 213;
  player.time = startS ?? 0;
  player.ytState = YT_STATE.CUED;
  player.fireReady();
  const info = await loading;
  t.seen.length = 0;
  return { ...t, player, info };
}

/** Plays: the player buffers, then plays, with the clock at `fromS`. */
function startPlaying(t: Awaited<ReturnType<typeof loaded>>, fromS = 0): void {
  t.player.time = fromS;
  t.player.fireState(YT_STATE.BUFFERING);
  t.player.fireState(YT_STATE.PLAYING);
  t.seen.length = 0;
}

describe('describeYouTubeError', () => {
  it('speaks plainly for each code the IFrame API documents', () => {
    expect(describeYouTubeError(2)).toBe("That link's video id is not valid.");
    expect(describeYouTubeError(5)).toBe('The YouTube player hit an error. Reload the page and try again.');
    expect(describeYouTubeError(100)).toBe('That video is private or was removed.');
    expect(describeYouTubeError(101)).toBe(NOT_PLAYABLE);
    expect(describeYouTubeError(150)).toBe(NOT_PLAYABLE);
    expect(describeYouTubeError(153)).toBe('YouTube refused the embed because no referrer reached it.');
  });

  it('does not blame the owner for 101 and 150, which YouTube also sends for an id that does not exist', () => {
    // Seen live: a well-formed id with no video behind it comes back as 101 or
    // 150, not as the 100 the documentation gives for a missing video.
    for (const code of [101, 150]) {
      const text = describeYouTubeError(code);
      expect(text).toMatch(/may not exist/);
      expect(text).toMatch(/owner blocks other apps/);
      expect(text).toMatch(/Check the link\.$/);
    }
  });

  it('names an unknown code instead of hiding it', () => {
    expect(describeYouTubeError(42)).toBe('YouTube could not play that video (error 42).');
  });

  it('says the autoplay line the brief asks for', () => {
    expect(AUTOPLAY_BLOCKED).toBe('Press Play to start the video.');
  });
});

describe('YouTubeTransport.load', () => {
  it('builds the player in the nocookie host with the documented variables and no autoplay', async () => {
    const t = await loaded();
    expect(NOCOOKIE_HOST).toBe('https://www.youtube-nocookie.com');
    expect(t.player.options.host).toBe('https://www.youtube-nocookie.com');
    expect(t.player.options.videoId).toBe(VIDEO);
    expect(t.player.options.width).toBe('100%');
    expect(t.player.options.height).toBe('100%');
    expect(t.player.options.playerVars).toEqual({
      enablejsapi: 1,
      origin: 'http://localhost:4173',
      playsinline: 1,
      rel: 0,
      controls: 1,
    });
    // Never autoplay, and nothing called on the player while loading.
    expect(t.player.options.playerVars).not.toHaveProperty('autoplay');
    expect(t.player.calls).toEqual([]);
    expect(t.player.target).toBe(t.mounts[0].element);
  });

  it('adds a start time as an integer number of seconds', async () => {
    const t = setup();
    void t.transport.load(VIDEO, 90.7);
    expect(t.players[0].options.playerVars).toMatchObject({ start: 90 });
    const none = setup();
    void none.transport.load(VIDEO);
    expect(none.players[0].options.playerVars).not.toHaveProperty('start');
  });

  it('leaves origin out when the page has none worth sending', () => {
    for (const origin of ['', 'null']) {
      const t = setup({ origin });
      void t.transport.load(VIDEO);
      expect(t.players[0].options.playerVars).not.toHaveProperty('origin');
    }
  });

  it('resolves when the player is ready with what is known, and is then ready, not playing', async () => {
    const t = await loaded();
    const expected: TrackInfo = { name: 'Song Title', durationS: 213, hash: `yt-${VIDEO}` };
    expect(t.info).toEqual(expected);
    expect(t.transport.info).toEqual(expected);
    expect(t.transport.durationS).toBe(213);
    expect(t.transport.state).toBe('ready');
    expect(t.transport.videoId).toBe(VIDEO);
    expect(t.transport.clock).toBe('embed');
    expect(t.timers.intervals.size).toBe(1);
    expect([...t.timers.intervals.values()][0].ms).toBe(POLL_MS);
    // The ready timeout is gone once the player answered.
    expect(t.timers.timeouts.size).toBe(0);
  });

  it('starts at the start time the link asked for', async () => {
    const t = await loaded(90);
    expect(t.transport.positionS).toBe(90);
  });

  it('is empty at position 0 before the player is ready', () => {
    const t = setup();
    expect(t.transport.state).toBe('empty');
    expect(t.transport.positionS).toBe(0);
    expect(t.transport.durationS).toBe(0);
    expect(t.transport.info).toBeNull();
  });

  it('names the video by id until its title arrives, then announces the title and the length', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    const player = t.players[0];
    player.videoData = { video_id: VIDEO, title: '' };
    player.ytState = YT_STATE.CUED;
    player.fireReady();
    expect(await loading).toEqual({ name: `YouTube video ${VIDEO}`, durationS: 0, hash: `yt-${VIDEO}` });
    expect(t.transport.durationS).toBe(0);

    player.videoData = { video_id: VIDEO, title: 'Late Title' };
    player.duration = 187.4;
    t.timers.poll();
    expect(t.transport.info).toEqual({ name: 'Late Title', durationS: 187.4, hash: `yt-${VIDEO}` });
    expect(t.seen).toEqual(['load']);
  });

  it('waits for an unstarted video to cue before it resolves', async () => {
    const t = setup();
    let settled = false;
    const loading = t.transport.load(VIDEO).then((info) => {
      settled = true;
      return info;
    });
    const player = t.players[0];
    player.videoData = { video_id: VIDEO, title: 'Song Title' };
    player.duration = 213;
    player.ytState = YT_STATE.UNSTARTED;
    player.fireReady();
    await Promise.resolve();
    expect(settled).toBe(false);
    // The ready timeout gave way to the shorter settle timer.
    expect([...t.timers.timeouts.values()].map((timer) => timer.ms)).toEqual([SETTLE_MS]);
    // An "unstarted" report is not the cue.
    player.fireState(YT_STATE.UNSTARTED);
    await Promise.resolve();
    expect(settled).toBe(false);
    player.fireState(YT_STATE.CUED);
    expect(await loading).toEqual({ name: 'Song Title', durationS: 213, hash: `yt-${VIDEO}` });
    expect(t.timers.timeouts.size).toBe(0);
    expect(t.transport.state).toBe('ready');
  });

  it('rejects with the plain message, and no notice, when an unstarted video fails just after ready', async () => {
    // What a video that cannot be embedded does: ready, an error, no cue.
    const t = setup();
    const loading = t.transport.load(VIDEO);
    const player = t.players[0];
    player.videoData = { video_id: VIDEO, title: '' };
    player.ytState = YT_STATE.UNSTARTED;
    player.fireReady();
    player.fireError(150);
    await expect(loading).rejects.toThrow(NOT_PLAYABLE);
    expect(t.notices).toEqual([]);
    expect(t.timers.timeouts.size).toBe(0);
  });

  it('calls an unstarted video usable once the settle time passes with no word, and later errors are notices', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    const player = t.players[0];
    player.videoData = { video_id: VIDEO, title: 'Song Title' };
    player.duration = 213;
    player.ytState = YT_STATE.UNSTARTED;
    player.fireReady();
    const [settle] = [...t.timers.timeouts.values()];
    settle.callback();
    expect(await loading).toEqual({ name: 'Song Title', durationS: 213, hash: `yt-${VIDEO}` });
    expect(t.timers.timeouts.size).toBe(0);
    player.fireError(100);
    expect(t.notices).toEqual([{ kind: 'error', text: 'That video is private or was removed.' }]);
  });

  it('is closed by destroy while it settles', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    const player = t.players[0];
    player.ytState = YT_STATE.UNSTARTED;
    player.fireReady();
    t.transport.destroy();
    await expect(loading).rejects.toBeInstanceOf(EmbedClosedError);
    expect(t.timers.timeouts.size).toBe(0);
  });

  it('rejects with the plain message when the player errors before it is ready', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    t.players[0].fireError(150);
    await expect(loading).rejects.toThrow(NOT_PLAYABLE);
    // An error is not also delivered as a notice.
    expect(t.notices).toEqual([]);
  });

  it('rejects with the unreachable message when the player never answers', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    const [timeout] = [...t.timers.timeouts.values()];
    expect(timeout.ms).toBe(READY_TIMEOUT_MS);
    timeout.callback();
    await expect(loading).rejects.toThrow('Could not reach YouTube. Check the connection.');
  });

  it('rejects with EmbedClosedError when destroyed before it is ready', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    t.transport.destroy();
    await expect(loading).rejects.toBeInstanceOf(EmbedClosedError);
  });

  it('rejects when the player cannot even be constructed', async () => {
    const broken = new YouTubeTransport({
      api: {
        Player: class {
          constructor() {
            throw new Error('blocked');
          }
        },
      } as unknown as YouTubeApi,
      host: { mount: () => ({ element: {} as HTMLElement, dispose() {} }) },
      timers: new ManualTimers(),
    });
    await expect(broken.load(VIDEO)).rejects.toThrow('Could not reach YouTube. Check the connection.');
  });

  it('refuses a second video and a load after destroy', async () => {
    const t = await loaded();
    await expect(t.transport.load('aB3_x-Y9zQ0')).rejects.toThrow(/already has a video/);
    t.transport.destroy();
    await expect(t.transport.load(VIDEO)).rejects.toBeInstanceOf(EmbedClosedError);
  });

  it('accepts a ready event that arrives before the constructor has returned', async () => {
    // A player may fire onReady from inside its constructor, with the target.
    class EagerPlayer {
      constructor(_target: unknown, options: YouTubePlayerOptions) {
        options.events?.onReady?.({ target: this as unknown as YouTubePlayer });
      }
      getPlayerState(): number {
        return YT_STATE.CUED;
      }
      getVideoData(): YouTubeVideoData {
        return { video_id: VIDEO, title: 'Early' };
      }
      getDuration(): number {
        return 60;
      }
      destroy(): void {}
    }
    const early = new YouTubeTransport({
      api: { Player: EagerPlayer } as unknown as YouTubeApi,
      host: { mount: () => ({ element: {} as HTMLElement, dispose() {} }) },
      timers: new ManualTimers(),
    });
    expect(await early.load(VIDEO)).toEqual({ name: 'Early', durationS: 60, hash: `yt-${VIDEO}` });
    expect(early.state).toBe('ready');
    early.destroy();
  });
});

describe('YouTubeTransport state and events', () => {
  it('follows the player: buffering, playing, pause, play again, end', async () => {
    const t = await loaded();
    t.player.fireState(YT_STATE.BUFFERING);
    expect(t.transport.state).toBe('buffering');
    expect(t.seen).toEqual(['state']);

    t.seen.length = 0;
    t.player.fireState(YT_STATE.PLAYING);
    expect(t.transport.state).toBe('playing');
    expect(t.seen).toEqual(['play', 'state']);

    t.seen.length = 0;
    t.player.fireState(YT_STATE.PAUSED);
    expect(t.transport.state).toBe('paused');
    expect(t.seen).toEqual(['pause', 'state']);

    t.seen.length = 0;
    t.player.fireState(YT_STATE.PLAYING);
    expect(t.seen).toEqual(['play', 'state']);

    t.seen.length = 0;
    t.player.fireState(YT_STATE.ENDED);
    expect(t.transport.state).toBe('paused');
    expect(t.seen).toEqual(['pause', 'state', 'ended']);
  });

  it('shows changes made with YouTube\'s own controls, not only ours', async () => {
    const t = await loaded();
    // The singer clicks YouTube's play button, then its pause button.
    t.player.fireState(YT_STATE.PLAYING);
    expect(t.transport.state).toBe('playing');
    t.player.fireState(YT_STATE.PAUSED);
    expect(t.transport.state).toBe('paused');
    expect(t.player.calls).toEqual([]);
  });

  it('counts leaving play for buffering as a pause, and coming back as a play', async () => {
    const t = await loaded();
    startPlaying(t);
    t.player.fireState(YT_STATE.BUFFERING);
    expect(t.seen).toEqual(['pause', 'state']);
    t.seen.length = 0;
    t.player.fireState(YT_STATE.PLAYING);
    expect(t.seen).toEqual(['play', 'state']);
  });

  it('announces nothing when the state did not change', async () => {
    const t = await loaded();
    startPlaying(t);
    t.player.fireState(YT_STATE.PAUSED);
    expect(t.seen).toEqual(['pause', 'state']);
    t.seen.length = 0;
    t.player.fireState(YT_STATE.PAUSED);
    expect(t.seen).toEqual([]);
  });

  it('keeps a video that has never played "ready" whatever the player says about pausing', async () => {
    const t = await loaded();
    t.player.fireState(YT_STATE.PAUSED);
    expect(t.transport.state).toBe('ready');
    expect(t.seen).toEqual([]);
  });

  it('catches a state change whose event never came, on the next poll', async () => {
    const t = await loaded();
    t.player.ytState = YT_STATE.PLAYING;
    t.timers.poll();
    expect(t.transport.state).toBe('playing');
    expect(t.seen).toEqual(['play', 'state']);
  });

  it('ignores the player\'s state events before it is ready', () => {
    const t = setup();
    void t.transport.load(VIDEO);
    t.players[0].fireState(YT_STATE.PLAYING);
    expect(t.transport.state).toBe('empty');
    expect(t.seen).toEqual([]);
  });
});

describe('YouTubeTransport clock', () => {
  it('reads the player on every query, through the guard', async () => {
    const t = await loaded();
    startPlaying(t);
    t.clock.ms = 1000;
    t.player.time = 10;
    expect(t.transport.positionS).toBe(10);
    t.clock.ms = 1016;
    t.player.time = 10.016;
    expect(t.transport.positionS).toBe(10.016);
    // A 16 ms backward step is held, not reported.
    t.clock.ms = 1032;
    t.player.time = 10;
    expect(t.transport.positionS).toBe(10.016);
    t.clock.ms = 1048;
    t.player.time = 10.032;
    expect(t.transport.positionS).toBe(10.032);
    expect(t.seen).toEqual([]);
  });

  it('announces a jump as a seek, once', async () => {
    const t = await loaded();
    startPlaying(t);
    t.clock.ms = 1000;
    t.player.time = 10;
    void t.transport.positionS;
    t.clock.ms = 1016;
    t.player.time = 12.5;
    expect(t.transport.positionS).toBe(12.5);
    expect(t.seen).toEqual(['seek']);
    t.clock.ms = 1032;
    t.player.time = 12.516;
    expect(t.transport.positionS).toBe(12.516);
    expect(t.seen).toEqual(['seek']);
  });

  it('announces a stall of more than 300 ms of wall time as a seek', async () => {
    const t = await loaded();
    startPlaying(t);
    for (let ms = 0; ms <= 280; ms += 20) {
      t.clock.ms = 1000 + ms;
      t.player.time = 10 + Math.min(ms, 100) / 1000;
      void t.transport.positionS;
    }
    expect(t.seen).toEqual([]);
    t.clock.ms = 1000 + 420;
    void t.transport.positionS;
    expect(t.seen).toEqual(['seek']);
  });

  it('reports the raw value while paused or buffering', async () => {
    const t = await loaded();
    startPlaying(t);
    t.clock.ms = 1000;
    t.player.time = 10;
    void t.transport.positionS;
    t.player.fireState(YT_STATE.PAUSED);
    t.clock.ms = 1016;
    t.player.time = 9;
    expect(t.transport.positionS).toBe(9);
    t.player.time = 40;
    expect(t.transport.positionS).toBe(40);
    t.player.fireState(YT_STATE.BUFFERING);
    t.player.time = 3;
    expect(t.transport.positionS).toBe(3);
    expect(t.seen.filter((e) => e === 'seek')).toEqual([]);
  });

  it('uses the playback rate when judging the straight line', async () => {
    const t = await loaded();
    startPlaying(t);
    t.player.rate = 2;
    t.clock.ms = 1000;
    t.player.time = 10;
    void t.transport.positionS;
    t.clock.ms = 2000;
    t.player.time = 12;
    expect(t.transport.positionS).toBe(12);
    expect(t.seen).toEqual([]);
  });

  it('keeps the last position when the player gives no number', async () => {
    const t = await loaded();
    startPlaying(t);
    t.clock.ms = 1000;
    t.player.time = 10;
    expect(t.transport.positionS).toBe(10);
    t.player.time = Number.NaN;
    t.clock.ms = 1016;
    expect(t.transport.positionS).toBe(10);
  });

  it('samples the clock itself on every poll while nothing else reads it', async () => {
    const t = await loaded();
    startPlaying(t);
    t.clock.ms = 1000;
    t.player.time = 10;
    t.timers.poll();
    // A jump seen only by the poll is still announced.
    t.clock.ms = 1250;
    t.player.time = 20;
    t.timers.poll();
    expect(t.seen).toEqual(['seek']);
  });
});

describe('YouTubeTransport ads', () => {
  it('reports "ad" when the player shows another video, freezes the clock and keeps the song\'s info', async () => {
    const t = await loaded();
    startPlaying(t, 12.5);
    t.clock.ms = 1000;
    expect(t.transport.positionS).toBe(12.5);

    t.player.videoData = { video_id: AD_ID, title: 'Buy Things' };
    t.player.duration = 15;
    t.player.time = 3;
    t.timers.poll();
    expect(t.transport.state).toBe('ad');
    expect(t.seen).toEqual(['pause', 'state']);
    // The ad's own clock is not the song's.
    expect(t.transport.positionS).toBe(12.5);
    expect(t.transport.durationS).toBe(213);
    expect(t.transport.info).toEqual({ name: 'Song Title', durationS: 213, hash: `yt-${VIDEO}` });
  });

  it('notices an ad on the next position query, before any poll, and never takes its clock for the song\'s', async () => {
    const t = await loaded();
    startPlaying(t, 12.5);
    t.clock.ms = 1000;
    expect(t.transport.positionS).toBe(12.5);
    // The ad starts between two polls, and its own clock reads from zero.
    t.player.videoData = { video_id: AD_ID, title: 'Ad' };
    t.player.duration = 15;
    t.player.time = 0.04;
    t.clock.ms = 1016;
    expect(t.transport.positionS).toBe(12.5);
    expect(t.transport.state).toBe('ad');
    // The clock's drop to zero was never read as the song jumping.
    expect(t.seen).toEqual(['pause', 'state']);
  });

  it('looks for an ad on position queries only while the video is running', async () => {
    const t = await loaded();
    let reads = 0;
    t.player.getVideoData = () => {
      reads++;
      return { video_id: VIDEO, title: 'Song Title' };
    };
    t.player.time = 5;
    void t.transport.positionS;
    expect(reads).toBe(0);
    startPlaying(t, 5);
    const afterEvents = reads;
    void t.transport.positionS;
    void t.transport.positionS;
    expect(reads).toBe(afterEvents + 2);
  });

  it('goes back to playing, without a seek, when the song returns', async () => {
    const t = await loaded();
    startPlaying(t, 12.5);
    t.clock.ms = 1000;
    void t.transport.positionS;
    t.player.videoData = { video_id: AD_ID, title: 'Ad' };
    t.player.duration = 15;
    t.timers.poll();
    t.seen.length = 0;

    t.player.videoData = { video_id: VIDEO, title: 'Song Title' };
    t.player.duration = 213;
    t.player.time = 12.6;
    t.clock.ms = 6000;
    t.timers.poll();
    expect(t.transport.state).toBe('playing');
    expect(t.seen).toEqual(['play', 'state']);
    expect(t.transport.positionS).toBe(12.6);
    expect(t.seen).not.toContain('seek');
  });

  it('does not take the end of an ad for the end of the song, or restart a loop for it', async () => {
    const t = await loaded();
    startPlaying(t, 40);
    t.transport.setLoop({ startS: 30, endS: 50 });
    t.player.videoData = { video_id: AD_ID, title: 'Ad' };
    t.player.duration = 15;
    t.timers.poll();
    expect(t.transport.state).toBe('ad');
    t.seen.length = 0;
    t.player.calls.length = 0;

    // The ad finishes: the player says "ended" while it still shows the ad,
    // then again with the song back.
    t.player.fireState(YT_STATE.ENDED);
    t.player.videoData = { video_id: VIDEO, title: 'Song Title' };
    t.player.duration = 213;
    t.player.fireState(YT_STATE.ENDED);
    expect(t.seen).not.toContain('ended');
    expect(t.player.calls).toEqual([]);
    // The song carries on when the player says so.
    t.player.fireState(YT_STATE.PLAYING);
    expect(t.transport.state).toBe('playing');
    expect(t.seen).not.toContain('ended');
  });

  it('treats a changed duration as an ad even when the id still matches', async () => {
    const t = await loaded();
    startPlaying(t);
    t.player.duration = 30;
    t.timers.poll();
    expect(t.transport.state).toBe('ad');
    t.player.duration = 213;
    t.timers.poll();
    expect(t.transport.state).toBe('playing');
  });

  it('does not learn the length or title of an ad that plays before the song\'s are known', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    const player = t.players[0];
    player.videoData = { video_id: VIDEO, title: '' };
    player.duration = 0;
    player.ytState = YT_STATE.CUED;
    player.fireReady();
    await loading;
    // Play is pressed and the pre-roll starts.
    player.videoData = { video_id: AD_ID, title: 'Ad title' };
    player.duration = 15;
    player.fireState(YT_STATE.BUFFERING);
    player.fireState(YT_STATE.PLAYING);
    expect(t.transport.state).toBe('ad');
    expect(t.transport.durationS).toBe(0);
    expect(t.transport.info?.name).toBe(`YouTube video ${VIDEO}`);
    // The song begins and is learned.
    player.videoData = { video_id: VIDEO, title: 'Real Title' };
    player.duration = 240;
    t.timers.poll();
    expect(t.transport.state).toBe('playing');
    expect(t.transport.info).toEqual({ name: 'Real Title', durationS: 240, hash: `yt-${VIDEO}` });
  });

  it('does not trust an unreported id while the video is running', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    const player = t.players[0];
    player.videoData = { video_id: VIDEO, title: '' };
    player.ytState = YT_STATE.CUED;
    player.fireReady();
    await loading;
    player.videoData = { video_id: '', title: 'Something' };
    player.duration = 15;
    player.fireState(YT_STATE.PLAYING);
    expect(t.transport.durationS).toBe(0);
    expect(t.transport.info?.name).toBe(`YouTube video ${VIDEO}`);
  });

  it('leaves Play and the seek and stop controls to the ad itself', async () => {
    const t = await loaded();
    startPlaying(t);
    t.player.videoData = { video_id: AD_ID, title: 'Ad' };
    t.timers.poll();
    t.player.calls.length = 0;
    t.transport.play();
    t.transport.seek(50);
    t.transport.stop();
    expect(t.player.calls).toEqual([]);
    t.transport.pause();
    expect(t.player.calls).toEqual(['pause']);
  });
});

describe('YouTubeTransport controls', () => {
  it('play asks the player to play, and never before it is asked', async () => {
    const t = await loaded();
    expect(t.player.calls).toEqual([]);
    t.transport.play();
    expect(t.player.calls).toEqual(['play']);
  });

  it('play after the end starts again from the beginning', async () => {
    const t = await loaded();
    startPlaying(t);
    t.player.fireState(YT_STATE.ENDED);
    t.player.calls.length = 0;
    t.transport.play();
    expect(t.player.calls).toEqual(['seekTo:0:true', 'play']);
    // The old end-of-video reading is not believed while the restart lands.
    t.player.time = 213;
    expect(t.transport.positionS).toBe(0);
  });

  it('pause asks the player to pause', async () => {
    const t = await loaded();
    startPlaying(t);
    t.transport.pause();
    expect(t.player.calls).toEqual(['pause']);
  });

  it('does nothing before the player is ready or after it is destroyed', async () => {
    const t = setup();
    void t.transport.load(VIDEO);
    t.transport.play();
    t.transport.pause();
    t.transport.stop();
    t.transport.seek(5);
    expect(t.players[0].calls).toEqual([]);
    const done = await loaded();
    done.transport.destroy();
    done.player.calls.length = 0;
    done.transport.play();
    done.transport.seek(5);
    expect(done.player.calls).toEqual([]);
  });

  it('stop of a playing video pauses and rewinds, and reads "ready" once the pause lands', async () => {
    const t = await loaded();
    startPlaying(t, 40);
    t.transport.stop();
    expect(t.player.calls).toEqual(['pause', 'seekTo:0:true']);
    expect(t.seen).toContain('seek');
    t.player.fireState(YT_STATE.PAUSED);
    expect(t.transport.state).toBe('ready');
    // Whatever the stale clock says, the position is the start.
    t.player.time = 40;
    expect(t.transport.positionS).toBe(0);
  });

  it('stop of a cued video cues again at the start instead of seeking, which would play it', async () => {
    const t = await loaded(90);
    t.transport.stop();
    expect(t.player.calls).toEqual([`cue:${VIDEO}:0`]);
    expect(t.transport.state).toBe('ready');
  });

  it('seek of a paused video seeks, clamped to the video', async () => {
    const t = await loaded();
    startPlaying(t, 5);
    t.player.fireState(YT_STATE.PAUSED);
    t.player.calls.length = 0;
    t.seen.length = 0;
    t.transport.seek(60);
    t.transport.seek(9999);
    t.transport.seek(-4);
    expect(t.player.calls).toEqual(['seekTo:60:true', 'seekTo:213:true', 'seekTo:0:true']);
    expect(t.seen).toEqual(['seek', 'seek', 'seek']);
  });

  it('seek of a video that has not started re-cues it at the new time, so it stays stopped', async () => {
    const t = await loaded();
    t.transport.seek(75);
    expect(t.player.calls).toEqual([`cue:${VIDEO}:75`]);
    expect(t.transport.state).toBe('ready');
  });

  it('seek after the end also re-cues instead of replaying', async () => {
    const t = await loaded();
    startPlaying(t);
    t.player.fireState(YT_STATE.ENDED);
    t.player.calls.length = 0;
    t.transport.seek(30);
    expect(t.player.calls).toEqual([`cue:${VIDEO}:30`]);
  });

  it('believes a seek over the player\'s old reading, so seeks add up', async () => {
    const t = await loaded();
    startPlaying(t, 30);
    t.player.fireState(YT_STATE.PAUSED);
    t.clock.ms = 1000;
    t.player.time = 30;
    // The player keeps saying 30 while two nudges of +5 land.
    t.transport.seek(t.transport.positionS + 5);
    expect(t.transport.positionS).toBe(35);
    t.transport.seek(t.transport.positionS + 5);
    expect(t.transport.positionS).toBe(40);
  });

  it('goes back to the player\'s reading once it agrees with the seek, or after 1.5 s', async () => {
    const t = await loaded();
    startPlaying(t, 30);
    t.player.fireState(YT_STATE.PAUSED);
    t.clock.ms = 1000;
    t.player.time = 30;
    t.transport.seek(50);
    expect(t.transport.positionS).toBe(50);
    // The player lands 0.2 s after the target: believed from then on.
    t.player.time = 50.2;
    expect(t.transport.positionS).toBe(50.2);
    t.player.time = 51;
    expect(t.transport.positionS).toBe(51);

    // A seek the player never honours is given up on after 1.5 s.
    t.transport.seek(100);
    expect(t.transport.positionS).toBe(100);
    t.clock.ms += 1400;
    expect(t.transport.positionS).toBe(100);
    t.clock.ms += 200;
    expect(t.transport.positionS).toBe(51);
  });

  it('a seek of its own is not reported again as a jump when the player catches up', async () => {
    const t = await loaded();
    startPlaying(t, 30);
    t.clock.ms = 1000;
    void t.transport.positionS;
    t.transport.seek(100);
    t.seen.length = 0;
    t.clock.ms = 1100;
    t.player.time = 100.1;
    void t.transport.positionS;
    t.clock.ms = 1116;
    t.player.time = 100.116;
    void t.transport.positionS;
    expect(t.seen).toEqual([]);
  });
});

describe('YouTubeTransport loops', () => {
  it('takes a region, clamps it, and announces the change', async () => {
    const t = await loaded();
    t.transport.setLoop({ startS: 20, endS: 10 });
    expect(t.transport.loop).toEqual({ startS: 10, endS: 20 });
    t.transport.setLoop({ startS: 10, endS: 20 });
    t.transport.setLoop({ startS: 1, endS: 1.05 });
    expect(t.transport.loop).toBeNull();
    expect(t.seen).toEqual(['loop', 'loop']);
  });

  it('cannot be set before the length of the video is known', async () => {
    const t = setup();
    const loading = t.transport.load(VIDEO);
    t.players[0].videoData = { video_id: VIDEO, title: 'X' };
    t.players[0].ytState = YT_STATE.CUED;
    t.players[0].fireReady();
    await loading;
    t.transport.setLoop({ startS: 5, endS: 15 });
    expect(t.transport.loop).toBeNull();
  });

  it('jumps back to the start when the poll finds the clock past the end', async () => {
    const t = await loaded();
    startPlaying(t, 10);
    t.transport.setLoop({ startS: 10, endS: 20 });
    t.seen.length = 0;
    t.clock.ms = 1000;
    t.player.time = 19.9;
    t.timers.poll();
    expect(t.player.calls).toEqual([]);
    t.clock.ms = 1100;
    t.player.time = 20.05;
    t.timers.poll();
    expect(t.player.calls).toEqual(['seekTo:10:true']);
    expect(t.seen).toContain('seek');
    expect(t.transport.positionS).toBe(10);
  });

  it('does not enforce a loop while paused', async () => {
    const t = await loaded();
    startPlaying(t, 10);
    t.transport.setLoop({ startS: 10, endS: 20 });
    t.player.fireState(YT_STATE.PAUSED);
    t.player.time = 50;
    t.timers.poll();
    expect(t.player.calls).toEqual([]);
  });

  it('starts a loop over when the video ends inside it', async () => {
    const t = await loaded();
    startPlaying(t, 200);
    t.transport.setLoop({ startS: 205, endS: 213 });
    t.player.calls.length = 0;
    t.player.fireState(YT_STATE.ENDED);
    expect(t.player.calls).toEqual(['seekTo:205:true', 'play']);
    expect(t.seen).toContain('ended');
    expect(t.seen).toContain('seek');
  });
});

describe('YouTubeTransport notices', () => {
  it('delivers an error after ready as a notice and refuses to play on', async () => {
    const t = await loaded();
    t.player.fireError(150);
    expect(t.notices).toEqual([{ kind: 'error', text: NOT_PLAYABLE }]);
    t.transport.play();
    expect(t.player.calls).toEqual([]);
    expect(t.notices).toHaveLength(2);
    expect(t.notices[1].text).toBe(t.notices[0].text);
  });

  it('maps every documented code in a notice', async () => {
    for (const [code, text] of [
      [2, "That link's video id is not valid."],
      [5, 'The YouTube player hit an error. Reload the page and try again.'],
      [100, 'That video is private or was removed.'],
      [101, NOT_PLAYABLE],
      [153, 'YouTube refused the embed because no referrer reached it.'],
    ] as const) {
      const t = await loaded();
      t.player.fireError(code);
      expect(t.notices).toEqual([{ kind: 'error', text }]);
    }
  });

  it('tells the singer to press Play when the browser blocks autoplay', async () => {
    const t = await loaded();
    t.player.fireAutoplayBlocked();
    expect(t.notices).toEqual([{ kind: 'warn', text: 'Press Play to start the video.' }]);
  });

  it('stops delivering notices to a listener that unsubscribed', async () => {
    const t = await loaded();
    const heard: string[] = [];
    const off = t.transport.onNotice((n) => heard.push(n.text));
    t.player.fireAutoplayBlocked();
    off();
    t.player.fireAutoplayBlocked();
    expect(heard).toHaveLength(1);
  });
});

describe('YouTubeTransport listeners', () => {
  it('unsubscribes, and a throwing listener does not block the others', async () => {
    const t = await loaded();
    const heard: string[] = [];
    const off = t.transport.on('play', () => heard.push('a'));
    t.transport.on('play', () => {
      throw new Error('boom');
    });
    t.transport.on('play', () => heard.push('c'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.player.fireState(YT_STATE.PLAYING);
    off();
    t.player.fireState(YT_STATE.PAUSED);
    t.player.fireState(YT_STATE.PLAYING);
    quiet.mockRestore();
    expect(heard).toEqual(['a', 'c', 'c']);
  });
});

describe('YouTubeTransport.destroy', () => {
  it('tears down the player, its mount, the poll timer and every listener', async () => {
    const t = await loaded();
    startPlaying(t);
    t.transport.destroy();
    expect(t.player.destroyed).toBe(true);
    expect(t.player.calls.filter((c) => c === 'destroy')).toHaveLength(1);
    expect(t.mounts[0].disposed).toBe(true);
    expect(t.timers.intervals.size).toBe(0);
    expect(t.timers.timeouts.size).toBe(0);
    expect(t.transport.state).toBe('empty');

    // Late callbacks from the dead player change nothing and tell nobody.
    t.seen.length = 0;
    t.player.fireState(YT_STATE.PLAYING);
    t.player.fireError(150);
    t.player.fireAutoplayBlocked();
    t.player.fireReady();
    expect(t.seen).toEqual([]);
    expect(t.notices).toEqual([]);
    expect(t.transport.state).toBe('empty');
  });

  it('is safe to call twice and when the player throws on destroy', async () => {
    const t = await loaded();
    t.player.destroy = () => {
      throw new Error('already gone');
    };
    expect(() => t.transport.destroy()).not.toThrow();
    expect(() => t.transport.destroy()).not.toThrow();
    expect(t.mounts[0].disposed).toBe(true);
  });

  it('removes the iframe even if it was destroyed before the player was ready', () => {
    const t = setup();
    void t.transport.load(VIDEO).catch(() => undefined);
    t.transport.destroy();
    expect(t.players[0].destroyed).toBe(true);
    expect(t.mounts[0].disposed).toBe(true);
    expect(t.timers.timeouts.size).toBe(0);
  });
});

describe('YouTubeTransport tolerates a player that is not up yet', () => {
  it('survives methods that throw, as the API\'s do before ready', async () => {
    const t = await loaded();
    startPlaying(t);
    const boom = (): never => {
      throw new TypeError('player.getCurrentTime is not a function');
    };
    t.player.getCurrentTime = boom;
    t.player.getPlaybackRate = boom;
    t.player.getVideoData = boom;
    t.player.getDuration = boom;
    t.player.getPlayerState = boom;
    expect(() => t.timers.poll()).not.toThrow();
    expect(() => t.transport.positionS).not.toThrow();
    expect(t.transport.state).toBe('playing');
  });
});

describe('domEmbedHost', () => {
  /** A just-enough element: children, class, inert, prepend, append, remove. */
  class Node {
    className = '';
    inert = false;
    children: Node[] = [];
    parent: Node | null = null;
    readonly ownerDocument = { createElement: () => new Node() };
    append(child: Node): void {
      child.parent = this;
      this.children.push(child);
    }
    prepend(child: Node): void {
      child.parent = this;
      this.children.unshift(child);
    }
    remove(): void {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }

  /** A pane and its host, with the slots as the test sees them. */
  function pane() {
    const container = new Node();
    const host = domEmbedHost(container as unknown as HTMLElement);
    return { container, host };
  }

  it('gives each player a slot of its own, and removes only that slot', () => {
    const { container, host } = pane();
    const first = host.mount();
    const second = host.mount();
    expect(container.children).toHaveLength(2);
    expect(container.children[0].className).toBe('embed-slot');
    // The element handed to the API sits inside its slot.
    const [newer, older] = container.children;
    expect(older.children).toHaveLength(1);
    expect(older.children[0]).toBe(first.element);
    expect(newer.children[0]).toBe(second.element);

    first.dispose();
    expect(container.children).toHaveLength(1);
    expect(container.children[0].children[0]).toBe(second.element);
    second.dispose();
    expect(container.children).toHaveLength(0);
  });

  it('puts a newer player behind the one in use, out of reach, until it is gone', () => {
    const { container, host } = pane();
    const inUse = host.mount();
    const loading = host.mount();
    // The newest slot is first in the container, so the oldest paints on top.
    const [loadingSlot, inUseSlot] = container.children;
    expect(inUseSlot.children[0]).toBe(inUse.element);
    expect(loadingSlot.children[0]).toBe(loading.element);
    expect(inUseSlot.inert).toBe(false);
    expect(loadingSlot.inert).toBe(true);

    // The one in use goes: the other is in use now.
    inUse.dispose();
    expect(container.children).toEqual([loadingSlot]);
    expect(loadingSlot.inert).toBe(false);
  });

  it('leaves the one in use alone when the player behind it is closed', () => {
    const { container, host } = pane();
    const inUse = host.mount();
    const loading = host.mount();
    loading.dispose();
    expect(container.children).toHaveLength(1);
    expect(container.children[0].children[0]).toBe(inUse.element);
    expect(container.children[0].inert).toBe(false);
    // A later player waits behind it in turn.
    const next = host.mount();
    expect(container.children[0].children[0]).toBe(next.element);
    expect(container.children[0].inert).toBe(true);
    expect(container.children[1].inert).toBe(false);
  });

  it('is not confused by a slot disposed twice', () => {
    const { container, host } = pane();
    const first = host.mount();
    const second = host.mount();
    first.dispose();
    first.dispose();
    expect(container.children).toHaveLength(1);
    expect(container.children[0].inert).toBe(false);
    second.dispose();
    expect(container.children).toHaveLength(0);
  });

  it('opens the first player in front, ready for use', () => {
    const { container, host } = pane();
    host.mount();
    expect(container.children[0].inert).toBe(false);
  });
});
