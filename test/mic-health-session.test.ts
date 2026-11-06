/**
 * Controller tests for the mic diagnostics on the fake-parts harness: the
 * level and state the meter shows, the level gate (a gap on the lane in both
 * modes, and a frame dropped before the take and the scorer in speaker mode),
 * the bleed check and its reasons, and the karaoke note guide (off by default,
 * karaoke mode only, nothing stored with a take).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings } from '../src/app/settings';
import type { LaneReference } from '../src/render/lane-geometry';
import { ServiceClient } from '../src/service/client';
import { fakeLane, makeHarness, songInfo } from './session-harness';
import type { Harness } from './session-harness';

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** RMS of a loud voice, and of hiss; the gate sits 8 dB over the hiss. */
const VOICE = 0.2;
const HISS = 1e-4;
/** A level 2 dB over the hiss: voiced and clear, but too quiet to be a voice. */
const FAINT = HISS * 10 ** (2 / 20);

/** A playing song, the mic open in `monitor` mode, the lane faked. */
async function ready(monitor: 'headphones' | 'speakers' = 'headphones', saved: Record<string, unknown> = {}) {
  const h = makeHarness({ monitor, ...saved });
  h.player.setSong(songInfo());
  const lane = fakeLane();
  h.core.lane = lane;
  await h.core.input.chooseInput('usb');
  h.player.play();
  return { h, lane };
}

let clock = 0;
/** Emits one tracker frame at the next 10 ms step of song time. */
function frame(h: Harness, f0: number, rms: number, clarity = 0.95): void {
  clock += 0.01;
  h.engine.t = clock;
  h.player.positionS = clock;
  h.tracker.emit({ t: clock, f0, clarity, rms });
}

/** `n` frames of hiss, unvoiced, so the floor is known. */
function listen(h: Harness, n = 60): void {
  for (let i = 0; i < n; i++) frame(h, 0, HISS, 0.1);
}

beforeEach(() => {
  clock = 0;
});

describe('the level and state the meter shows', () => {
  it('starts with nothing, then hears a voice over the hiss', async () => {
    const { h } = await ready();
    listen(h);
    expect(h.store.state.input.micState).toBe('nothing');
    expect(h.store.state.input.floorDb).toBeCloseTo(-80, 0);
    for (let i = 0; i < 30; i++) frame(h, 220, VOICE);
    expect(h.store.state.input.micState).toBe('hearing');
    expect(h.store.state.input.levelDb).toBeCloseTo(-14, 0);
  });

  it('calls a faint signal too quiet', async () => {
    const { h } = await ready();
    listen(h);
    for (let i = 0; i < 30; i++) frame(h, 0, HISS * 10 ** (8 / 20), 0.1);
    expect(h.store.state.input.micState).toBe('quiet');
  });

  it('forgets the floor and the state when the mic goes', async () => {
    const { h } = await ready();
    listen(h);
    for (let i = 0; i < 30; i++) frame(h, 220, VOICE);
    h.mic.unplug();
    const { input } = h.store.state;
    expect(input.micState).toBe('nothing');
    expect(input.floorDb).toBe(-120);
    expect(input.bleed.reason).toBe('off');
  });
});

describe('the level gate', () => {
  it('draws a gap for a frame too quiet to be a voice, with headphones too', async () => {
    const { h, lane } = await ready('headphones');
    listen(h);
    lane.pushFrame.mockClear();
    frame(h, 220, FAINT);
    frame(h, 220, VOICE);
    const [faint, loud] = lane.pushFrame.mock.calls.map((c) => c[0] as { f0: number });
    expect(faint.f0).toBe(0);
    expect(loud.f0).toBe(220);
  });

  it('leaves the take and the scorer the original frame with headphones', async () => {
    const { h } = await ready('headphones');
    listen(h);
    const seen: number[] = [];
    h.core.bus.subscribe(({ frame: f }) => seen.push(f.f0));
    frame(h, 220, FAINT);
    expect(seen).toEqual([220]);
  });

  it('drops it before the take and the scorer in speaker mode', async () => {
    const { h, lane } = await ready('speakers');
    expect(h.store.state.input.requestedAec).toBe(true);
    listen(h);
    const seen: number[] = [];
    h.core.bus.subscribe(({ frame: f }) => seen.push(f.f0));
    lane.pushFrame.mockClear();
    frame(h, 220, FAINT);
    frame(h, 220, VOICE);
    expect(seen).toEqual([0, 220]);
    expect((lane.pushFrame.mock.calls[0][0] as { f0: number }).f0).toBe(0);
  });

  it('passes everything while no floor is known yet', async () => {
    const { h } = await ready('speakers');
    const seen: number[] = [];
    h.core.bus.subscribe(({ frame: f }) => seen.push(f.f0));
    frame(h, 220, FAINT);
    expect(seen).toEqual([220]);
  });
});

describe('reopening the mic', () => {
  it('forgets the old floor and bleed when the monitor mode changes while open', async () => {
    const { h } = await ready('headphones');
    listen(h, 200);
    expect(h.store.state.input.floorDb).toBeCloseTo(-80, 0);
    await h.core.input.setMonitor('speakers');
    const { input } = h.store.state;
    expect(input.requestedAec).toBe(true);
    expect(input.floorDb).toBe(-120);
    expect(input.micState).toBe('nothing');
    expect(input.bleed.reason).not.toBe('measured');
    // The new path's floor is learnt afresh, not the old -80 dB one.
    for (let i = 0; i < 60; i++) frame(h, 0, 1e-2, 0.1);
    expect(h.store.state.input.floorDb).toBeCloseTo(-40, 0);
  });
});

