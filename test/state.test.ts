/**
 * Unit tests for the state store (patch and subscribe semantics, the nested
 * section helper, the status line), the selectors that turn state into text,
 * and the pure helpers exported by the session (frame-to-song-time mapping,
 * take replay indexing, loop button maths). Everything runs under node, so the
 * Session itself is only built where Web Audio is missing, to prove it
 * degrades; its audio paths need a browser and belong to the end-to-end run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOOP_S,
  FRAME_JITTER_S,
  firstFrameIndex,
  frameToSongTime,
  loopWithPoint,
  orderedFrameTime,
  Session,
} from '../src/app/session';
import { loadSettings } from '../src/app/settings';
import {
  describeHealth,
  describeLoadFailure,
  describeMonitor,
  describePitch,
  formatClock,
  formatLatency,
  initialState,
  meterFraction,
  StateStore,
} from '../src/app/state';
import type { AppState } from '../src/app/state';
import { memoryStore } from '../src/app/storage';
import { memoryTakeStore } from '../src/app/takes';
import { latencyKey } from '../src/audio/latency';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initialState', () => {
  it('has every field of the contract with nothing open or set', () => {
    expect(initialState()).toEqual({
      song: null,
      player: 'empty',
      clock: 'engine',
      embed: null,
      embedOffsetS: 0,
      prepare: { phase: 'none', steps: null, message: '' },
      positionS: 0,
      loop: null,
      durationS: 0,
      input: {
        deviceId: null,
        label: '',
        open: false,
        level: 0,
        processing: { aec: null, ns: null, agc: null },
        monitor: 'headphones',
        requestedAec: false,
      },
      singers: [
        {
          id: 0,
          input: {
            deviceId: null,
            label: '',
            open: false,
            level: 0,
            processing: { aec: null, ns: null, agc: null },
            monitor: 'headphones',
            requestedAec: false,
          },
        },
      ],
      output: { deviceId: null, label: '', selectable: false },
      latencyS: null,
      calibrating: false,
      tracker: 'idle',
      framesPerSecond: 0,
      lastFrame: null,
      recording: false,
      takes: [],
      playingTakeId: null,
      status: { text: '', kind: 'info' },
    });
  });

  it('returns independent objects each time', () => {
    const a = initialState();
    const b = initialState();
    a.input.processing.aec = true;
    a.takes.push({} as never);
    expect(b.input.processing.aec).toBeNull();
    expect(b.takes).toEqual([]);
  });
});

describe('StateStore.patch', () => {
  it('merges the values and reports exactly the keys that changed', () => {
    const store = new StateStore();
    const calls: Array<Set<keyof AppState>> = [];
    store.subscribe((_s, changed) => calls.push(new Set(changed)));
    store.patch({ positionS: 3.5, player: 'playing' });
    expect(store.state.positionS).toBe(3.5);
    expect(store.state.player).toBe('playing');
    expect(calls).toEqual([new Set(['positionS', 'player'])]);
  });

  it('leaves out keys whose value did not change', () => {
    const store = new StateStore();
    store.patch({ positionS: 1, durationS: 10 });
    const seen: Array<Set<keyof AppState>> = [];
    store.subscribe((_s, changed) => seen.push(new Set(changed)));
    store.patch({ positionS: 1, durationS: 11 });
    expect(seen).toEqual([new Set(['durationS'])]);
  });

  it('is a no-op, telling nobody, when nothing changed', () => {
    const store = new StateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.patch({});
    store.patch({ positionS: 0, recording: false, song: null });
    expect(listener).not.toHaveBeenCalled();
  });

  it('compares with Object.is, so NaN equals NaN and objects by identity', () => {
    const store = new StateStore();
    store.patch({ positionS: NaN });
    const listener = vi.fn();
    store.subscribe(listener);
    store.patch({ positionS: NaN });
    expect(listener).not.toHaveBeenCalled();
    store.patch({ loop: { startS: 1, endS: 2 } });
    store.patch({ loop: { startS: 1, endS: 2 } });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores unknown keys and undefined values', () => {
    const store = new StateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.patch({ bogus: 1, durationS: undefined } as unknown as Partial<AppState>);
    expect(listener).not.toHaveBeenCalled();
    expect('bogus' in store.state).toBe(false);
    expect(store.state.durationS).toBe(0);
  });

  it('shows listeners the state with every key already applied', () => {
    const store = new StateStore();
    let seen: [number, string] | null = null;
    store.subscribe((s) => {
      seen = [s.positionS, s.player];
    });
    store.patch({ positionS: 2, player: 'paused' });
    expect(seen).toEqual([2, 'paused']);
  });

  it('keeps the same state object for its whole life', () => {
    const store = new StateStore();
    const before = store.state;
    store.patch({ recording: true });
    expect(store.state).toBe(before);
  });

  it('accepts a state to start from', () => {
    const initial = initialState();
    initial.latencyS = 0.1;
    expect(new StateStore(initial).state.latencyS).toBe(0.1);
  });
});

describe('StateStore.subscribe', () => {
  it('stops calling a listener after it unsubscribes', () => {
    const store = new StateStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.patch({ durationS: 1 });
    off();
    store.patch({ durationS: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('lets a listener unsubscribe itself while being called', () => {
    const store = new StateStore();
    const second = vi.fn();
    const off = store.subscribe(() => off());
    store.subscribe(second);
    store.patch({ durationS: 1 });
    store.patch({ durationS: 2 });
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('keeps notifying the rest when one listener throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new StateStore();
    const after = vi.fn();
    store.subscribe(() => {
      throw new Error('broken view');
    });
    store.subscribe(after);
    store.patch({ durationS: 1 });
    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('allows a listener to patch again', () => {
    const store = new StateStore();
    store.subscribe((s, changed) => {
      if (changed.has('durationS') && s.durationS > 0) store.patch({ positionS: s.durationS });
    });
    store.patch({ durationS: 5 });
    expect(store.state.positionS).toBe(5);
  });
});

describe('StateStore.patchSection', () => {
  it('merges fields into input and keeps the rest', () => {
    const store = new StateStore();
    store.patchSection('input', { label: 'USB mic', open: true });
    expect(store.state.input).toEqual({
      deviceId: null,
      label: 'USB mic',
      open: true,
      level: 0,
      processing: { aec: null, ns: null, agc: null },
      monitor: 'headphones',
      requestedAec: false,
    });
  });

  it('notices a change of monitor mode or of the echo cancellation request', () => {
    const store = new StateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.patchSection('input', { monitor: 'speakers', requestedAec: true });
    store.patchSection('input', { monitor: 'speakers', requestedAec: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.state.input.monitor).toBe('speakers');
    expect(store.state.input.requestedAec).toBe(true);
  });

  it('notifies once with the section key', () => {
    const store = new StateStore();
    const calls: Array<Set<keyof AppState>> = [];
    store.subscribe((_s, changed) => calls.push(new Set(changed)));
    store.patchSection('output', { selectable: true });
    expect(calls).toEqual([new Set(['output'])]);
  });

  it('is a no-op when the content is the same, even in new objects', () => {
    const store = new StateStore();
    store.patchSection('input', { label: 'x', processing: { aec: false, ns: false, agc: false } });
    const listener = vi.fn();
    store.subscribe(listener);
    store.patchSection('input', { label: 'x', processing: { aec: false, ns: false, agc: false } });
    store.patchSection('input', {});
    expect(listener).not.toHaveBeenCalled();
  });

  it('notices a change inside the nested processing object', () => {
    const store = new StateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.patchSection('input', { processing: { aec: true, ns: null, agc: null } });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('StateStore.setStatus', () => {
  it('sets the text with info as the default kind', () => {
    const store = new StateStore();
    store.setStatus('Loaded');
    expect(store.state.status).toEqual({ text: 'Loaded', kind: 'info' });
  });

  it('sets the kind', () => {
    const store = new StateStore();
    store.setStatus('Blocked', 'error');
    expect(store.state.status).toEqual({ text: 'Blocked', kind: 'error' });
  });

  it('does not notify for the same text and kind', () => {
    const store = new StateStore();
    store.setStatus('Same', 'warn');
    const listener = vi.fn();
    store.subscribe(listener);
    store.setStatus('Same', 'warn');
    expect(listener).not.toHaveBeenCalled();
    store.setStatus('Same', 'info');
    expect(listener).toHaveBeenCalledTimes(1);
    expect([...listener.mock.calls[0][1]]).toEqual(['status']);
  });
});

describe('meterFraction', () => {
  it('maps -60 dB to empty and full scale to full', () => {
    expect(meterFraction(1)).toBe(1);
    expect(meterFraction(0.001)).toBeCloseTo(0, 9);
    expect(meterFraction(0.1)).toBeCloseTo(40 / 60, 9);
    expect(meterFraction(0.5)).toBeCloseTo((20 * Math.log10(0.5) + 60) / 60, 9);
  });

  it('clamps and tolerates nonsense', () => {
    expect(meterFraction(0)).toBe(0);
    expect(meterFraction(-1)).toBe(0);
    expect(meterFraction(NaN)).toBe(0);
    expect(meterFraction(0.00001)).toBe(0);
    expect(meterFraction(3)).toBe(1);
  });
});

describe('formatClock and formatLatency', () => {
  it('formats minutes and seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5.9)).toBe('0:05');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(599.99)).toBe('9:59');
  });

  it('adds hours from an hour up', () => {
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('reads negative and non-finite values as zero', () => {
    expect(formatClock(-4)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(Infinity)).toBe('0:00');
  });

  it('rounds latency to whole milliseconds or says it is unset', () => {
    expect(formatLatency(null)).toBe('not set');
    expect(formatLatency(0.1423)).toBe('142 ms');
    expect(formatLatency(0)).toBe('0 ms');
  });
});

describe('describeHealth', () => {
  it('reads out a fresh page', () => {
    expect(describeHealth(initialState())).toBe(
      'mic: off · out: default · latency: not set · tracker: idle',
    );
  });

  it('names the devices, latency and tracker rate once running', () => {
    const s = initialState();
    s.input = { ...s.input, open: true, label: 'Blue Yeti' };
    s.output = { ...s.output, label: 'Headphones' };
    s.latencyS = 0.0873;
    s.tracker = 'running';
    s.framesPerSecond = 99.6;
    expect(describeHealth(s)).toBe(
      'mic: Blue Yeti · out: Headphones · latency: 87 ms · tracker: 100 fps',
    );
  });

  it('falls back to "open" for an unnamed mic and flags a missing tracker', () => {
    const s = initialState();
    s.input = { ...s.input, open: true };
    s.tracker = 'unsupported';
    expect(describeHealth(s)).toContain('mic: open');
    expect(describeHealth(s)).toContain('tracker: unavailable');
  });
});

describe('describeMonitor', () => {
  /** The input section once a mic has opened and the browser has answered. */
  function opened(
    requestedAec: boolean,
    processing: AppState['input']['processing'],
  ): AppState['input'] {
    return { ...initialState().input, open: true, requestedAec, processing };
  }
  const off = { aec: false, ns: false, agc: false };

  it('says nothing while no mic is open', () => {
    expect(describeMonitor(initialState().input)).toBeNull();
    expect(describeMonitor({ ...opened(true, off), open: false })).toBeNull();
  });

  it('headphones: raw input when the browser left everything off', () => {
    expect(describeMonitor(opened(false, off))).toEqual({
      text: 'Raw input: processing off',
      kind: 'info',
    });
  });

  it('headphones: warns, naming what the browser kept on', () => {
    expect(describeMonitor(opened(false, { aec: true, ns: false, agc: true }))).toEqual({
      text: 'Browser processing on: echo cancel, auto gain',
      kind: 'warn',
    });
    expect(describeMonitor(opened(false, { aec: false, ns: true, agc: false }))?.kind).toBe('warn');
  });

  it('headphones: says nothing when the browser reports nothing', () => {
    expect(describeMonitor(opened(false, { aec: null, ns: null, agc: null }))).toBeNull();
  });

  it('speakers: confirms echo cancellation on with noise suppression and gain off', () => {
    expect(describeMonitor(opened(true, { aec: true, ns: false, agc: false }))).toEqual({
      text: 'Speaker mode: echo cancellation on, NS/AGC off',
      kind: 'info',
    });
  });

  it('speakers: warns that the song may bleed when the browser refused', () => {
    expect(describeMonitor(opened(true, off))).toEqual({
      text:
        'Speaker mode requested but this browser kept echo cancellation off: ' +
        'the song may bleed into your pitch',
      kind: 'warn',
    });
  });

  it('speakers: warns when noise suppression or gain came along with the cancelling', () => {
    const both = describeMonitor(opened(true, { aec: true, ns: true, agc: true }));
    expect(both?.kind).toBe('warn');
    expect(both?.text).toContain('noise suppression and auto gain');
    const one = describeMonitor(opened(true, { aec: true, ns: false, agc: true }));
    expect(one?.kind).toBe('warn');
    expect(one?.text).toContain('auto gain');
    expect(one?.text).not.toContain('noise suppression');
  });

  it('speakers: does not claim a result the browser did not report', () => {
    const report = describeMonitor(opened(true, { aec: null, ns: null, agc: null }));
    expect(report?.kind).toBe('info');
    expect(report?.text).toContain('does not say');
  });

  it('reads a raw calibration pass as raw even in speaker mode', () => {
    // Calibration reopens the mic without echo cancellation; the saved mode is
    // still speakers, but the open mic was not asked for cancelling.
    const input = { ...opened(false, off), monitor: 'speakers' as const };
    expect(describeMonitor(input)?.text).toBe('Raw input: processing off');
  });
});

