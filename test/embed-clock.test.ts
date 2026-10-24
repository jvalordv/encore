/**
 * Tests for the embedded-player guards, on synthetic sequences with known
 * answers. The clock guard is fed the shapes the spike measured (a steady
 * extrapolated clock, backward corrections under 20 ms, a rare stall of about
 * 100 ms) and the ones it must refuse to smooth over (a 90 ms slip, a 400 ms
 * jump either way, a stall beyond 300 ms), plus pause and buffering, where it
 * must pass the raw value through. The ad detector is checked on the two
 * signals it reads: the video id and the duration.
 */
import { describe, expect, it } from 'vitest';
import {
  AD_DURATION_EPS_S,
  EmbedClock,
  JUMP_S,
  STALL_S,
  isAdPlaying,
  stepEmbedClock,
} from '../src/audio/embed-clock';
import type { ClockPlayState, ClockSample } from '../src/audio/embed-clock';

/** One point of a synthetic run: wall time, what the player says, its state. */
interface Point {
  wallMs: number;
  reportedS: number;
  state?: ClockPlayState;
}

/** Feeds a run to a fresh guard and returns each sample's answer. */
function run(points: Point[]): Array<{ wallMs: number; positionS: number; discontinuity: boolean }> {
  const clock = new EmbedClock();
  return points.map((p) => {
    const reading = clock.sample({ reportedS: p.reportedS, state: p.state ?? 'playing', wallMs: p.wallMs });
    return { wallMs: p.wallMs, ...reading };
  });
}

/** A straight-line clock: `startS` at wall time 0, sampled every `stepMs`. */
function line(startS: number, durationMs: number, stepMs: number, t0 = 0): Point[] {
  const points: Point[] = [];
  for (let ms = 0; ms <= durationMs; ms += stepMs) {
    points.push({ wallMs: t0 + ms, reportedS: startS + ms / 1000 });
  }
  return points;
}

describe('constants', () => {
  it('carry the measured thresholds', () => {
    expect(JUMP_S).toBe(0.25);
    expect(STALL_S).toBe(0.3);
    expect(AD_DURATION_EPS_S).toBe(1);
  });
});

