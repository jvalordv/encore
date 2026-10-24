/**
 * Unit tests for the pitch lane's pure parts: key colours, note names, the
 * MIDI and time to pixel maps, range fitting, ribbon segmentation and
 * opacity runs, the live-frame ring, the redraw scheduler and the
 * pixel-ratio watcher. The canvas drawing itself needs a DOM and is checked
 * by eye in the dev server; everything it computes is checked here.
 */
import { describe, expect, it } from 'vitest';
import { midiToHz } from '../src/analysis/pitch';
import {
  FrameRing,
  RedrawLoop,
  alphaRuns,
  clarityAlpha,
  fitRange,
  isBlackKey,
  laneCaption,
  midiToY,
  noteName,
  referenceSpan,
  segmentRibbon,
  timeToX,
  voicedRuns,
  watchPixelRatio,
} from '../src/render/pitch-lane';
import type {
  FrameClock,
  LaneFrame,
  PixelRatioHost,
  PixelRatioQuery,
} from '../src/render/pitch-lane';

/** Voiced frames at 10 ms spacing from `t0`, with a constant clarity. */
function frames(count: number, t0 = 0, f0 = 220, clarity = 0.95): LaneFrame[] {
  return Array.from({ length: count }, (_, i) => ({ t: t0 + i * 0.01, f0, clarity }));
}

describe('laneCaption', () => {
  it('invites the singer when the lane is empty and nothing needs saying', () => {
    expect(laneCaption(null, true)).toBe('sing to see your pitch');
    expect(laneCaption(null, false)).toBeNull();
  });

  it('lets a notice take the place of the invitation, empty lane or not', () => {
    expect(laneCaption('Ad playing: pitch is paused', true)).toBe('Ad playing: pitch is paused');
    expect(laneCaption('Ad playing: pitch is paused', false)).toBe('Ad playing: pitch is paused');
  });

  it('reads an empty notice as none', () => {
    expect(laneCaption('', true)).toBe('sing to see your pitch');
    expect(laneCaption('', false)).toBeNull();
  });
});

describe('isBlackKey', () => {
  it('flags the five black pitch classes in every octave', () => {
    const black = [1, 3, 6, 8, 10];
    for (const octave of [0, 3, 5]) {
      for (let pc = 0; pc < 12; pc++) {
        expect(isBlackKey(octave * 12 + pc), `pc ${pc}`).toBe(black.includes(pc));
      }
    }
  });
});

describe('noteName', () => {
  it('uses scientific pitch notation', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(36)).toBe('C2');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(0)).toBe('C-1');
  });
});

describe('midiToY', () => {
  const [low, high, height] = [36, 84, 490]; // 49 rows of 10 px

  it('puts the lowest note in the bottom row and the highest in the top row', () => {
    expect(midiToY(low, low, high, height)).toBeCloseTo(485, 9);
    expect(midiToY(high, low, high, height)).toBeCloseTo(5, 9);
  });

  it('moves up by one row per semitone', () => {
    expect(midiToY(61, low, high, height) - midiToY(62, low, high, height)).toBeCloseTo(10, 9);
  });

  it('places fractional notes between rows', () => {
    const mid = (midiToY(60, low, high, height) + midiToY(61, low, high, height)) / 2;
    expect(midiToY(60.5, low, high, height)).toBeCloseTo(mid, 9);
  });
});

describe('timeToX', () => {
  it('puts the playhead (windowS - futureS) of the way across', () => {
    expect(timeToX(10, 10, 6, 1.5, 600)).toBeCloseTo(450, 9);
  });

  it('puts the oldest visible time at the left edge and the newest at the right', () => {
    expect(timeToX(10 - 4.5, 10, 6, 1.5, 600)).toBeCloseTo(0, 9);
    expect(timeToX(10 + 1.5, 10, 6, 1.5, 600)).toBeCloseTo(600, 9);
  });

  it('scrolls right-to-left: later times sit further right, one window per width', () => {
    const a = timeToX(11, 10, 6, 1.5, 600);
    const b = timeToX(12, 10, 6, 1.5, 600);
    expect(b - a).toBeCloseTo(100, 9);
    expect(timeToX(10, 10.5, 6, 1.5, 600)).toBeCloseTo(400, 9);
  });

  it('returns 0 instead of NaN for a degenerate window', () => {
    expect(timeToX(1, 0, 0, 0, 600)).toBe(0);
  });
});