describe('describePitch', () => {
  const frame = (f0: number) => ({ t: 0, f0, clarity: 0.95, rms: 0.1 });

  it('names the note and cents for exact pitches', () => {
    expect(describePitch(frame(440))).toEqual({ note: 'A4', cents: 0, hz: 440 });
    expect(describePitch(frame(261.6256))?.note).toBe('C4');
    expect(describePitch(frame(261.6256))?.cents).toBe(0);
  });

  it('gives signed cents from the nearest semitone', () => {
    const sharp = describePitch(frame(440 * 2 ** (30 / 1200)));
    expect(sharp).toMatchObject({ note: 'A4', cents: 30 });
    const flat = describePitch(frame(440 * 2 ** (-20 / 1200)));
    expect(flat).toMatchObject({ note: 'A4', cents: -20 });
    // 60 cents above A4 is closer to A#4, 40 cents flat of it.
    expect(describePitch(frame(440 * 2 ** (60 / 1200)))).toMatchObject({ note: 'A#4', cents: -40 });
  });

  it('never reports negative zero', () => {
    const r = describePitch(frame(440 * 2 ** (-0.2 / 1200)));
    expect(Object.is(r?.cents, 0)).toBe(true);
  });

  it('returns null for silence, unvoiced and missing frames', () => {
    expect(describePitch(null)).toBeNull();
    expect(describePitch(frame(0))).toBeNull();
    expect(describePitch(frame(-100))).toBeNull();
    expect(describePitch(frame(NaN))).toBeNull();
  });
});