describe('EmbedClock while playing', () => {
  it('passes a steady clock through untouched and never flags it', () => {
    const out = run(line(10, 5000, 16));
    for (const r of out) {
      expect(r.discontinuity).toBe(false);
      expect(r.positionS).toBeCloseTo(10 + r.wallMs / 1000, 9);
    }
  });

  it('survives jitter of a few milliseconds without going backwards', () => {
    // A deterministic wobble of up to 8 ms either way on top of the line.
    const points = line(30, 20_000, 16).map((p, i) => ({
      ...p,
      reportedS: p.reportedS + 0.008 * Math.sin(i * 1.7),
    }));
    const out = run(points);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].discontinuity).toBe(false);
      expect(out[i].positionS).toBeGreaterThanOrEqual(out[i - 1].positionS);
      expect(Math.abs(out[i].positionS - points[i].reportedS)).toBeLessThanOrEqual(0.016 + 1e-9);
    }
  });

  it('holds a small backward step flat and waits for the clock to catch up', () => {
    // The clock steps back 40 ms at t = 1000 (30 ms below the last reading).
    const points = line(10, 2000, 10).map((p) =>
      p.wallMs >= 1000 ? { ...p, reportedS: p.reportedS - 0.04 } : p,
    );
    const out = run(points);
    const at = (ms: number) => out.find((r) => r.wallMs === ms)!;
    const held = at(990).positionS;
    expect(held).toBeCloseTo(10.99, 9);
    // Three samples read below the held position; each reports it unchanged.
    for (const ms of [1000, 1010, 1020]) expect(at(ms).positionS).toBe(held);
    // By t = 1040 the clock (11.00) is past it again and is followed.
    expect(at(1040).positionS).toBeCloseTo(11.0, 9);
    expect(out.every((r) => !r.discontinuity)).toBe(true);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].positionS).toBeGreaterThanOrEqual(out[i - 1].positionS);
    }
  });

  it('holds a 90 ms slip for about 90 ms without flagging it', () => {
    const points = line(5, 3000, 10).map((p) =>
      p.wallMs >= 2000 ? { ...p, reportedS: p.reportedS - 0.09 } : p,
    );
    const out = run(points);
    const at = (ms: number) => out.find((r) => r.wallMs === ms)!;
    const heldAt = at(1990).positionS;
    for (const ms of [2000, 2020, 2040, 2060]) expect(at(ms).positionS).toBe(heldAt);
    // The slip is 90 ms behind and the clock runs at real speed, so the held
    // position is released about 90 ms after the slip.
    expect(at(2080).positionS).toBeCloseTo(heldAt, 9);
    expect(at(2100).positionS).toBeGreaterThan(heldAt);
    expect(at(2100).positionS).toBeCloseTo(5 + 2.1 - 0.09, 9);
    expect(out.every((r) => !r.discontinuity)).toBe(true);
  });

  it('holds a backward step of exactly 250 ms and flags one a hair over', () => {
    const clock = new EmbedClock();
    clock.sample({ reportedS: 10, state: 'playing', wallMs: 1000 });
    const held = clock.sample({ reportedS: 9.75, state: 'playing', wallMs: 1000 });
    expect(held).toEqual({ positionS: 10, discontinuity: false });

    const other = new EmbedClock();
    other.sample({ reportedS: 10, state: 'playing', wallMs: 1000 });
    const jumped = other.sample({ reportedS: 9.74, state: 'playing', wallMs: 1000 });
    expect(jumped).toEqual({ positionS: 9.74, discontinuity: true });
  });

  it('flags a 400 ms forward jump once, at the sample where it happens', () => {
    const points = line(10, 3000, 16).map((p) =>
      p.wallMs >= 1504 ? { ...p, reportedS: p.reportedS + 0.4 } : p,
    );
    const out = run(points);
    const flagged = out.filter((r) => r.discontinuity);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].wallMs).toBe(1504);
    expect(flagged[0].positionS).toBeCloseTo(10 + 1.504 + 0.4, 9);
    // Afterwards it follows the new line.
    const last = out[out.length - 1];
    expect(last.positionS).toBeCloseTo(10 + last.wallMs / 1000 + 0.4, 9);
  });

  it('flags a 400 ms backward jump and follows the clock back', () => {
    const points = line(10, 3000, 16).map((p) =>
      p.wallMs >= 1504 ? { ...p, reportedS: p.reportedS - 0.4 } : p,
    );
    const out = run(points);
    const flagged = out.filter((r) => r.discontinuity);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].wallMs).toBe(1504);
    // A discontinuity is the one case where the position does go backwards.
    expect(flagged[0].positionS).toBeCloseTo(10 + 1.504 - 0.4, 9);
    const last = out[out.length - 1];
    expect(last.positionS).toBeCloseTo(10 + last.wallMs / 1000 - 0.4, 9);
  });

  it('flags a forward jump measured against the straight line, not the last reading', () => {
    // 1 s between readings is normal for a throttled page...
    const clock = new EmbedClock();
    clock.sample({ reportedS: 10, state: 'playing', wallMs: 0 });
    expect(clock.sample({ reportedS: 11, state: 'playing', wallMs: 1000 }).discontinuity).toBe(false);
    // ...but 1.4 s of clock in 1 s of wall time is a jump of 0.4 s.
    expect(clock.sample({ reportedS: 12.4, state: 'playing', wallMs: 2000 }).discontinuity).toBe(true);
  });

  it('does not flag a forward leap of up to 250 ms', () => {
    const clock = new EmbedClock();
    clock.sample({ reportedS: 10, state: 'playing', wallMs: 1000 });
    const leap = clock.sample({ reportedS: 10.25, state: 'playing', wallMs: 1000 });
    expect(leap).toEqual({ positionS: 10.25, discontinuity: false });
    const over = new EmbedClock();
    over.sample({ reportedS: 10, state: 'playing', wallMs: 1000 });
    expect(over.sample({ reportedS: 10.26, state: 'playing', wallMs: 1000 }).discontinuity).toBe(true);
  });

  it('flags a stall once, 300 ms after the clock stops advancing', () => {
    // Moves until t = 1000, stands at 11.000 until t = 1400, then resumes.
    const points: Point[] = [];
    for (let ms = 0; ms <= 2000; ms += 20) {
      const reportedS = ms <= 1000 ? 10 + ms / 1000 : ms <= 1400 ? 11 : 11 + (ms - 1400) / 1000;
      points.push({ wallMs: ms, reportedS });
    }
    const out = run(points);
    const flagged = out.filter((r) => r.discontinuity);
    expect(flagged).toHaveLength(1);
    // Last advance at 1000; the first sample more than 300 ms later is 1320.
    expect(flagged[0].wallMs).toBe(1320);
    expect(flagged[0].positionS).toBe(11);
    // Position stood still through the stall and moved on after it.
    expect(out.find((r) => r.wallMs === 1400)!.positionS).toBe(11);
    expect(out[out.length - 1].positionS).toBeCloseTo(11.6, 9);
  });

  it('does not flag a stall of about 100 ms, the longest one measured', () => {
    const points: Point[] = [];
    for (let ms = 0; ms <= 3000; ms += 20) {
      const reportedS = ms <= 1000 ? 10 + ms / 1000 : ms <= 1100 ? 11 : 11 + (ms - 1100) / 1000;
      points.push({ wallMs: ms, reportedS });
    }
    const out = run(points);
    expect(out.every((r) => !r.discontinuity)).toBe(true);
    expect(out[out.length - 1].positionS).toBeCloseTo(12.9, 9);
  });

  it('flags a stall that ends in a catch-up jump a second time', () => {
    const points: Point[] = [];
    for (let ms = 0; ms <= 2000; ms += 20) {
      const reportedS = ms <= 500 ? 10 + ms / 1000 : ms < 1200 ? 10.5 : 10 + ms / 1000;
      points.push({ wallMs: ms, reportedS });
    }
    const flagged = run(points).filter((r) => r.discontinuity);
    expect(flagged.map((r) => r.wallMs)).toEqual([820, 1200]);
  });

  it('scales the straight line by the playback rate', () => {
    const clock = new EmbedClock();
    clock.sample({ reportedS: 10, state: 'playing', wallMs: 0, rate: 2 });
    // One second of wall time is two seconds of video at double speed.
    expect(clock.sample({ reportedS: 12, state: 'playing', wallMs: 1000, rate: 2 }).discontinuity).toBe(false);
    // Read at the wrong rate, the same run looks like a one-second jump.
    const wrong = new EmbedClock();
    wrong.sample({ reportedS: 10, state: 'playing', wallMs: 0 });
    expect(wrong.sample({ reportedS: 12, state: 'playing', wallMs: 1000 }).discontinuity).toBe(true);
  });

  it('treats a missing or bad rate as 1', () => {
    for (const rate of [undefined, 0, -1, Number.NaN]) {
      const clock = new EmbedClock();
      clock.sample({ reportedS: 10, state: 'playing', wallMs: 0, rate });
      expect(clock.sample({ reportedS: 11, state: 'playing', wallMs: 1000, rate }).discontinuity).toBe(false);
    }
  });

  it('anchors on the first sample without comparing it to anything', () => {
    const clock = new EmbedClock();
    expect(clock.sample({ reportedS: 4321, state: 'playing', wallMs: 5 })).toEqual({
      positionS: 4321,
      discontinuity: false,
    });
  });

  it('survives wall time that does not move or runs backwards', () => {
    const clock = new EmbedClock();
    clock.sample({ reportedS: 10, state: 'playing', wallMs: 1000 });
    expect(clock.sample({ reportedS: 10.002, state: 'playing', wallMs: 1000 }).discontinuity).toBe(false);
    expect(clock.sample({ reportedS: 10.004, state: 'playing', wallMs: 990 }).discontinuity).toBe(false);
  });
});

