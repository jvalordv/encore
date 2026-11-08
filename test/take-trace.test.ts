/**
 * Tests for the analysis track kept with a take (src/app/take-trace.ts): the
 * gate verdict matches the live gate, the raw reading survives speaker mode
 * while the scored fields stay as they were, the event log and the health
 * samples follow the state, the melody and key are cut to the take's span,
 * and the JSON export carries it all (and still reads an older take).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDrawable } from '../src/analysis/mic-level';
import { scoreTake } from '../src/analysis/open-score';
import { initialState } from '../src/app/state';
import { TAKE_EXPORT_VERSION, takeExportJson } from '../src/app/take-export';
import {
  appVersion,
  gateReasonOf,
  HEALTH_EVERY_S,
  keyForSpan,
  sliceReference,
  TakeTraceRecorder,
  toTakeFrame,
} from '../src/app/take-trace';
import type { AppState } from '../src/app/state';
import type { TakeRecord } from '../src/app/takes';
import { ServiceClient } from '../src/service/client';
import { fakeLane, makeHarness, songInfo } from './session-harness';
import type { Harness } from './session-harness';

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VOICE = 0.2;
const HISS = 1e-4;
const FAINT = HISS * 10 ** (2 / 20);

describe('the gate verdict', () => {
  it('agrees with isDrawable for every combination', () => {
    const floor = -80;
    for (const f0 of [0, 220]) {
      for (const clarity of [0.5, 0.95]) {
        for (const rms of [HISS, FAINT, VOICE]) {
          const f = { f0, clarity, rms };
          expect(gateReasonOf(f, floor, 0.9) === null).toBe(isDrawable(f, floor, 0.9));
        }
      }
    }
  });

  it('names the first check that failed', () => {
    expect(gateReasonOf({ f0: 0, clarity: 0.1, rms: VOICE }, -80, 0.9)).toBe('unvoiced');
    expect(gateReasonOf({ f0: 220, clarity: 0.5, rms: VOICE }, -80, 0.9)).toBe('unclear');
    expect(gateReasonOf({ f0: 220, clarity: 0.95, rms: FAINT }, -80, 0.9)).toBe('quiet');
  });

  it('stores the raw f0 only where it differs, and the gate only on failure', () => {
    const f = { t: 1, f0: 0, clarity: 0.95, rms: FAINT };
    expect(toTakeFrame(f, 220, 'quiet')).toEqual({ ...f, rawF0: 220, gate: 'quiet' });
    expect(toTakeFrame({ ...f, f0: 220 }, 220, undefined)).toEqual({ ...f, f0: 220 });
  });

  it('reads a build version', () => {
    expect(typeof appVersion()).toBe('string');
    expect(appVersion().length).toBeGreaterThan(0);
  });
});

describe('the event log', () => {
  function make() {
    let ms = 0;
    const rec = new TakeTraceRecorder(() => ms);
    const state = initialState();
    const set = (patch: Partial<AppState>, at: number) => {
      ms = at;
      Object.assign(state, patch);
      rec.onState(state, new Set(Object.keys(patch) as Array<keyof AppState>));
    };
    rec.start(state);
    return { rec, state, set, tick: (at: number) => (ms = at) };
  }

  it('logs player, mix, mode, scoring and loop changes with times', () => {
    const { rec, state, set } = make();
    set({ player: 'playing' }, 500);
    set({ player: 'ad' }, 1500);
    set({ player: 'playing' }, 3000);
    set({ mix: { ...state.mix, choice: 'karaoke' } }, 3500);
    set({ mode: 'learning', scoring: 'open' }, 4000);
    set({ loop: { startS: 1, endS: 2 } }, 4500);
    expect(rec.events.map((e) => [e.at, e.kind, e.value])).toEqual([
      [0.5, 'player', 'playing'],
      [1.5, 'player', 'ad'],
      [3, 'player', 'playing'],
      [3.5, 'mix', 'karaoke'],
      [4, 'mode', 'learning'],
      [4, 'scoring', 'open'],
      [4.5, 'loop', '1.00-2.00'],
    ]);
  });

  it('logs a mic or monitor switch', () => {
    const { rec, state, set } = make();
    set({ input: { ...state.input, open: true, label: 'USB', monitor: 'speakers' } }, 100);
    expect(rec.events.map((e) => e.kind).sort()).toEqual(['input', 'monitor']);
  });

  it('calls a jump in position a seek, but not the clock running', () => {
    const { rec, set } = make();
    set({ player: 'playing', positionS: 0 }, 0);
    set({ positionS: 0.5 }, 500);
    set({ positionS: 1.0 }, 1000);
    expect(rec.events.filter((e) => e.kind === 'seek')).toHaveLength(0);
    set({ positionS: 30 }, 1500);
    expect(rec.events.at(-1)).toMatchObject({ kind: 'seek', value: 30, songT: 30 });
    set({ player: 'paused' }, 1600);
    set({ positionS: 12 }, 2000);
    expect(rec.events.at(-1)).toMatchObject({ kind: 'seek', value: 12 });
  });

  it('does not call a loop wrap a seek, but a seek inside the loop still is', () => {
    const { rec, set } = make();
    set({ player: 'playing', positionS: 0, loop: { startS: 10, endS: 20 } }, 0);
    set({ positionS: 19.5 }, 100);
    const before = rec.events.filter((e) => e.kind === 'seek').length;
    set({ positionS: 10.2 }, 600);
    expect(rec.events.filter((e) => e.kind === 'seek')).toHaveLength(before);
    set({ positionS: 15 }, 1100);
    expect(rec.events.at(-1)).toMatchObject({ kind: 'seek', value: 15 });
  });

  it('ends a full log with one truncation marker', () => {
    const { rec, set } = make();
    for (let i = 0; i < 2100; i++) set({ mode: i % 2 ? 'karaoke' : 'learning' }, i);
    expect(rec.events).toHaveLength(2001);
    expect(rec.events.at(-1)).toMatchObject({ kind: 'truncated', value: true });
    expect(rec.events.filter((e) => e.kind === 'truncated')).toHaveLength(1);
  });

  it('samples health about four times a second', () => {
    const { rec, state } = make();
    state.input.floorDb = -60;
    for (let i = 0; i < 100; i++) rec.sampleHealth(i * 0.01, state);
    expect(rec.health).toHaveLength(Math.ceil(1 / HEALTH_EVERY_S));
    expect(rec.health[0]).toEqual({ t: 0, floorDb: -60, micState: 'nothing', bleed: 'unknown' });
  });
});

describe('the melody and key for the span', () => {
  it('cuts the contour to the span, with the time of its first sample', () => {
    const ref = { hopS: 0.1, t0S: 0, f0Hz: Array.from({ length: 100 }, (_, i) => 100 + i + 0.04) };
    const out = sliceReference(ref, 2, 3)!;
    expect(out.t0S).toBeCloseTo(2, 6);
    expect(out.f0Hz[0]).toBe(120);
    expect(out.f0Hz).toHaveLength(11);
    expect(sliceReference(null, 0, 1)).toBeUndefined();
  });

  it('keeps the key segments that overlap', () => {
    const seg = (a: number, b: number) => ({ start_s: a, end_s: b, tonic: 0, mode: 'major' as const, confidence: 1 });
    const key = { tuning_cents: 3, segments: [seg(0, 10), seg(10, 20), seg(20, 30)] };
    expect(keyForSpan(key, 12, 18)!.segments).toHaveLength(1);
    expect(keyForSpan(key, 5, 25)!.segments).toHaveLength(3);
    expect(keyForSpan(null, 0, 1)).toBeUndefined();
  });
});

let clock = 0;
function frame(h: Harness, f0: number, rms: number, clarity = 0.95): void {
  clock += 0.01;
  h.engine.t = clock;
  h.player.positionS = clock;
  h.tracker.emit({ t: clock, f0, clarity, rms });
}

describe('a recorded take', () => {
  beforeEach(() => {
    clock = 0;
  });

  async function recordSpeakerTake() {
    const h = makeHarness({ monitor: 'speakers' });
    h.player.setSong(songInfo());
    h.core.lane = fakeLane();
    await h.core.input.chooseInput('usb');
    h.player.play();
    for (let i = 0; i < 60; i++) frame(h, 0, HISS, 0.1);
    await h.core.takes.toggleRecord();
    frame(h, 220, FAINT);
    frame(h, 220, VOICE);
    frame(h, 0, HISS, 0.1);
    await h.core.takes.toggleRecord();
    const [summary] = await h.takeStore.list();
    return { h, take: (await h.takeStore.get(summary.id))! };
  }

  it('keeps the raw reading of a gated frame while f0 stays 0', async () => {
    const { take } = await recordSpeakerTake();
    expect(take.frames.map((f) => f.f0)).toEqual([0, 220, 0]);
    expect(take.frames[0]).toMatchObject({ rawF0: 220, gate: 'quiet' });
    expect(take.frames[1].gate).toBeUndefined();
    expect(take.frames[1].rawF0).toBeUndefined();
    expect(take.frames[2].gate).toBe('unvoiced');
  });

  it('scores the same with or without the extra fields', async () => {
    const { take } = await recordSpeakerTake();
    const plain = take.frames.map(({ t, f0, clarity, rms }) => ({ t, f0, clarity, rms }));
    for (const style of ['strict', 'open'] as const) {
      const opts = { octaveInvariant: false, style, key: null, freeSpans: [] };
      expect(scoreTake(take.frames, null, opts)).toEqual(scoreTake(plain, null, opts));
    }
  });

  it('carries the environment, health and the log, and exports them', async () => {
    const { take } = await recordSpeakerTake();
    expect(take.trace?.environment.analysis).toMatchObject({ clarityThreshold: 0.85, mode: 'karaoke' });
    expect(take.trace?.environment.tracker).toEqual({
      minF0Hz: 90,
      maxF0Hz: 1200,
      highpassHz: 120,
      faintClarity: 0.75,
      faintDrawMarginDb: 4,
    });
    expect(take.trace?.environment.appVersion).toBe(appVersion());
    expect(take.trace?.health.length).toBeGreaterThan(0);
    const json = takeExportJson(take);
    expect(json.version).toBe(TAKE_EXPORT_VERSION);
    expect(TAKE_EXPORT_VERSION).toBe(3);
    expect(json.trace).toEqual(take.trace);
    expect((json.frames as Array<Record<string, unknown>>)[0]).toMatchObject({ rawF0: 220, gate: 'quiet' });
  });

  it('exports an older take with no trace', () => {
    const old = {
      id: 'x',
      songHash: 'h',
      songName: 's',
      createdAt: 0,
      durationS: 1,
      latencyS: 0,
      sampleRate: 48000,
      frames: [{ t: 0, f0: 1, clarity: 1, rms: 1 }],
      wav: new Blob([]),
    } as TakeRecord;
    const json = takeExportJson(old);
    expect(json.trace).toBeNull();
    expect(json.frames).toEqual(old.frames);
  });
});