describe('the bleed check', () => {
  /** A melody that sits on 440 Hz for the first 30 s. */
  const contour: LaneReference = {
    hopS: 0.01,
    t0S: 0,
    f0Hz: new Array<number>(3000).fill(440),
    notes: [],
    unpitchedS: [],
  };
  const withMelody = (h: Harness): void => {
    (h.core.stems as unknown as { laneReference: LaneReference }).laneReference = contour;
  };

  it('suspects a mic that follows the melody exactly, in speaker mode', async () => {
    const { h } = await ready('speakers');
    withMelody(h);
    listen(h);
    for (let i = 0; i < 300; i++) frame(h, 440, VOICE);
    expect(h.store.state.input.bleed).toEqual({ state: 'suspected', reason: 'measured' });
  });

  it('says it cannot check until the song is prepared, when there is no melody', async () => {
    const { h } = await ready('speakers');
    listen(h);
    for (let i = 0; i < 20; i++) frame(h, 440, VOICE);
    expect(h.store.state.input.bleed).toEqual({ state: 'unknown', reason: 'no_reference' });
  });

  it('is not armed with the karaoke stem, which carries no melody', async () => {
    const { h } = await ready('speakers');
    withMelody(h);
    h.store.patch({ mix: { ...h.store.state.mix, choice: 'karaoke' } });
    listen(h);
    for (let i = 0; i < 300; i++) frame(h, 440, VOICE);
    expect(h.store.state.input.bleed).toEqual({ state: 'unknown', reason: 'no_vocal' });
  });

  it('is off with headphones', async () => {
    const { h } = await ready('headphones');
    withMelody(h);
    listen(h);
    for (let i = 0; i < 300; i++) frame(h, 440, VOICE);
    expect(h.store.state.input.bleed.reason).toBe('off');
  });
});

describe('the note guide', () => {
  it('is off by default and shows nothing', async () => {
    const { h } = await ready();
    expect(h.store.state.noteGuide).toBe(false);
    listen(h);
    for (let i = 0; i < 50; i++) frame(h, 440, VOICE);
    expect(h.store.state.guideReading).toBeNull();
  });

  it('reads the nearest note once turned on, and remembers the choice', async () => {
    const { h } = await ready();
    h.core.health.setNoteGuide(true);
    expect(loadSettings(h.settingsStore).noteGuide).toBe(true);
    listen(h);
    for (let i = 0; i < 50; i++) frame(h, 440, VOICE);
    expect(h.store.state.guideReading).toEqual({ note: 'A4', centsOff: 0 });
  });

  it('comes back as it was saved', () => {
    const h = makeHarness({ noteGuide: true });
    expect(h.store.state.noteGuide).toBe(true);
  });

  it('goes quiet in learning mode', async () => {
    const { h } = await ready();
    h.core.health.setNoteGuide(true);
    listen(h);
    for (let i = 0; i < 50; i++) frame(h, 440, VOICE);
    h.core.scoring.setMode('learning');
    for (let i = 0; i < 20; i++) frame(h, 440, VOICE);
    expect(h.store.state.guideReading).toBeNull();
  });

  it('stores nothing with a take', async () => {
    const { h } = await ready();
    h.core.health.setNoteGuide(true);
    listen(h);
    await h.core.takes.toggleRecord();
    for (let i = 0; i < 20; i++) frame(h, 440, VOICE);
    await h.core.takes.toggleRecord();
    const [summary] = await h.takeStore.list();
    expect(JSON.stringify(summary)).not.toContain('A4');
    expect(Object.keys((await h.takeStore.get(summary.id)) ?? {})).not.toContain('guide');
  });
});

describe('the mic settings kept with a take', () => {
  it('records the mic, mix and floor as the take began', async () => {
    const { h } = await ready('speakers');
    listen(h);
    await h.core.takes.toggleRecord();
    for (let i = 0; i < 20; i++) frame(h, 220, VOICE);
    await h.core.takes.toggleRecord();
    const [summary] = await h.takeStore.list();
    expect(summary.mic).toMatchObject({
      inputLabel: 'mic usb',
      monitor: 'speakers',
      requestedAec: true,
      clarityThreshold: 0.9,
      mix: { choice: 'original' },
    });
    expect(summary.mic?.noiseFloorDb).toBeCloseTo(-80, 0);
  });

  it('hands a take over as a WAV and as JSON with its frames', async () => {
    const { h } = await ready();
    listen(h);
    await h.core.takes.toggleRecord();
    for (let i = 0; i < 20; i++) frame(h, 220, VOICE);
    await h.core.takes.toggleRecord();
    const [summary] = await h.takeStore.list();
    const wav = await h.core.takes.exportFile(summary.id, 'wav');
    const json = await h.core.takes.exportFile(summary.id, 'json');
    expect(wav?.name).toMatch(/\.wav$/);
    expect(json?.name).toMatch(/\.json$/);
    const parsed = JSON.parse(await json!.blob.text());
    expect(parsed.frames).toHaveLength(20);
    expect(parsed.mic.inputLabel).toBe('mic usb');
    expect(await h.core.takes.exportFile('nope', 'json')).toBeNull();
    expect(h.store.state.status.text).toBe('That take is gone.');
  });
});