describe('fitRange', () => {
  const hz = (midis: number[]): number[] => midis.map(midiToHz);

  it('pads the 2nd to 98th percentile by two semitones', () => {
    const midis = Array.from({ length: 101 }, (_, i) => 50 + i * 0.2); // 50..70
    // p02 = 50.4 and p98 = 69.6, so 48.4 and 71.6 round outwards.
    expect(fitRange(hz(midis))).toEqual({ midiLow: 48, midiHigh: 72 });
  });

  it('ignores stray outliers and unvoiced frames', () => {
    const midis = Array.from({ length: 1000 }, (_, i) => 55 + (i % 21)); // 55..75
    const f0 = [0, 0, ...hz(midis), 0, ...hz([20, 120])];
    const { midiLow, midiHigh } = fitRange(f0);
    expect(midiLow).toBeGreaterThanOrEqual(52);
    expect(midiHigh).toBeLessThanOrEqual(78);
  });

  it('widens a narrow melody to a whole octave around its middle', () => {
    expect(fitRange(hz(new Array<number>(50).fill(69)))).toEqual({ midiLow: 63, midiHigh: 75 });
    const two = fitRange(hz([60, 62, 60, 62, 60, 62]));
    expect(two.midiHigh - two.midiLow).toBeGreaterThanOrEqual(12);
    expect(two.midiLow).toBeLessThanOrEqual(58);
    expect(two.midiHigh).toBeGreaterThanOrEqual(64);
  });

  it('returns whole notes', () => {
    const { midiLow, midiHigh } = fitRange(hz([57.3, 60.1, 64.8, 71.2]));
    expect(Number.isInteger(midiLow)).toBe(true);
    expect(Number.isInteger(midiHigh)).toBe(true);
  });

  it('honours a custom pad', () => {
    const midis = Array.from({ length: 101 }, (_, i) => 50 + i * 0.2);
    expect(fitRange(hz(midis), 0)).toEqual({ midiLow: 50, midiHigh: 70 });
  });

  it('falls back to the default range when nothing is voiced', () => {
    expect(fitRange([])).toEqual({ midiLow: 36, midiHigh: 84 });
    expect(fitRange([0, 0, 0])).toEqual({ midiLow: 36, midiHigh: 84 });
  });

  it('stays inside MIDI 0 to 127 without losing the octave', () => {
    const low = fitRange(hz([1, 1, 1]));
    expect(low.midiLow).toBe(0);
    expect(low.midiHigh - low.midiLow).toBeGreaterThanOrEqual(12);
    const high = fitRange(hz([126, 126, 126]));
    expect(high.midiHigh).toBe(127);
    expect(high.midiHigh - high.midiLow).toBeGreaterThanOrEqual(12);
  });

  it('accepts typed arrays', () => {
    const f0 = new Float32Array(hz([60, 64, 67, 72]));
    expect(fitRange(f0).midiHigh).toBeGreaterThan(fitRange(f0).midiLow);
  });
});

describe('segmentRibbon', () => {
  it('keeps a steady trace as one ribbon', () => {
    const out = segmentRibbon(frames(100), 0.01);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(100);
  });

  it('breaks where the time gap exceeds 2.5 hops', () => {
    const fs = [...frames(5), ...frames(5, 0.04 + 0.03)]; // 30 ms gap = 3 hops
    expect(segmentRibbon(fs, 0.01).map((s) => s.length)).toEqual([5, 5]);
  });

  it('bridges a gap of up to 2.5 hops', () => {
    const fs = [...frames(5), ...frames(5, 0.04 + 0.02)]; // 20 ms gap = 2 hops
    expect(segmentRibbon(fs, 0.01)).toHaveLength(1);
  });

  it('breaks at unvoiced frames and drops them', () => {
    const fs = frames(9);
    fs[4] = { ...fs[4], f0: 0 };
    const out = segmentRibbon(fs, 0.01);
    expect(out.map((s) => s.length)).toEqual([4, 4]);
    expect(out.flat().every((f) => f.f0 > 0)).toBe(true);
  });

  it('keeps isolated voiced frames as their own ribbon', () => {
    const fs = frames(5);
    fs[1] = { ...fs[1], f0: 0 };
    fs[3] = { ...fs[3], f0: 0 };
    expect(segmentRibbon(fs, 0.01).map((s) => s.length)).toEqual([1, 1, 1]);
  });

  it('scales the gap with the hop and tolerates a bad hop', () => {
    const slow = [...frames(3), ...frames(3, 0.02 + 0.06)]; // 60 ms gap
    expect(segmentRibbon(slow, 0.05)).toHaveLength(1);
    expect(segmentRibbon(slow, 0.01)).toHaveLength(2);
    expect(segmentRibbon(slow, 0)).toHaveLength(2);
  });

  it('returns nothing for no frames or no voiced frames', () => {
    expect(segmentRibbon([], 0.01)).toEqual([]);
    expect(segmentRibbon(frames(4, 0, 0), 0.01)).toEqual([]);
  });
});

