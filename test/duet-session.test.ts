/**
 * Controller tests for two singers on the fake-parts harness: the settings
 * (names, colours, kept), singer B's own mic (frames on the bus as singer 1,
 * stamped with B's own latency, gated by B's own floor), the turns of one mic
 * (from the melody's phrases, then from synced lyric lines; clicks cycle and
 * are kept per song), the ribbon a frame is drawn on, and the per-singer
 * reports of a take on one mic and on two. Karaoke mode attributes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScoreReference } from '../src/analysis/score';
import { openReports } from '../src/app/learning';
import { loadSettings } from '../src/app/settings';
import { ServiceClient } from '../src/service/client';
import type { SingerFrame } from '../src/app/session/frame-bus';
import { fakeLane, makeHarness, songInfo } from './session-harness';
import type { Harness } from './session-harness';

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Two short notes, A4 then E5, with a long rest between: two phrases. */
const NOTES = [
  { onsetS: 1, offsetS: 1.2, midi: 69 },
  { onsetS: 3, offsetS: 3.2, midi: 76 },
];
const MELODY = buildScoreReference(NOTES, [], { lowMidi: 69, highMidi: 76 });
const A4 = 440;
const E5 = 659.26;

/** A harness with a song, the melody and the lane in place and the mic open. */
async function ready(saved: Record<string, unknown> = {}) {
  const h = makeHarness(saved);
  h.player.setSong(songInfo());
  const lane = fakeLane();
  h.core.lane = lane;
  h.core.scoring.setReference(MELODY);
  // The lane's copy of the melody is what the turns are cut from.
  (h.core.stems as unknown as { laneReference: unknown }).laneReference = {
    hopS: 0.01,
    t0S: 0,
    f0Hz: [],
    notes: NOTES,
  };
  h.core.duet.setLyricLines([]);
  await h.core.input.chooseInput('usb');
  return { h, lane };
}

/** Puts a frame on mic A (or B) at song time `t`, the song playing. */
function sing(h: Harness, t: number, hz: number, who: 'a' | 'b' = 'a', rms = 0.2): void {
  h.engine.t = t;
  h.player.positionS = t;
  (who === 'a' ? h.tracker : h.trackerB).emit({ t, f0: hz, clarity: 0.95, rms });
}

describe('the settings', () => {
  it('starts with singer B off and keeps names and colours', () => {
    const { h } = { h: makeHarness() };
    expect(h.store.state.duet).toMatchObject({ secondSinger: false, kind: 'off', names: ['Singer A', 'Singer B'] });
    h.core.duet.setSecondSinger(true);
    h.core.duet.setName(0, '  Ann ');
    h.core.duet.setName(1, 'Bo');
    h.core.duet.setColour(1, '#FF00AA');
    expect(h.store.state.duet).toMatchObject({ secondSinger: true, kind: 'one-mic', names: ['Ann', 'Bo'] });
    expect(loadSettings(h.settingsStore).duet).toEqual({
      secondSinger: true,
      names: ['Ann', 'Bo'],
      colours: [null, '#ff00aa'],
      inputDeviceIdB: null,
    });
    h.core.duet.setName(0, '   ');
    expect(h.store.state.duet.names[0]).toBe('Singer A');
  });

  it('comes back as it was saved', () => {
    const h = makeHarness({ duet: { secondSinger: true, names: ['Ann', 'Bo'], colours: [null, null] } });
    expect(h.store.state.duet).toMatchObject({ secondSinger: true, kind: 'one-mic', names: ['Ann', 'Bo'] });
  });

  it('gives the lane the names and colours of the strip', async () => {
    const { h, lane } = await ready();
    h.core.duet.setSecondSinger(true);
    h.core.duet.setColour(0, '#112233');
    const [turns, look] = lane.setTurns.mock.calls.at(-1) ?? [];
    expect(turns).toHaveLength(2);
    expect(look).toMatchObject({ colours: ['#112233', null], names: ['Singer A', 'Singer B'] });
  });
});