describe('describeLoadFailure', () => {
  const unreachable = 'Could not reach YouTube. Check the connection.';
  const kept = 'The previous song is still loaded.';

  it('is the reason alone when there is no song to keep', () => {
    expect(describeLoadFailure(unreachable, false)).toBe(unreachable);
    // Untouched, whatever it ends with.
    expect(describeLoadFailure('Could not read "a.mp3"', false)).toBe('Could not read "a.mp3"');
  });

  it('says the previous song is still loaded when there is one', () => {
    expect(describeLoadFailure(unreachable, true)).toBe(`${unreachable} ${kept}`);
  });

  it('ends a reason that has no full stop before adding the sentence', () => {
    expect(describeLoadFailure('Could not read "a.mp3" as audio this browser can decode', true)).toBe(
      `Could not read "a.mp3" as audio this browser can decode. ${kept}`,
    );
  });

  it('keeps any other sentence ending, and drops trailing space', () => {
    expect(describeLoadFailure('Is that a video?', true)).toBe(`Is that a video? ${kept}`);
    expect(describeLoadFailure('No way!', true)).toBe(`No way! ${kept}`);
    expect(describeLoadFailure('Gave up…', true)).toBe(`Gave up… ${kept}`);
    expect(describeLoadFailure('Could not reach YouTube.  \n', true)).toBe(`Could not reach YouTube. ${kept}`);
  });
});