describe('FrameRing', () => {
  it('returns frames oldest first', () => {
    const ring = new FrameRing(10);
    for (const f of frames(5)) ring.push(f);
    expect(ring.length).toBe(5);
    const t = ring.toArray().map((f) => f.t);
    expect(t).toEqual([...t].sort((a, b) => a - b));
  });

  it('drops the oldest frame when full', () => {
    const ring = new FrameRing(4);
    for (const f of frames(10)) ring.push(f);
    expect(ring.length).toBe(4);
    expect(ring.toArray().map((f) => Math.round(f.t * 100))).toEqual([6, 7, 8, 9]);
  });

  it('trims frames before a time and keeps the rest in order', () => {
    const ring = new FrameRing(20);
    for (const f of frames(10)) ring.push(f);
    ring.trimBefore(0.035);
    expect(ring.toArray().map((f) => Math.round(f.t * 100))).toEqual([4, 5, 6, 7, 8, 9]);
    ring.trimBefore(10);
    expect(ring.length).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });

  it('keeps working across the wrap point', () => {
    const ring = new FrameRing(5);
    for (const f of frames(8)) ring.push(f);
    ring.trimBefore(0.055);
    for (const f of frames(3, 0.08)) ring.push(f);
    expect(ring.toArray().map((f) => Math.round(f.t * 100))).toEqual([6, 7, 8, 9, 10]);
  });

  it('rewinds when song time goes backwards, so a new pass overwrites the old', () => {
    const ring = new FrameRing(50);
    for (const f of frames(20)) ring.push(f); // 0.00 .. 0.19
    ring.push({ t: 0.1, f0: 300, clarity: 1 });
    const out = ring.toArray();
    expect(out).toHaveLength(11);
    expect(out[out.length - 1]).toEqual({ t: 0.1, f0: 300, clarity: 1 });
  });

  it('stores copies, so a reused frame object cannot change the history', () => {
    const ring = new FrameRing(5);
    const f: LaneFrame = { t: 0, f0: 100, clarity: 1 };
    ring.push(f);
    f.f0 = 999;
    expect(ring.toArray()[0].f0).toBe(100);
  });

  it('ignores frames with no usable time and can be cleared', () => {
    const ring = new FrameRing(5);
    ring.push({ t: NaN, f0: 100, clarity: 1 });
    expect(ring.length).toBe(0);
    for (const f of frames(3)) ring.push(f);
    ring.clear();
    expect(ring.length).toBe(0);
    ring.push({ t: 1, f0: 100, clarity: 1 });
    expect(ring.length).toBe(1);
  });

  it('holds at least one frame even for a nonsense capacity', () => {
    const ring = new FrameRing(0);
    for (const f of frames(3)) ring.push(f);
    expect(ring.length).toBe(1);
  });
});