describe('turns on one mic', () => {
  it('cuts the melody into phrases, A then B', async () => {
    const { h } = await ready();
    h.core.duet.setSecondSinger(true);
    const { duet } = h.store.state;
    expect(duet.turnSource).toBe('phrases');
    expect(duet.turns.map((t) => [t.startS, t.endS, t.who])).toEqual([
      [1, 1.2, 'a'],
      [3, 3.2, 'b'],
    ]);
  });

  it('draws no turns with singer B off', async () => {
    const { h } = await ready();
    expect(h.store.state.duet.turns).toEqual([]);
    expect(h.store.state.duet.turnSource).toBe('none');
  });

  it('follows synced lyric lines instead of note gaps', async () => {
    const { h } = await ready();
    h.core.duet.setSecondSinger(true);
    h.core.duet.setLyricLines([
      { t: 0, text: 'one' },
      { t: 2, text: 'two' },
      { t: 4, text: 'three' },
      { t: 6, text: '' },
    ]);
    const { duet } = h.store.state;
    expect(duet.turnSource).toBe('lyrics');
    expect(duet.turns.map((t) => t.who)).toEqual(['a', 'b', 'a']);
    h.core.duet.setLyricLines([]);
    expect(h.store.state.duet.turnSource).toBe('phrases');
  });

  it('cycles a clicked stretch A, B, both and keeps it for the song', async () => {
    const { h, lane } = await ready();
    h.core.duet.setSecondSinger(true);
    h.core.duet.syncLane();
    const click = lane.setTurnClick.mock.calls.at(-1)?.[0] as (startS: number) => void;
    click(1);
    expect(h.store.state.duet.turns[0].who).toBe('b');
    click(1);
    expect(h.store.state.duet.turns[0].who).toBe('both');
    click(1);
    expect(h.store.state.duet.turns[0].who).toBe('a');
    click(3);
    expect(h.store.state.duet.turns[1].who).toBe('both');
    expect(h.settingsStore.get(`duet.turns.${songInfo().hash}`)).toBe('{"3.00":"both"}');
  });

  it('draws each frame on the ribbon of whoever\'s turn it is, in learning mode only', async () => {
    const { h, lane } = await ready({ mode: 'learning', duet: { secondSinger: true } });
    h.core.playback.play();
    sing(h, 1.05, A4);
    sing(h, 3.05, E5);
    expect(lane.pushFrame.mock.calls.map((c) => c[1] ?? 0)).toEqual([0, 1]);
    h.core.scoring.setMode('karaoke');
    lane.pushFrame.mockClear();
    sing(h, 3.06, E5);
    expect(lane.pushFrame.mock.calls.map((c) => c[1] ?? 0)).toEqual([0]);
  });
});