describe('frameToSongTime', () => {
  it('puts a frame at the song position when it is fresh and latency is zero', () => {
    expect(frameToSongTime(5, 5, 12, 0)).toBe(12);
  });

  it('moves back by how old the frame is', () => {
    expect(frameToSongTime(4.98, 5, 10, 0)).toBeCloseTo(9.98, 9);
  });

  it('moves back by the latency as well', () => {
    expect(frameToSongTime(4.98, 5, 10, 0.1)).toBeCloseTo(9.88, 9);
  });

  it('needs no loop to be exact on a linear run', () => {
    for (const latency of [0, 0.05, 0.3]) {
      expect(frameToSongTime(100, 100.5, 30, latency, null)).toBeCloseTo(30 - 0.5 - latency, 9);
    }
  });

  it('folds a frame from just before a loop wrap into the previous pass', () => {
    const loop = { startS: 10, endS: 20 };
    // The song wrapped 0.05 s ago; the frame is 0.05 s old and latency 0.15.
    expect(frameToSongTime(99.95, 100, 10.05, 0.15, loop)).toBeCloseTo(19.85, 9);
  });

  it('folds by whole loop lengths when the age spans several passes', () => {
    const loop = { startS: 10, endS: 20 };
    expect(frameToSongTime(75, 100, 10.5, 0, loop)).toBeCloseTo(15.5, 9);
  });

  it('leaves frames inside the loop alone', () => {
    const loop = { startS: 10, endS: 20 };
    expect(frameToSongTime(99.9, 100, 15, 0.1, loop)).toBeCloseTo(14.8, 9);
  });

  it('does not fold when the playhead is outside the loop', () => {
    const loop = { startS: 10, endS: 20 };
    expect(frameToSongTime(99.9, 100, 4, 0.1, loop)).toBeCloseTo(3.8, 9);
    expect(frameToSongTime(99.9, 100, 25, 0.1, loop)).toBeCloseTo(24.8, 9);
  });

  it('ignores a loop with no length', () => {
    expect(frameToSongTime(99.9, 100, 10, 0.1, { startS: 10, endS: 10 })).toBeCloseTo(9.8, 9);
  });

  it('moves back by the embed offset on top of the latency', () => {
    expect(frameToSongTime(4.98, 5, 10, 0.1, null, 0.06)).toBeCloseTo(9.82, 9);
    // A negative offset moves the frame later: the sound beats the clock.
    expect(frameToSongTime(4.98, 5, 10, 0.1, null, -0.04)).toBeCloseTo(9.92, 9);
  });

  it('is unchanged by an embed offset of zero, which is what a file always gets', () => {
    expect(frameToSongTime(4.98, 5, 10, 0.1, null, 0)).toBe(frameToSongTime(4.98, 5, 10, 0.1));
  });

  it('folds an offset frame across a loop wrap the same way', () => {
    const loop = { startS: 10, endS: 20 };
    // Wrapped 0.05 s ago; frame 0.05 s old; latency 0.1 plus offset 0.05.
    expect(frameToSongTime(99.95, 100, 10.05, 0.1, loop, 0.05)).toBeCloseTo(19.85, 9);
  });
});