describe('EmbedClock while paused or buffering', () => {
  it.each<ClockPlayState>(['paused', 'buffering'])('reports the raw value while %s', (state) => {
    const clock = new EmbedClock();
    clock.sample({ reportedS: 20, state: 'playing', wallMs: 0 });
    // Backward, forward and standing still: all raw, never flagged.
    for (const [wallMs, reportedS] of [
      [16, 19.9],
      [32, 25],
      [900, 25],
      [2000, 3],
    ]) {
      expect(clock.sample({ reportedS, state, wallMs })).toEqual({ positionS: reportedS, discontinuity: false });
    }
  });

  it('re-anchors on the first playing sample after a pause, however far the clock moved', () => {
    const clock = new EmbedClock();
    clock.sample({ reportedS: 20, state: 'playing', wallMs: 0 });
    clock.sample({ reportedS: 20.016, state: 'playing', wallMs: 16 });
    clock.sample({ reportedS: 20.016, state: 'paused', wallMs: 100 });
    // The singer seeked while paused; resuming is not a discontinuity.
    expect(clock.sample({ reportedS: 95, state: 'playing', wallMs: 5000 })).toEqual({
      positionS: 95,
      discontinuity: false,
    });
    // And from there it is a normal clock again.
    expect(clock.sample({ reportedS: 95.016, state: 'playing', wallMs: 5016 }).discontinuity).toBe(false);
  });

  it('does not count a stretch spent buffering as a stall', () => {
    const points: Point[] = [];
    for (let ms = 0; ms <= 400; ms += 20) points.push({ wallMs: ms, reportedS: 10 + ms / 1000 });
    for (let ms = 420; ms <= 1500; ms += 20) {
      points.push({ wallMs: ms, reportedS: 10.4, state: 'buffering' });
    }
    for (let ms = 1520; ms <= 2000; ms += 20) {
      points.push({ wallMs: ms, reportedS: 10.4 + (ms - 1500) / 1000 });
    }
    expect(run(points).every((r) => !r.discontinuity)).toBe(true);
  });
});