describe('singer B\'s own mic', () => {
  it('opens its own device and publishes its frames as singer 1', async () => {
    const { h } = await ready();
    const seen: SingerFrame[] = [];
    h.core.bus.subscribe((m) => seen.push(m));
    expect(await h.core.duet.chooseSecondInput('usb-b')).toBe('open');
    expect(h.micB.open).toHaveBeenCalledWith('usb-b', 1, 'headphones');
    expect(h.store.state.duet.kind).toBe('two-mics');
    expect(h.store.state.singers[1].input).toMatchObject({ open: true, deviceId: 'usb-b' });
    h.core.playback.play();
    sing(h, 2, E5, 'b');
    sing(h, 2.01, A4, 'a');
    expect(seen.map((m) => m.singer)).toEqual([1, 0]);
    expect(h.core.current.duet.inputDeviceIdB).toBe('usb-b');
  });

  it('stamps B\'s frames with B\'s own latency, not A\'s', async () => {
    const { h } = await ready();
    h.core.latency.setLatency(0.1);
    await h.core.duet.chooseSecondInput('usb-b');
    h.core.duet.setSecondLatency(0.25);
    expect(h.store.state.duet.latencyBS).toBe(0.25);
    expect(h.store.state.latencyS).toBe(0.1);
    const seen: SingerFrame[] = [];
    h.core.bus.subscribe((m) => seen.push(m));
    h.core.playback.play();
    sing(h, 2, A4, 'a');
    sing(h, 2, E5, 'b');
    const [a, b] = seen;
    expect(a.frame.t).toBeCloseTo(2 - 0.1, 6);
    expect(b.frame.t).toBeCloseTo(2 - 0.25, 6);
    // Stored per pair, so the same mic comes back with its latency.
    expect(Object.values(loadSettings(h.settingsStore).latencyByDevicePair).sort()).toEqual([0.1, 0.25]);
  });

  it('gates and meters B by its own floor', async () => {
    const { h } = await ready();
    await h.core.duet.chooseSecondInput('usb-b');
    // A's room is quiet, B's is noisy: 80 frames of hiss each.
    for (let i = 0; i < 80; i++) {
      const t = 0.1 + i * 0.01;
      h.engine.t = t;
      h.tracker.emit({ t, f0: 0, clarity: 0.1, rms: 1e-4 });
      h.trackerB.emit({ t, f0: 0, clarity: 0.1, rms: 0.02 });
    }
    expect(h.store.state.singers[1].input.floorDb).toBeGreaterThan(h.store.state.input.floorDb + 20);
    // A voice that clears A's floor is too quiet for B's.
    h.core.playback.play();
    const seen: SingerFrame[] = [];
    h.core.bus.subscribe((m) => seen.push(m));
    sing(h, 2, A4, 'a', 0.01);
    sing(h, 2, E5, 'b', 0.01);
    expect(seen.map((m) => [m.singer, m.gated])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(seen[1].gateReason).toBe('quiet');
  });

  it('reads B\'s tuning for B\'s own device pair', async () => {
    const tuning = { drawMarginDb: 20, clarityThreshold: 0.8, bleedMatchCents: 25, bleedMinMatch: 0.7, bleedMaxMedianCents: 12 };
    const { h } = await ready({ micTuningByDevicePair: { 'latency.default|usb-b': tuning } });
    await h.core.duet.chooseSecondInput('usb-b');
    expect(h.trackerB.clarityThreshold).toBe(0.8);
    expect(h.tracker.clarityThreshold).toBe(0.85);
  });

  it('closes B\'s mic without touching A\'s, and back to turns', async () => {
    const { h } = await ready();
    await h.core.duet.chooseSecondInput('usb-b');
    h.core.duet.closeSecondInput();
    expect(h.micB.close).toHaveBeenCalled();
    expect(h.store.state.singers[1].input.open).toBe(false);
    expect(h.store.state.input.open).toBe(true);
    expect(h.store.state.duet.kind).toBe('one-mic');
  });

  it('turns singer B off, closing the second mic', async () => {
    const { h } = await ready();
    await h.core.duet.chooseSecondInput('usb-b');
    h.core.duet.setSecondSinger(false);
    expect(h.store.state.duet.kind).toBe('off');
    expect(h.micB.close).toHaveBeenCalled();
  });
});

describe('a take', () => {
  /** Records from 0 to 4 s, singing the notes as `sung` says. */
  async function record(h: Harness, sung: (t: number) => Array<[number, 'a' | 'b']>): Promise<void> {
    await h.core.takes.toggleRecord();
    for (let i = 0; i < 400; i++) {
      const t = i * 0.01;
      for (const [hz, who] of sung(t)) sing(h, t, hz, who);
    }
    await h.core.takes.toggleRecord();
  }

  it('gives each singer a report on one mic taking turns', async () => {
    const { h } = await ready({ mode: 'learning', duet: { secondSinger: true, names: ['Ann', 'Bo'] } });
    await record(h, (t) => (t >= 1 && t < 1.2 ? [[A4, 'a']] : t >= 3 && t < 3.2 ? [[E5, 'a']] : []));
    const [take] = h.store.state.takes;
    expect(take.report?.notes.map((n) => n.index)).toEqual([0]);
    expect(take.duet).toMatchObject({ mode: 'one-mic', names: ['Ann', 'Bo'], shared: [] });
    expect(take.duet?.reportB.notes.map((n) => n.index)).toEqual([1]);
    expect(take.duet?.reportB.inTuneRate).toBe(1);
    const open = openReports(h.store.state);
    expect(open?.cards.map((c) => c.name)).toEqual(['Ann', 'Bo']);
  });

  it('counts a stretch marked both for both singers, and says so', async () => {
    const { h } = await ready({ mode: 'learning', duet: { secondSinger: true } });
    h.core.duet.clickTurn(3);
    await record(h, (t) => (t >= 1 && t < 1.2 ? [[A4, 'a']] : t >= 3 && t < 3.2 ? [[E5, 'a']] : []));
    const [take] = h.store.state.takes;
    expect(take.duet?.shared).toEqual([[3, 3.2]]);
    expect(take.report?.notes.map((n) => n.index)).toEqual([0, 1]);
    expect(take.duet?.reportB.notes.map((n) => n.index)).toEqual([1]);
  });

  it('gives each singer a report with a mic each, B from its own frames', async () => {
    const { h } = await ready({ mode: 'learning' });
    await h.core.duet.chooseSecondInput('usb-b');
    await record(h, (t) => (t >= 1 && t < 1.2 ? [[A4, 'a'], [E5, 'b']] : t >= 3 && t < 3.2 ? [[E5, 'a'], [E5, 'b']] : []));
    const [take] = h.store.state.takes;
    expect(take.duet?.mode).toBe('two-mics');
    // A sang a wrong note in the second phrase, B a wrong one in the first.
    expect(take.report?.notes.map((n) => n.index)).toEqual([0, 1]);
    expect(take.report?.notes[0].meanCents).not.toBeNull();
    expect(Math.abs(take.report?.notes[0].meanCents ?? 99)).toBeLessThan(25);
    expect(Math.abs(take.duet?.reportB.notes[0].meanCents ?? 0)).toBeGreaterThan(100);
    const record2 = await (await h.core.takesReady).get(take.id);
    expect(record2?.duetFramesB?.length).toBeGreaterThan(0);
  });

  it('keeps B\'s frames out of A\'s take', async () => {
    const { h } = await ready({ mode: 'learning' });
    await h.core.duet.chooseSecondInput('usb-b');
    await record(h, (t) => (t >= 1 && t < 1.2 ? [[E5, 'b']] : []));
    const take = await (await h.core.takesReady).get(h.store.state.takes[0].id);
    expect(take?.frames.filter((f) => f.f0 > 0)).toHaveLength(0);
    expect(take?.duetFramesB?.filter((f) => f.f0 > 0).length).toBeGreaterThan(10);
  });

  it('is judged by no one in karaoke mode, with or without singer B', async () => {
    const { h } = await ready({ duet: { secondSinger: true } });
    await record(h, (t) => (t >= 1 && t < 1.2 ? [[A4, 'a']] : []));
    const [take] = h.store.state.takes;
    expect(take.report).toBeUndefined();
    expect(take.duet).toBeUndefined();
    expect(openReports(h.store.state)).toBeNull();
  });

  it('is plain singer A\'s when singer B is off, as before', async () => {
    const { h } = await ready({ mode: 'learning' });
    await record(h, (t) => (t >= 1 && t < 1.2 ? [[A4, 'a']] : []));
    const [take] = h.store.state.takes;
    expect(take.report).toBeDefined();
    expect(take.duet).toBeUndefined();
    expect(openReports(h.store.state)?.cards.map((c) => c.singer)).toEqual([0]);
  });
});

describe('review fixes', () => {
  /** Records from 0 to 4 s, singing as `sung` says. */
  async function record(h: Harness, sung: (t: number) => Array<[number, 'a' | 'b']>): Promise<void> {
    await h.core.takes.toggleRecord();
    for (let i = 0; i < 400; i++) {
      const t = i * 0.01;
      for (const [hz, who] of sung(t)) sing(h, t, hz, who);
    }
    await h.core.takes.toggleRecord();
  }

  /** Lets the controller's reopen promise settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('keeps singer A\'s take whole when one mic has no turns to split', async () => {
    const { h } = await ready({ mode: 'learning', duet: { secondSinger: true } });
    (h.core.stems as unknown as { laneReference: unknown }).laneReference = { hopS: 0.01, t0S: 0, f0Hz: [], notes: [] };
    h.core.duet.setLyricLines([]);
    expect(h.store.state.duet.turns).toEqual([]);
    await record(h, (t) => (t >= 1 && t < 1.2 ? [[A4, 'a']] : []));
    const [take] = h.store.state.takes;
    expect(take.duet).toBeUndefined();
    expect(take.report).toBeDefined();
    const saved = await (await h.core.takesReady).get(take.id);
    expect(saved?.frames.filter((f) => f.f0 > 0).length).toBeGreaterThan(10);
  });

  it('counts only singer A\'s turns toward the streak on one mic', async () => {
    const { h } = await ready({ mode: 'learning', duet: { secondSinger: true } });
    await record(h, (t) => (t >= 1 && t < 1.2 ? [[A4, 'a']] : t >= 3 && t < 3.2 ? [[E5, 'a']] : []));
    const saved = await (await h.core.takesReady).get(h.store.state.takes[0].id);
    const voiced = saved?.frames.filter((f) => f.f0 > 0).length ?? 0;
    expect(voiced).toBeGreaterThan(30);
    expect(saved?.voicedFrames).toBeGreaterThan(10);
    expect(saved?.voicedFrames).toBeLessThan(voiced * 0.75);
  });

  it('releases B\'s mic when the tracker cannot connect, and when there is no source', async () => {
    const { h } = await ready();
    h.trackerB.connect.mockImplementationOnce(() => {
      throw new Error('no worklet');
    });
    expect(await h.core.duet.chooseSecondInput('usb-b')).toBe('failed');
    expect(h.trackerB.disconnect).toHaveBeenCalled();
    expect(h.micB.close).toHaveBeenCalledTimes(1);
    expect(h.store.state.singers[1].input.open).toBe(false);
    h.micB.open.mockImplementationOnce(async () => {
      h.micB.source = null;
    });
    expect(await h.core.duet.chooseSecondInput('usb-b')).toBe('failed');
    expect(h.micB.close).toHaveBeenCalledTimes(2);
  });

  it('reopens B in A\'s new monitor mode, and closes it with a warning if that fails', async () => {
    const { h } = await ready();
    await h.core.duet.chooseSecondInput('usb-b');
    await h.core.input.setMonitor('speakers');
    await settle();
    expect(h.micB.open).toHaveBeenLastCalledWith('usb-b', 1, 'speakers');
    expect(h.store.state.singers[1].input).toMatchObject({ open: true, requestedAec: true });
    const said: Array<[string, string]> = [];
    h.store.subscribe((state) => said.push([state.status.kind, state.status.text]));
    h.micB.open.mockRejectedValueOnce(new Error('busy'));
    await h.core.input.setMonitor('headphones');
    await settle();
    expect(h.store.state.singers[1].input.open).toBe(false);
    expect(said.some(([kind, text]) => kind === 'warn' && text.includes('could not follow'))).toBe(true);
  });

  it('does not reopen B while recording, as A refuses the change too', async () => {
    const { h } = await ready();
    await h.core.duet.chooseSecondInput('usb-b');
    await h.core.takes.toggleRecord();
    const calls = h.micB.open.mock.calls.length;
    await h.core.input.setMonitor('speakers');
    await settle();
    expect(h.micB.open.mock.calls.length).toBe(calls);
    expect(h.store.state.input.monitor).toBe('headphones');
    await h.core.takes.toggleRecord();
  });

  it('refuses to turn singer B off while recording', async () => {
    const { h } = await ready({ duet: { secondSinger: true } });
    await h.core.takes.toggleRecord();
    h.core.duet.setSecondSinger(false);
    expect(h.core.current.duet.secondSinger).toBe(true);
    expect(h.store.state.status.text).toBe('Stop recording first.');
    await h.core.takes.toggleRecord();
    h.core.duet.setSecondSinger(false);
    expect(h.core.current.duet.secondSinger).toBe(false);
  });

  it('gates, in speaker mode, a B frame well under A on A\'s pitch as A leaking in', async () => {
    const { h } = await ready();
    await h.core.duet.chooseSecondInput('usb-b');
    await h.core.input.setMonitor('speakers');
    await settle();
    h.core.playback.play();
    const seen: SingerFrame[] = [];
    h.core.bus.subscribe((m) => seen.push(m));
    sing(h, 2, A4, 'a', 0.2);
    sing(h, 2, A4, 'b', 0.05);
    // B's own voice on another pitch at the same low level passes.
    sing(h, 2.01, A4, 'a', 0.2);
    sing(h, 2.01, E5, 'b', 0.05);
    const b = seen.filter((m) => m.singer === 1);
    expect(b[0]).toMatchObject({ gated: true, gateReason: 'quiet', frame: { f0: 0 }, rawF0: A4 });
    expect(b[1].gated).toBe(false);
    expect(b[1].frame.f0).toBe(E5);
  });

  it('uses B\'s own speaker mode, not A\'s, to drop a quiet B frame', async () => {
    const { h } = await ready();
    await h.core.duet.chooseSecondInput('usb-b');
    h.core.playback.play();
    const seen: SingerFrame[] = [];
    h.core.bus.subscribe((m) => seen.push(m));
    // Headphones for both: the leak rule is off and a passing frame stays.
    sing(h, 2, A4, 'a', 0.2);
    sing(h, 2, A4, 'b', 0.05);
    expect(seen.find((m) => m.singer === 1)).toMatchObject({ gated: false, frame: { f0: A4 } });
  });
});