describe('orderedFrameTime', () => {
  it('leaves frames that are already in order alone', () => {
    expect(orderedFrameTime(10.01, 10)).toBe(10.01);
    expect(orderedFrameTime(10, Number.NEGATIVE_INFINITY)).toBe(10);
  });

  it('puts a frame that came out level or a little behind just after the one before', () => {
    const level = orderedFrameTime(10, 10);
    expect(level).toBeGreaterThan(10);
    expect(level).toBeLessThan(10.00001);
    const behind = orderedFrameTime(9.9987, 10);
    expect(behind).toBeGreaterThan(10);
    expect(behind - 10).toBeLessThan(0.00001);
  });

  it('leaves a step back of FRAME_JITTER_S or more alone: that is a seek or a loop wrap', () => {
    expect(FRAME_JITTER_S).toBe(0.05);
    expect(orderedFrameTime(9.95, 10)).toBe(9.95);
    expect(orderedFrameTime(9.5, 10)).toBe(9.5);
    // Just inside and just outside the limit.
    expect(orderedFrameTime(9.9499, 10)).toBe(9.9499);
    expect(orderedFrameTime(9.9501, 10)).toBeGreaterThan(10);
  });

  it('keeps a jittery run strictly increasing and within the jitter of where it was', () => {
    // 10 ms hops with the stamp wobbling by up to 8 ms: neighbours swap.
    const stamped = Array.from({ length: 500 }, (_, i) => 30 + i * 0.01 + 0.008 * Math.sin(i * 2.3));
    expect(stamped.some((v, i) => i > 0 && v <= stamped[i - 1])).toBe(true);
    const fixed: number[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    for (const v of stamped) {
      previous = orderedFrameTime(v, previous);
      fixed.push(previous);
    }
    for (let i = 1; i < fixed.length; i++) expect(fixed[i]).toBeGreaterThan(fixed[i - 1]);
    for (let i = 0; i < fixed.length; i++) expect(Math.abs(fixed[i] - stamped[i])).toBeLessThan(0.02);
  });
});

describe('firstFrameIndex', () => {
  const frames = [0, 0.01, 0.02, 0.05, 0.06].map((t) => ({ t }));

  it('finds the first frame at or after the time', () => {
    expect(firstFrameIndex(frames, 0.02)).toBe(2);
    expect(firstFrameIndex(frames, 0.021)).toBe(3);
    expect(firstFrameIndex(frames, 0)).toBe(0);
  });

  it('handles times before, after and an empty list', () => {
    expect(firstFrameIndex(frames, -5)).toBe(0);
    expect(firstFrameIndex(frames, 9)).toBe(5);
    expect(firstFrameIndex([], 1)).toBe(0);
  });
});

describe('loopWithPoint', () => {
  const duration = 100;

  it('makes a default-length loop from A when there is none', () => {
    expect(loopWithPoint('a', 30, null, duration)).toEqual({ startS: 30, endS: 30 + DEFAULT_LOOP_S });
  });

  it('keeps the end when A moves and the end is still ahead', () => {
    expect(loopWithPoint('a', 12, { startS: 10, endS: 20 }, duration)).toEqual({ startS: 12, endS: 20 });
  });

  it('starts a fresh default loop when A passes the old end', () => {
    expect(loopWithPoint('a', 40, { startS: 10, endS: 20 }, duration)).toEqual({
      startS: 40,
      endS: 40 + DEFAULT_LOOP_S,
    });
  });

  it('makes a default-length loop ending at B when there is none', () => {
    expect(loopWithPoint('b', 30, null, duration)).toEqual({ startS: 30 - DEFAULT_LOOP_S, endS: 30 });
  });

  it('keeps the start when B moves and the start is still behind', () => {
    expect(loopWithPoint('b', 25, { startS: 10, endS: 20 }, duration)).toEqual({ startS: 10, endS: 25 });
  });

  it('starts a fresh default loop when B comes before the old start', () => {
    expect(loopWithPoint('b', 5, { startS: 10, endS: 20 }, duration)).toEqual({ startS: 0, endS: 5 });
  });

  it('clamps into the song', () => {
    expect(loopWithPoint('a', 96, null, duration)).toEqual({ startS: 96, endS: 100 });
    expect(loopWithPoint('b', 3, null, duration)).toEqual({ startS: 0, endS: 3 });
  });

  it('gives null when the loop would be shorter than the player allows', () => {
    expect(loopWithPoint('a', 99.95, null, duration)).toBeNull();
    expect(loopWithPoint('b', 0.05, null, duration)).toBeNull();
    expect(loopWithPoint('a', NaN, null, duration)).toBeNull();
  });
});

describe('Session without Web Audio', () => {
  // Node has no AudioContext, which is exactly a browser that lacks one.
  function bare() {
    const settings = memoryStore();
    const session = new Session({ settings, takes: memoryTakeStore() });
    return { session, settings };
  }

  it('constructs without throwing and says what is missing', () => {
    const { session } = bare();
    expect(session.parts).toBeNull();
    expect(session.store.state.tracker).toBe('unsupported');
    expect(session.store.state.status.kind).toBe('error');
    expect(session.store.state.status.text).toContain('Web Audio');
  });

  it('ignores every intent that needs audio', async () => {
    const { session } = bare();
    const before = JSON.stringify(session.store.state);
    session.play();
    session.pause();
    session.stop();
    session.seek(5);
    session.nudge(5);
    session.toggleLoop();
    session.setLoopPoint('a');
    await session.chooseInput('mic');
    await session.setMonitor('speakers');
    await session.chooseOutput('out');
    await session.calibrate();
    await session.toggleRecord();
    await session.playTake('nope');
    session.stopTake();
    await session.loadSong(new File(['x'], 'a.mp3'));
    await session.loadLink('https://youtu.be/dQw4w9WgXcQ');
    expect(JSON.stringify(session.store.state)).toBe(before);
  });

  it('has no transport and reads the lane position as zero', () => {
    const { session } = bare();
    expect(session.transport).toBeNull();
    const lane = { setTime: vi.fn(), pushFrame: vi.fn(), clearFrames: vi.fn(), setNotice: vi.fn() };
    session.attachLane(lane);
    expect(lane.setTime).toHaveBeenCalledWith(0);
  });

  it('starts and disposes its loop cleanly', async () => {
    const { session } = bare();
    session.start();
    session.start();
    await session.refreshDevices();
    expect(session.deviceLists).toEqual({ inputs: [], outputs: [] });
    session.dispose();
  });

  it('stores latency per device pair and loads it back next time', () => {
    const { session, settings } = bare();
    session.setLatency(0.123);
    expect(session.store.state.latencyS).toBe(0.123);
    expect(loadSettings(settings).latencyByDevicePair).toEqual({
      [latencyKey(null, null)]: 0.123,
    });
    expect(new Session({ settings, takes: memoryTakeStore() }).store.state.latencyS).toBe(0.123);
    session.setLatency(null);
    expect(session.store.state.latencyS).toBeNull();
    expect(loadSettings(settings).latencyByDevicePair).toEqual({});
  });

  it('refuses a latency outside 0..2000 ms and keeps the old one', () => {
    const { session } = bare();
    session.setLatency(0.1);
    for (const bad of [-0.01, 2.5, NaN, Infinity]) {
      session.setLatency(bad);
      expect(session.store.state.latencyS).toBe(0.1);
      expect(session.store.state.status.kind).toBe('warn');
    }
  });

  it('saves the embed offset, limited to plus or minus half a second', () => {
    const { session, settings } = bare();
    expect(session.store.state.embedOffsetS).toBe(0);
    session.setEmbedOffset(0.12);
    expect(session.store.state.embedOffsetS).toBe(0.12);
    expect(loadSettings(settings).embedOffsetS).toBe(0.12);
    expect(session.settings.embedOffsetS).toBe(0.12);
    session.setEmbedOffset(-0.3);
    expect(loadSettings(settings).embedOffsetS).toBe(-0.3);

    // Out of range: kept at the limit, and the singer is told.
    session.setEmbedOffset(0.9);
    expect(session.store.state.embedOffsetS).toBe(0.5);
    expect(loadSettings(settings).embedOffsetS).toBe(0.5);
    expect(session.store.state.status.kind).toBe('warn');
    expect(session.store.state.status.text).toContain('500 ms');
  });

  it('refuses an embed offset that is not a number and keeps the old one', () => {
    const { session, settings } = bare();
    session.setEmbedOffset(0.08);
    for (const bad of [NaN, Infinity, -Infinity]) {
      session.setEmbedOffset(bad);
      expect(session.store.state.embedOffsetS).toBe(0.08);
      expect(loadSettings(settings).embedOffsetS).toBe(0.08);
      expect(session.store.state.status.kind).toBe('warn');
    }
  });

  it('starts from the saved embed offset', () => {
    const settings = memoryStore();
    settings.set('settings', JSON.stringify({ embedOffsetS: -0.07 }));
    const session = new Session({ settings, takes: memoryTakeStore() });
    expect(session.store.state.embedOffsetS).toBe(-0.07);
  });

  it('saves the voicing threshold, clamped, and ignores nonsense', () => {
    const { session, settings } = bare();
    session.setClarity(0.8);
    expect(loadSettings(settings).clarityThreshold).toBe(0.8);
    session.setClarity(7);
    expect(loadSettings(settings).clarityThreshold).toBe(1);
    session.setClarity(NaN);
    expect(loadSettings(settings).clarityThreshold).toBe(1);
    expect(session.settings.clarityThreshold).toBe(1);
  });

  it('starts from the saved input device', () => {
    const settings = memoryStore();
    settings.set('settings', JSON.stringify({ inputDeviceId: 'usb-mic' }));
    const session = new Session({ settings, takes: memoryTakeStore() });
    expect(session.store.state.input.deviceId).toBe('usb-mic');
    expect(session.store.state.input.open).toBe(false);
  });
});

describe('singers', () => {
  it('starts with one singer whose input is the state input', () => {
    const state = initialState();
    expect(state.singers).toHaveLength(1);
    expect(state.singers[0].id).toBe(0);
    expect(state.singers[0].input).toEqual(state.input);
  });

  it('keeps the first singer in step with patchSection on the input', () => {
    const store = new StateStore();
    const calls: Array<Set<keyof AppState>> = [];
    store.subscribe((_s, changed) => calls.push(new Set(changed)));
    store.patchSection('input', { label: 'USB mic', open: true });
    expect(store.state.singers[0].input).toEqual(store.state.input);
    expect(store.state.singers[0].input.label).toBe('USB mic');
    expect(calls).toEqual([new Set(['input', 'singers'])]);
  });

  it('leaves the singers alone for the output section and for no-op patches', () => {
    const store = new StateStore();
    const before = store.state.singers;
    const listener = vi.fn();
    store.subscribe(listener);
    store.patchSection('output', { selectable: true });
    store.patchSection('input', {});
    expect(store.state.singers).toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
