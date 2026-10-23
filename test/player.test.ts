/**
 * Unit tests for the player. The transport maths (seek clamping, loop wrap,
 * clock-derived position, per-stem scheduling plans, hashing) are pure
 * functions checked against known answers. The Player class is then driven
 * through a fake AudioContext that records every source it is asked to start,
 * so scheduling, sync, loop and end-of-song behaviour are checked without a
 * browser.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../src/audio/engine';
import {
  Player,
  clampSeek,
  copyOverlap,
  fnv1aHex,
  hashBytes,
  normaliseLoop,
  planSource,
  songTimeAt,
  wrapLoop,
} from '../src/audio/player';
import type { PlayerEvent } from '../src/audio/player';

describe('clampSeek', () => {
  it('keeps in-range positions and clamps both ends', () => {
    expect(clampSeek(12.5, 60)).toBe(12.5);
    expect(clampSeek(-3, 60)).toBe(0);
    expect(clampSeek(61, 60)).toBe(60);
    expect(clampSeek(Number.POSITIVE_INFINITY, 60)).toBe(60);
  });

  it('treats NaN and an empty song as zero', () => {
    expect(clampSeek(Number.NaN, 60)).toBe(0);
    expect(clampSeek(5, 0)).toBe(0);
    expect(clampSeek(5, -1)).toBe(0);
  });
});

describe('wrapLoop', () => {
  const loop = { startS: 10, endS: 20 };

  it('only clamps when there is no loop', () => {
    expect(wrapLoop(25, null, 60)).toBe(25);
    expect(wrapLoop(70, null, 60)).toBe(60);
    expect(wrapLoop(-1, null, 60)).toBe(0);
  });

  it('leaves positions before the loop end alone, lead-in included', () => {
    expect(wrapLoop(3, loop, 60)).toBe(3);
    expect(wrapLoop(10, loop, 60)).toBe(10);
    expect(wrapLoop(19.99, loop, 60)).toBeCloseTo(19.99, 9);
  });

  it('wraps to the loop start exactly at the end', () => {
    expect(wrapLoop(20, loop, 60)).toBe(10);
  });

  it('wraps repeatedly for an ever-growing clock reading', () => {
    expect(wrapLoop(25, loop, 60)).toBeCloseTo(15, 9);
    expect(wrapLoop(30, loop, 60)).toBeCloseTo(10, 9);
    expect(wrapLoop(47.5, loop, 60)).toBeCloseTo(17.5, 9);
  });

  it('ignores a degenerate loop and clips a loop end past the song', () => {
    expect(wrapLoop(25, { startS: 20, endS: 20 }, 60)).toBe(25);
    expect(wrapLoop(65, { startS: 50, endS: 80 }, 60)).toBe(55);
  });
});

describe('songTimeAt', () => {
  it('advances one song second per context second from the anchor', () => {
    expect(songTimeAt(5, 5, 12)).toBe(12);
    expect(songTimeAt(7.5, 5, 12)).toBe(14.5);
  });

  it('extrapolates backwards before the anchor', () => {
    expect(songTimeAt(4, 5, 12)).toBe(11);
  });
});

describe('normaliseLoop', () => {
  it('orders reversed ends and clamps into the song', () => {
    expect(normaliseLoop({ startS: 20, endS: 10 }, 60)).toEqual({ startS: 10, endS: 20 });
    expect(normaliseLoop({ startS: -5, endS: 100 }, 60)).toEqual({ startS: 0, endS: 60 });
  });

  it('rejects loops shorter than 0.1 s and non-numbers', () => {
    expect(normaliseLoop({ startS: 1, endS: 1.05 }, 60)).toBeNull();
    expect(normaliseLoop({ startS: 59, endS: 90 }, 59.05)).toBeNull();
    expect(normaliseLoop({ startS: Number.NaN, endS: 5 }, 60)).toBeNull();
    expect(normaliseLoop({ startS: 1, endS: 1.5 }, 60)).toEqual({ startS: 1, endS: 1.5 });
  });
});

describe('planSource', () => {
  it('starts at the song position in an aligned stem', () => {
    expect(planSource(5, 0, 60, null)).toEqual({
      delayS: 0,
      offsetS: 5,
      loop: null,
      sliceFromS: null,
    });
  });

  it('delays a stem that begins later than the playhead', () => {
    expect(planSource(1, 2.5, 30, null)).toMatchObject({ delayS: 1.5, offsetS: 0 });
  });

  it('skips into a stem whose sample 0 sits before song time 0', () => {
    expect(planSource(0, -0.1, 30, null)).toMatchObject({ delayS: 0, offsetS: 0.1 });
  });

  it('has nothing to play once past the end of a short stem', () => {
    expect(planSource(40, 5, 30, null)).toBeNull();
  });

  it('shifts native loop points into the stem time when it covers the loop', () => {
    const plan = planSource(12, 2, 60, { startS: 10, endS: 20 });
    expect(plan).toEqual({
      delayS: 0,
      offsetS: 10,
      loop: { startS: 8, endS: 18 },
      sliceFromS: null,
    });
  });

  it('plays on without looping when the run starts past the loop end', () => {
    expect(planSource(25, 0, 60, { startS: 10, endS: 20 })).toMatchObject({
      offsetS: 25,
      loop: null,
    });
  });

  it('pads a stem that starts inside the loop so wraps stay aligned', () => {
    const plan = planSource(0, 0.08, 30, { startS: 0, endS: 5 });
    expect(plan).toEqual({
      delayS: 0,
      offsetS: 0,
      loop: { startS: 0, endS: 5 },
      sliceFromS: 0,
    });
  });

  it('keeps the lead-in before the loop when it pads', () => {
    const plan = planSource(3, 0, 15, { startS: 10, endS: 20 });
    expect(plan).toEqual({
      delayS: 0,
      offsetS: 0,
      loop: { startS: 7, endS: 17 },
      sliceFromS: 3,
    });
  });

  it('plays nothing for a stem that never overlaps the loop', () => {
    expect(planSource(12, 30, 10, { startS: 10, endS: 20 })).toBeNull();
    expect(planSource(12, 0, 5, { startS: 10, endS: 20 })).toBeNull();
  });
});

describe('copyOverlap', () => {
  it('copies the overlapping part and leaves the rest zero', () => {
    const src = Float32Array.of(1, 2, 3);
    const early = new Float32Array(5);
    copyOverlap(early, src, -2);
    expect(Array.from(early)).toEqual([0, 0, 1, 2, 3]);
    const late = new Float32Array(5);
    copyOverlap(late, src, 2);
    expect(Array.from(late)).toEqual([3, 0, 0, 0, 0]);
    const none = new Float32Array(3);
    copyOverlap(none, src, 10);
    copyOverlap(none, src, -10);
    expect(Array.from(none)).toEqual([0, 0, 0]);
  });
});

describe('hashing', () => {
  const abc = new TextEncoder().encode('abc');

  it('matches the published FNV-1a vectors', () => {
    expect(fnv1aHex(new Uint8Array(0))).toBe('811c9dc5');
    expect(fnv1aHex(new TextEncoder().encode('a'))).toBe('e40c292c');
    expect(fnv1aHex(new TextEncoder().encode('foobar'))).toBe('bf9cf968');
  });

  it('matches the published sha256 vector via crypto.subtle', async () => {
    expect(await hashBytes(abc)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('falls back to FNV-1a when subtle is missing or throws', async () => {
    expect(await hashBytes(abc, null)).toBe(fnv1aHex(abc));
    const broken = { digest: () => Promise.reject(new Error('insecure context')) };
    expect(await hashBytes(abc, broken)).toBe(fnv1aHex(abc));
  });
});

// ---------------------------------------------------------------------------
// Player against a fake AudioContext

class FakeParam {
  value = 1;
  targets: number[] = [];
  setTargetAtTime(v: number): void {
    this.targets.push(v);
  }
}

class FakeGain {
  gain = new FakeParam();
  connectedTo: unknown = null;
  connect(node: unknown): void {
    this.connectedTo = node;
  }
  disconnect(): void {
    this.connectedTo = null;
  }
}

class FakeBuffer {
  data: Float32Array[];
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    return this.data[c];
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  starts: { when: number; offset: number }[] = [];
  stops: number[] = [];
  dest: unknown = null;
  connect(node: unknown): void {
    this.dest = node;
  }
  disconnect(): void {
    this.dest = null;
  }
  start(when: number, offset: number): void {
    this.starts.push({ when, offset });
  }
  stop(when: number): void {
    this.stops.push(when);
  }
}

const RATE = 100; // tiny rate keeps slice buffers small

class FakeContext {
  currentTime = 0;
  state = 'suspended';
  sources: FakeSource[] = [];
  decoded: FakeBuffer = new FakeBuffer(2, 60 * RATE, RATE);
  decodeFails = false;
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    return new FakeBuffer(channels, length, rate);
  }
  async decodeAudioData(): Promise<FakeBuffer> {
    if (this.decodeFails) throw new Error('EncodingError');
    return this.decoded;
  }
}

const LEAD = 0.03; // the player's start lead; tests read it back from sources

function setup() {
  const ctx = new FakeContext();
  const master = { id: 'master' };
  const engine = {
    context: ctx,
    master,
    now: () => ctx.currentTime,
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
  };
  const player = new Player(engine as unknown as AudioEngine);
  const events: PlayerEvent[] = [];
  for (const e of ['load', 'play', 'pause', 'seek', 'ended', 'loop', 'stems'] as const) {
    player.on(e, () => events.push(e));
  }
  /** Sources started since the given index, in creation order. */
  const sourcesFrom = (i: number) => ctx.sources.slice(i);
  return { ctx, engine, master, player, events, sourcesFrom };
}