describe('EmbedClock bookkeeping', () => {
  it('ignores a sample whose time is not a number and repeats the last position', () => {
    const clock = new EmbedClock();
    expect(clock.sample({ reportedS: Number.NaN, state: 'playing', wallMs: 0 })).toEqual({
      positionS: 0,
      discontinuity: false,
    });
    clock.sample({ reportedS: 12, state: 'playing', wallMs: 100 });
    expect(clock.sample({ reportedS: Number.NaN, state: 'playing', wallMs: 116 })).toEqual({
      positionS: 12,
      discontinuity: false,
    });
    expect(clock.sample({ reportedS: Number.POSITIVE_INFINITY, state: 'playing', wallMs: 132 }).discontinuity).toBe(
      false,
    );
    // The bad samples left no trace: the clock carries on from 12 s.
    expect(clock.sample({ reportedS: 12.032, state: 'playing', wallMs: 132 }).discontinuity).toBe(false);
  });

  it('forgets everything on reset, so the next sample only anchors', () => {
    const clock = new EmbedClock();
    clock.sample({ reportedS: 10, state: 'playing', wallMs: 0 });
    clock.reset();
    expect(clock.sample({ reportedS: 500, state: 'playing', wallMs: 16 })).toEqual({
      positionS: 500,
      discontinuity: false,
    });
  });

  it('keeps separate clocks apart', () => {
    const a = new EmbedClock();
    const b = new EmbedClock();
    a.sample({ reportedS: 10, state: 'playing', wallMs: 0 });
    expect(b.sample({ reportedS: 99, state: 'playing', wallMs: 16 }).discontinuity).toBe(false);
  });
});

describe('stepEmbedClock', () => {
  const start: ClockSample = { reportedS: 10, state: 'playing', wallMs: 0 };

  it('is pure: the memory it is given is not changed and equal inputs give equal answers', () => {
    const first = stepEmbedClock(null, start);
    const frozen = JSON.stringify(first.memory);
    const next: ClockSample = { reportedS: 9.95, state: 'playing', wallMs: 16 };
    const a = stepEmbedClock(first.memory, next);
    const b = stepEmbedClock(first.memory, next);
    expect(JSON.stringify(first.memory)).toBe(frozen);
    expect(a).toEqual(b);
    expect(a.reading).toEqual({ positionS: 10, discontinuity: false });
  });

  it('records the held position and the last advance in its memory', () => {
    const first = stepEmbedClock(null, start);
    const step = stepEmbedClock(first.memory, { reportedS: 10.016, state: 'playing', wallMs: 16 });
    expect(step.memory).toMatchObject({ heldS: 10.016, advancedAtMs: 16, stallReported: false });
    const held = stepEmbedClock(step.memory, { reportedS: 10.0, state: 'playing', wallMs: 32 });
    expect(held.memory.heldS).toBe(10.016);
    expect(held.memory.advancedAtMs).toBe(16);
  });
});

describe('isAdPlaying', () => {
  const probe = {
    requestedVideoId: 'dQw4w9WgXcQ',
    reportedVideoId: 'dQw4w9WgXcQ',
    knownDurationS: 213 as number | null,
    reportedDurationS: 213,
  };

  it('is false for the requested video at its own length', () => {
    expect(isAdPlaying(probe)).toBe(false);
  });

  it('is true when the player reports another video id', () => {
    expect(isAdPlaying({ ...probe, reportedVideoId: 'xxxxxxxxxxx' })).toBe(true);
  });

  it('is true when the duration changes mid-play, even with the right id', () => {
    expect(isAdPlaying({ ...probe, reportedDurationS: 15 })).toBe(true);
    expect(isAdPlaying({ ...probe, reportedDurationS: 214.5 })).toBe(true);
  });

  it('forgives a rounding wobble of up to a second in the duration', () => {
    expect(isAdPlaying({ ...probe, reportedDurationS: 213.4 })).toBe(false);
    expect(isAdPlaying({ ...probe, reportedDurationS: 212 })).toBe(false);
  });

  it('does not guess from a missing id', () => {
    for (const reportedVideoId of [null, undefined, '']) {
      expect(isAdPlaying({ ...probe, reportedVideoId })).toBe(false);
    }
  });

  it('does not judge the duration before the real one is known, or when the player has none', () => {
    expect(isAdPlaying({ ...probe, knownDurationS: null, reportedDurationS: 15 })).toBe(false);
    expect(isAdPlaying({ ...probe, knownDurationS: 0, reportedDurationS: 15 })).toBe(false);
    expect(isAdPlaying({ ...probe, reportedDurationS: 0 })).toBe(false);
    expect(isAdPlaying({ ...probe, reportedDurationS: Number.NaN })).toBe(false);
  });

  it('lets either signal alone decide', () => {
    expect(isAdPlaying({ ...probe, reportedVideoId: 'adadadadada', reportedDurationS: 213 })).toBe(true);
    expect(isAdPlaying({ ...probe, reportedVideoId: null, reportedDurationS: 30 })).toBe(true);
  });
});