describe('clarityAlpha', () => {
  it('is solid at full clarity and faint but visible when shaky', () => {
    expect(clarityAlpha(1)).toBeCloseTo(1, 9);
    expect(clarityAlpha(0)).toBeCloseTo(0.25, 9);
    expect(clarityAlpha(0.8)).toBeCloseTo(0.25, 9);
  });

  it('rises monotonically with clarity', () => {
    let prev = 0;
    for (let c = 0; c <= 1.0001; c += 0.05) {
      const a = clarityAlpha(c);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
});

describe('alphaRuns', () => {
  it('draws a steady ribbon as one run covering every frame', () => {
    expect(alphaRuns(frames(30, 0, 220, 1))).toEqual([{ from: 0, to: 29, alpha: 1 }]);
  });

  it('splits where clarity changes and shares the boundary vertex', () => {
    const seg = [...frames(16, 0, 220, 1), ...frames(16, 0.16, 220, 0.8)];
    const runs = alphaRuns(seg, 8);
    expect(runs).toEqual([
      { from: 0, to: 16, alpha: 1 },
      { from: 16, to: 31, alpha: 0.25 },
    ]);
  });

  it('covers every vertex with no gap between runs', () => {
    const seg = frames(50).map((f, i) => ({ ...f, clarity: i % 17 < 8 ? 1 : 0.8 }));
    const runs = alphaRuns(seg, 4);
    expect(runs[0].from).toBe(0);
    expect(runs[runs.length - 1].to).toBe(49);
    for (let i = 1; i < runs.length; i++) expect(runs[i].from).toBe(runs[i - 1].to);
  });

  it('bounds the stroke count by the chunk size, even when clarity flickers', () => {
    const seg = frames(600).map((f, i) => ({ ...f, clarity: i % 2 ? 1 : 0.8 }));
    // Alternating frames average out inside each chunk, so this stays tiny.
    expect(alphaRuns(seg).length).toBeLessThanOrEqual(Math.ceil(599 / 8));
  });

  it('handles one-frame and empty ribbons', () => {
    expect(alphaRuns([])).toEqual([]);
    expect(alphaRuns(frames(1, 0, 220, 1))).toEqual([{ from: 0, to: 0, alpha: 1 }]);
    expect(alphaRuns(frames(2, 0, 220, 1))).toEqual([{ from: 0, to: 1, alpha: 1 }]);
  });
});

describe('referenceSpan', () => {
  const ref = { hopS: 0.01, t0S: 1, f0Hz: new Array<number>(1000).fill(220) };

  it('maps a time span to sample indices', () => {
    expect(referenceSpan(ref, 2, 3)).toEqual({ first: 100, last: 200 });
  });

  it('clamps to the contour and rejects spans entirely outside it', () => {
    expect(referenceSpan(ref, 0, 1.5)).toEqual({ first: 0, last: 50 });
    expect(referenceSpan(ref, 10.5, 12)).toEqual({ first: 950, last: 999 });
    expect(referenceSpan(ref, 20, 22)).toBeNull();
    expect(referenceSpan(ref, -5, -1)).toBeNull();
  });

  it('rejects empty contours and a bad hop', () => {
    expect(referenceSpan({ hopS: 0.01, t0S: 0, f0Hz: [] }, 0, 1)).toBeNull();
    expect(referenceSpan({ hopS: 0, t0S: 0, f0Hz: [220] }, 0, 1)).toBeNull();
  });
});

describe('voicedRuns', () => {
  it('finds runs of voiced samples as inclusive index pairs', () => {
    const f0 = [0, 220, 220, 0, 0, 330, 0, 440, 440, 440];
    expect(voicedRuns(f0, 0, 9)).toEqual([
      [1, 2],
      [5, 5],
      [7, 9],
    ]);
  });

  it('respects the index bounds', () => {
    const f0 = [220, 220, 220, 0, 220, 220];
    expect(voicedRuns(f0, 1, 4)).toEqual([
      [1, 2],
      [4, 4],
    ]);
  });

  it('strides over samples', () => {
    const f0 = new Array<number>(20).fill(220);
    expect(voicedRuns(f0, 0, 19, 4)).toEqual([[0, 16]]);
  });

  it('returns nothing for an unvoiced stretch and accepts typed arrays', () => {
    expect(voicedRuns(new Float32Array(10), 0, 9)).toEqual([]);
    expect(voicedRuns(new Float32Array([0, 100, 100]), 0, 2)).toEqual([[1, 2]]);
  });
});

/** A hand-cranked frame clock: requests queue until `flush`. */
class FakeClock implements FrameClock {
  readonly queue = new Map<number, () => void>();
  private nextId = 1;
  requests = 0;

  request(cb: () => void): number {
    this.requests++;
    const id = this.nextId++;
    this.queue.set(id, cb);
    return id;
  }

  cancel(id: number): void {
    this.queue.delete(id);
  }

  flush(): void {
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const cb of due) cb();
  }
}

describe('RedrawLoop', () => {
  function setup(): { loop: RedrawLoop; clock: FakeClock; draws: () => number } {
    const clock = new FakeClock();
    let count = 0;
    const loop = new RedrawLoop(() => count++, () => clock);
    return { loop, clock, draws: () => count };
  }

  it('does not draw until invalidated, and draws once per frame after', () => {
    const { loop, clock, draws } = setup();
    loop.start();
    clock.flush();
    expect(draws()).toBe(0);
    loop.invalidate();
    loop.invalidate();
    loop.invalidate();
    expect(clock.requests).toBe(1);
    clock.flush();
    expect(draws()).toBe(1);
    clock.flush();
    expect(draws()).toBe(1);
  });

  it('draws again on the next invalidation', () => {
    const { loop, clock, draws } = setup();
    loop.start();
    loop.invalidate();
    clock.flush();
    loop.invalidate();
    clock.flush();
    expect(draws()).toBe(2);
  });

  it('holds invalidations made before start until it starts', () => {
    const { loop, clock, draws } = setup();
    loop.invalidate();
    expect(clock.requests).toBe(0);
    loop.start();
    clock.flush();
    expect(draws()).toBe(1);
  });

  it('cancels the pending frame on stop and does not draw while stopped', () => {
    const { loop, clock, draws } = setup();
    loop.start();
    loop.invalidate();
    loop.stop();
    expect(clock.queue.size).toBe(0);
    clock.flush();
    loop.invalidate();
    clock.flush();
    expect(draws()).toBe(0);
    expect(loop.running).toBe(false);
  });

  it('does not repeat a draw that settle() already covered', () => {
    const { loop, clock, draws } = setup();
    loop.start();
    loop.invalidate();
    loop.settle();
    clock.flush();
    expect(draws()).toBe(0);
  });
});

/** A MediaQueryList stand-in that records its listeners. */
class FakeQuery implements PixelRatioQuery {
  readonly listeners = new Set<() => void>();

  constructor(readonly query: string) {}

  addEventListener(_type: 'change', cb: () => void): void {
    this.listeners.add(cb);
  }

  removeEventListener(_type: 'change', cb: () => void): void {
    this.listeners.delete(cb);
  }

  fire(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

describe('watchPixelRatio', () => {
  function setup(ratio: number): { host: PixelRatioHost; queries: FakeQuery[] } {
    const queries: FakeQuery[] = [];
    const host = {
      devicePixelRatio: ratio,
      matchMedia: (query: string): PixelRatioQuery => {
        const q = new FakeQuery(query);
        queries.push(q);
        return q;
      },
    };
    return { host, queries };
  }

  it('listens to a resolution query for the current ratio', () => {
    const { host, queries } = setup(2);
    watchPixelRatio(() => undefined, host);
    expect(queries.map((q) => q.query)).toEqual(['(resolution: 2dppx)']);
    expect(queries[0].listeners.size).toBe(1);
  });

  it('reports the new ratio and re-arms on it after every change', () => {
    const { host, queries } = setup(2);
    const seen: number[] = [];
    watchPixelRatio((r) => seen.push(r), host);

    host.devicePixelRatio = 1;
    queries[0].fire();
    expect(seen).toEqual([1]);
    expect(queries[1].query).toBe('(resolution: 1dppx)');
    expect(queries[0].listeners.size).toBe(0);

    host.devicePixelRatio = 1.5;
    queries[1].fire();
    expect(seen).toEqual([1, 1.5]);
    expect(queries[2].query).toBe('(resolution: 1.5dppx)');
    expect(queries[2].listeners.size).toBe(1);
  });

  it('stops watching when disposed', () => {
    const { host, queries } = setup(2);
    const seen: number[] = [];
    const stop = watchPixelRatio((r) => seen.push(r), host);
    stop();
    expect(queries[0].listeners.size).toBe(0);
    queries[0].fire();
    expect(seen).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it('stays quiet if disposed from inside the callback', () => {
    const { host, queries } = setup(2);
    let stop: () => void = () => undefined;
    stop = watchPixelRatio(() => stop(), host);
    host.devicePixelRatio = 1;
    queries[0].fire();
    expect(queries).toHaveLength(1);
  });

  it('degrades to a no-op without matchMedia or query events', () => {
    expect(() => watchPixelRatio(() => undefined, { devicePixelRatio: 1 })()).not.toThrow();
    const bare = { devicePixelRatio: 1, matchMedia: (): PixelRatioQuery => ({}) };
    expect(() => watchPixelRatio(() => undefined, bare)()).not.toThrow();
  });

  it('treats a missing ratio as 1', () => {
    const { host, queries } = setup(0);
    watchPixelRatio(() => undefined, host);
    expect(queries[0].query).toBe('(resolution: 1dppx)');
  });
});