async function loaded(durationS = 60) {
  const t = setup();
  t.ctx.decoded = new FakeBuffer(2, durationS * RATE, RATE);
  await t.player.load(new Blob([new TextEncoder().encode('abc')]), 'song.mp3');
  t.events.length = 0;
  return t;
}

function stemBuffer(durationS: number, channels = 1): AudioBuffer {
  return new FakeBuffer(channels, durationS * RATE, RATE) as unknown as AudioBuffer;
}

describe('Player load', () => {
  it('decodes, reports song info and becomes the original stem', async () => {
    const { player, events, ctx } = setup();
    const info = await player.load(new Blob([new TextEncoder().encode('abc')]), 'a.mp3');
    expect(info).toEqual({
      name: 'a.mp3',
      durationS: 60,
      sampleRate: RATE,
      channels: 2,
      hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    expect(player.info).toEqual(info);
    expect(player.state).toBe('ready');
    expect(player.position()).toBe(0);
    expect(player.stemIds()).toEqual(['original']);
    expect(player.stemGain('original')).toBe(1);
    expect(events).toEqual(['load', 'stems']);
    expect(ctx.sources).toHaveLength(0);
  });

  it('names an unnamed blob "untitled" and uses a File name when given one', async () => {
    const a = setup();
    expect((await a.player.load(new Blob(['x']))).name).toBe('untitled');
    const b = setup();
    expect((await b.player.load(new File(['x'], 'my song.wav'))).name).toBe('my song.wav');
  });

  it('rejects with a readable message and stays empty when decoding fails', async () => {
    const { player, ctx } = setup();
    ctx.decodeFails = true;
    await expect(player.load(new Blob(['x']), 'bad.txt')).rejects.toThrow(/"bad.txt"/);
    expect(player.state).toBe('empty');
    expect(player.info).toBeNull();
  });

  it('clears other stems, the loop and playback when a new song loads', async () => {
    const { player, ctx, events } = await loaded();
    player.addStem('take1', stemBuffer(30));
    player.setLoop({ startS: 5, endS: 10 });
    player.play();
    events.length = 0;
    await player.load(new Blob(['y']), 'next.mp3');
    expect(player.state).toBe('ready');
    expect(player.stemIds()).toEqual(['original']);
    expect(player.loop).toBeNull();
    expect(player.position()).toBe(0);
    expect(events).toEqual(['load', 'stems', 'loop']);
    expect(ctx.sources.every((s) => s.stops.length > 0)).toBe(true);
  });

  it('refuses stems before a song is loaded', () => {
    const { player } = setup();
    expect(() => player.addStem('take', stemBuffer(5))).toThrow(/Load a song/);
  });
});

describe('Player transport', () => {
  it('starts every source together, slightly ahead of now, and resumes the context', async () => {
    const { player, ctx, engine, events } = await loaded();
    ctx.currentTime = 10;
    player.addStem('take', stemBuffer(60));
    player.play();
    expect(player.state).toBe('playing');
    expect(engine.resume).toHaveBeenCalledTimes(1);
    expect(ctx.sources).toHaveLength(2);
    const whens = ctx.sources.map((s) => s.starts[0].when);
    expect(whens[0]).toBeCloseTo(10 + LEAD, 9);
    expect(whens[1]).toBe(whens[0]);
    expect(ctx.sources.map((s) => s.starts[0].offset)).toEqual([0, 0]);
    expect(events).toEqual(['stems', 'play']);
  });

  it('derives position from the context clock, not from timers', async () => {
    const { player, ctx } = await loaded();
    ctx.currentTime = 10;
    player.play();
    expect(player.position()).toBe(0); // still inside the start lead
    ctx.currentTime = 12.03;
    expect(player.position()).toBeCloseTo(2, 9);
    ctx.currentTime = 40.03;
    expect(player.position()).toBeCloseTo(30, 9);
  });

  it('pauses at the clock position and resumes from there', async () => {
    const { player, ctx, events, sourcesFrom } = await loaded();
    player.play();
    ctx.currentTime = 5 + LEAD;
    player.pause();
    expect(player.state).toBe('paused');
    expect(player.position()).toBeCloseTo(5, 9);
    expect(ctx.sources[0].stops).toEqual([5 + LEAD]);
    ctx.currentTime = 100; // time passing while paused changes nothing
    expect(player.position()).toBeCloseTo(5, 9);
    player.play();
    const next = sourcesFrom(1)[0];
    expect(next.starts[0].offset).toBeCloseTo(5, 9);
    expect(next.starts[0].when).toBeCloseTo(100 + LEAD, 9);
    expect(events).toEqual(['play', 'pause', 'play']);
  });

  it('seeks while paused without creating sources, then plays from there', async () => {
    const { player, ctx, events } = await loaded();
    player.seek(42);
    expect(player.position()).toBe(42);
    expect(ctx.sources).toHaveLength(0);
    player.seek(999);
    expect(player.position()).toBe(60);
    player.seek(-5);
    expect(player.position()).toBe(0);
    player.seek(42);
    player.play();
    expect(ctx.sources[0].starts[0].offset).toBe(42);
    expect(events.filter((e) => e === 'seek')).toHaveLength(4);
  });

  it('restarts sources at the new position when seeking while playing, with no gap', async () => {
    const { player, ctx, sourcesFrom } = await loaded();
    ctx.currentTime = 1;
    player.play();
    ctx.currentTime = 3;
    player.seek(20);
    const [old] = ctx.sources;
    const [, fresh] = [old, ...sourcesFrom(1)];
    expect(old.stops).toEqual([3 + LEAD]);
    expect(fresh.starts[0]).toEqual({ when: 3 + LEAD, offset: 20 });
    ctx.currentTime = 4.03;
    expect(player.position()).toBeCloseTo(21, 9);
  });

  it('stop returns to the start and leaves the player ready', async () => {
    const { player, ctx, events } = await loaded();
    player.play();
    ctx.currentTime = 9;
    events.length = 0;
    player.stop();
    expect(player.state).toBe('ready');
    expect(player.position()).toBe(0);
    expect(events).toEqual(['pause', 'seek']);
    events.length = 0;
    player.stop();
    expect(events).toEqual([]);
  });

  it('ignores transport calls before a song is loaded', () => {
    const { player, events, ctx } = setup();
    player.play();
    player.pause();
    player.stop();
    player.seek(5);
    player.setLoop({ startS: 1, endS: 4 });
    expect(player.state).toBe('empty');
    expect(player.loop).toBeNull();
    expect(events).toEqual([]);
    expect(ctx.sources).toHaveLength(0);
  });

  it('fires ended once when the original runs out, then replays from the start', async () => {
    const { player, ctx, events, sourcesFrom } = await loaded();
    player.play();
    ctx.currentTime = 70;
    ctx.sources[0].onended?.();
    ctx.sources[0].onended?.();
    expect(events.filter((e) => e === 'ended')).toHaveLength(1);
    expect(player.state).toBe('paused');
    expect(player.position()).toBe(60);
    player.play();
    expect(sourcesFrom(1)[0].starts[0].offset).toBe(0);
  });

  it('does not fire ended for sources that were replaced by a seek or pause', async () => {
    const { player, ctx, events } = await loaded();
    player.play();
    const first = ctx.sources[0];
    player.seek(10);
    first.onended?.();
    player.pause();
    ctx.sources[1].onended?.();
    expect(events).not.toContain('ended');
    expect(player.state).toBe('paused');
  });

  it('ends at once when seeking to the end while playing', async () => {
    const { player, events } = await loaded();
    player.play();
    events.length = 0;
    player.seek(60);
    expect(player.state).toBe('paused');
    expect(events).toEqual(['seek', 'ended']);
  });
});

describe('Player loop', () => {
  it('normalises the region and reports it', async () => {
    const { player, events } = await loaded();
    player.setLoop({ startS: 20, endS: 10 });
    expect(player.loop).toEqual({ startS: 10, endS: 20 });
    player.setLoop({ startS: 10, endS: 20 });
    player.setLoop({ startS: 5, endS: 5.01 });
    expect(player.loop).toBeNull();
    expect(events).toEqual(['loop', 'loop']);
  });

  it('gives sources native loop points and wraps position through the loop', async () => {
    const { player, ctx } = await loaded();
    player.seek(18);
    player.setLoop({ startS: 10, endS: 20 });
    player.play();
    const [src] = ctx.sources;
    expect(src).toMatchObject({ loop: true, loopStart: 10, loopEnd: 20 });
    expect(src.starts[0].offset).toBe(18);
    ctx.currentTime = LEAD + 1;
    expect(player.position()).toBeCloseTo(19, 9);
    ctx.currentTime = LEAD + 5; // 23 unwrapped
    expect(player.position()).toBeCloseTo(13, 9);
    ctx.currentTime = LEAD + 12; // 30 unwrapped
    expect(player.position()).toBeCloseTo(10, 9);
  });

  it('never fires ended while a loop is running', async () => {
    const { player, ctx, events } = await loaded();
    player.setLoop({ startS: 55, endS: 60 });
    player.seek(56);
    player.play();
    ctx.currentTime = 500;
    expect(player.state).toBe('playing');
    expect(player.position()).toBeGreaterThanOrEqual(55);
    expect(player.position()).toBeLessThan(60);
    expect(events).not.toContain('ended');
  });

  it('plays on to the end when started past the loop end', async () => {
    const { player, ctx } = await loaded();
    player.setLoop({ startS: 10, endS: 20 });
    player.seek(40);
    player.play();
    expect(ctx.sources[0].loop).toBe(false);
    ctx.currentTime = LEAD + 5;
    expect(player.position()).toBeCloseTo(45, 9);
  });

  it('swaps the loop gaplessly while playing', async () => {
    const { player, ctx } = await loaded();
    player.seek(14);
    player.play();
    ctx.currentTime = LEAD + 2; // playhead at 16
    player.setLoop({ startS: 10, endS: 20 });
    const [old, fresh] = ctx.sources;
    const when = LEAD + 2 + LEAD;
    expect(old.stops).toEqual([when]);
    expect(fresh.starts[0].when).toBeCloseTo(when, 9);
    expect(fresh.starts[0].offset).toBeCloseTo(16 + LEAD, 9);
    expect(fresh).toMatchObject({ loop: true, loopStart: 10, loopEnd: 20 });
  });

  it('clearing the loop while playing continues from the wrapped position', async () => {
    const { player, ctx } = await loaded();
    player.setLoop({ startS: 10, endS: 20 });
    player.seek(12);
    player.play();
    ctx.currentTime = LEAD + 10; // 22 unwrapped, 12 wrapped
    player.setLoop(null);
    expect(ctx.sources[1].loop).toBe(false);
    expect(ctx.sources[1].starts[0].offset).toBeCloseTo(12 + LEAD, 9);
  });
});

describe('Player stems', () => {
  it('routes each stem through its own gain into the master', async () => {
    const { player, ctx, master } = await loaded();
    player.addStem('take', stemBuffer(30));
    player.play();
    const gains = ctx.sources.map((s) => s.dest as FakeGain);
    expect(gains[0]).not.toBe(gains[1]);
    expect(gains.every((g) => g.connectedTo === master)).toBe(true);
    expect(player.stemIds()).toEqual(['original', 'take']);
  });

  it('clamps stem gain to 0..1 and ignores unknown ids', async () => {
    const { player, ctx } = await loaded();
    player.addStem('take', stemBuffer(30));
    player.setStemGain('take', 1.7);
    expect(player.stemGain('take')).toBe(1);
    player.setStemGain('take', -2);
    expect(player.stemGain('take')).toBe(0);
    player.setStemGain('take', 0.25);
    player.setStemGain('nope', 0.5);
    expect(player.stemGain('take')).toBe(0.25);
    expect(player.stemGain('nope')).toBeNull();
    player.play();
    const takeGain = ctx.sources[1].dest as FakeGain;
    expect(takeGain.gain.targets).toEqual([1, 0, 0.25]);
  });

  it('places a stem by its offset in song time', async () => {
    const { player, ctx } = await loaded();
    player.addStem('late', stemBuffer(30), 4);
    player.addStem('early', stemBuffer(30), -0.5);
    player.seek(1);
    player.play();
    const [orig, late, early] = ctx.sources;
    expect(orig.starts[0]).toEqual({ when: LEAD, offset: 1 });
    expect(late.starts[0].when).toBeCloseTo(LEAD + 3, 9); // waits 3 s
    expect(late.starts[0].offset).toBe(0);
    expect(early.starts[0].when).toBeCloseTo(LEAD, 9);
    expect(early.starts[0].offset).toBeCloseTo(1.5, 9);
  });

  it('starts a stem added mid-song in sync at the current position', async () => {
    const { player, ctx } = await loaded();
    player.seek(8);
    player.play();
    ctx.currentTime = LEAD + 2; // playhead at 10
    player.addStem('take', stemBuffer(60));
    const take = ctx.sources[1];
    expect(take.starts[0].when).toBeCloseTo(LEAD + 2 + LEAD, 9);
    expect(take.starts[0].offset).toBeCloseTo(10 + LEAD, 9);
  });

  it('skips a stem that has already finished at the start position', async () => {
    const { player, ctx } = await loaded();
    player.addStem('short', stemBuffer(5));
    player.seek(30);
    player.play();
    expect(ctx.sources).toHaveLength(1);
  });

  it('replaces a stem with the same id, keeping its level', async () => {
    const { player, ctx } = await loaded();
    player.addStem('take', stemBuffer(10));
    player.setStemGain('take', 0.4);
    player.play();
    player.addStem('take', stemBuffer(20), 1);
    expect(player.stemIds()).toEqual(['original', 'take']);
    expect(player.stemGain('take')).toBe(0.4);
    expect(ctx.sources[1].stops).toHaveLength(1);
    expect(ctx.sources).toHaveLength(3);
  });

  it('removes stems but protects the original', async () => {
    const { player, ctx } = await loaded();
    player.addStem('take', stemBuffer(10));
    player.play();
    player.removeStem('take');
    player.removeStem('original');
    expect(player.stemIds()).toEqual(['original']);
    expect(ctx.sources[1].stops).toHaveLength(1);
    expect(() => player.addStem('original', stemBuffer(5))).toThrow(/load\(\)/);
  });

  it('aligns a looping stem that only partly covers the loop using a padded slice', async () => {
    const { player, ctx } = await loaded();
    // Take begins at song time 8, so it misses the first 2 s of the 6..12 loop.
    const take = stemBuffer(10, 1) as unknown as FakeBuffer;
    take.data[0].fill(0.5);
    player.addStem('take', take as unknown as AudioBuffer, 8);
    player.setLoop({ startS: 6, endS: 12 });
    player.seek(7);
    player.play();
    const slice = ctx.sources[1];
    expect(slice.buffer).not.toBe(take);
    expect(slice.buffer?.duration).toBeCloseTo(6, 9); // song time 6..12 is 6 s
    expect(slice.starts[0].offset).toBeCloseTo(1, 9); // position 7 is 1 s in
    expect(slice).toMatchObject({ loop: true, loopStart: 0 });
    expect(slice.loopEnd).toBeCloseTo(6, 9);
    const samples = slice.buffer?.getChannelData(0) ?? new Float32Array(0);
    expect(samples[0]).toBe(0); // song 6.00: before the take
    expect(samples[199]).toBe(0); // song 7.99
    expect(samples[200]).toBe(0.5); // song 8.00: the take's first sample
    expect(samples[599]).toBe(0.5); // song 11.99
  });

  it('exposes a context-time to song-time mapping while playing', async () => {
    const { player, ctx } = await loaded();
    expect(player.songTimeAtContext(5)).toBeNull();
    ctx.currentTime = 2;
    player.seek(10);
    player.play();
    expect(player.songTimeAtContext(2 + LEAD + 3)).toBeCloseTo(13, 9);
  });
});

describe('Player events', () => {
  it('unsubscribes, and a throwing listener does not block the others', async () => {
    const { player } = await loaded();
    const seen: string[] = [];
    const off = player.on('seek', () => seen.push('a'));
    player.on('seek', () => {
      throw new Error('boom');
    });
    player.on('seek', () => seen.push('c'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    player.seek(1);
    off();
    player.seek(2);
    spy.mockRestore();
    expect(seen).toEqual(['a', 'c', 'c']);
  });
});
