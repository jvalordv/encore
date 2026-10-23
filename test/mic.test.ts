/**
 * Unit tests for mic.ts: error classification, the peak and level-window
 * maths, the constraint values, device listing against a stubbed
 * navigator.mediaDevices, and the open/close/level lifecycle of MicCapture
 * against fake Web Audio nodes. Real capture needs a browser and a mic and is
 * covered by the Playwright smoke test in a later phase.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../src/audio/engine';
import {
  MIC_CONSTRAINTS,
  MicCapture,
  MicError,
  buildMicConstraints,
  classifyMicError,
  levelWindowSamples,
  listInputDevices,
  onDeviceChange,
  peak,
} from '../src/audio/mic';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MIC_CONSTRAINTS', () => {
  it('turns every browser voice filter off and asks for mono 48 kHz', () => {
    expect(MIC_CONSTRAINTS.echoCancellation).toBe(false);
    expect(MIC_CONSTRAINTS.noiseSuppression).toBe(false);
    expect(MIC_CONSTRAINTS.autoGainControl).toBe(false);
    expect(MIC_CONSTRAINTS.channelCount).toEqual({ ideal: 1 });
    expect(MIC_CONSTRAINTS.sampleRate).toEqual({ ideal: 48000 });
  });
});

describe('buildMicConstraints', () => {
  it('pins the device with exact and the channel count with ideal', () => {
    const c = buildMicConstraints('abc', 2);
    expect(c.deviceId).toEqual({ exact: 'abc' });
    expect(c.channelCount).toEqual({ ideal: 2 });
    expect(c.echoCancellation).toBe(false);
  });

  it('leaves the device unconstrained for the default mic', () => {
    expect(buildMicConstraints(null).deviceId).toBeUndefined();
    expect(buildMicConstraints('').deviceId).toBeUndefined();
    expect(buildMicConstraints(null).channelCount).toEqual({ ideal: 1 });
  });

  it('never alters the shared constants', () => {
    buildMicConstraints('abc', 2);
    expect(MIC_CONSTRAINTS.channelCount).toEqual({ ideal: 1 });
    expect(MIC_CONSTRAINTS.deviceId).toBeUndefined();
  });
});

describe('classifyMicError', () => {
  const named = (name: string): Error => {
    const e = new Error(`${name} happened`);
    e.name = name;
    return e;
  };

  it.each([
    ['NotAllowedError', 'denied'],
    ['PermissionDeniedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'not-found'],
    ['DevicesNotFoundError', 'not-found'],
    ['OverconstrainedError', 'not-found'],
    ['NotReadableError', 'in-use'],
    ['TrackStartError', 'in-use'],
    ['NotSupportedError', 'unsupported'],
    ['AbortError', 'unknown'],
    ['TypeError', 'unknown'],
  ])('maps %s to %s', (name, code) => {
    const error = classifyMicError(named(name));
    expect(error).toBeInstanceOf(MicError);
    expect(error.code).toBe(code);
  });

  it('understands real DOMExceptions', () => {
    expect(classifyMicError(new DOMException('no', 'NotAllowedError')).code).toBe('denied');
  });

  it('keeps the original error as the cause', () => {
    const original = named('NotFoundError');
    expect(classifyMicError(original).cause).toBe(original);
  });

  it('gives known codes a fixed user message and unknown ones the detail', () => {
    expect(classifyMicError(named('NotAllowedError')).message).toMatch(/blocked/i);
    expect(classifyMicError(named('NotFoundError')).message).toMatch(/not found/i);
    expect(classifyMicError(new Error('boom')).message).toContain('boom');
  });

  it('copes with values that are not errors', () => {
    expect(classifyMicError('weird').code).toBe('unknown');
    expect(classifyMicError(null).code).toBe('unknown');
    expect(classifyMicError({ name: 42 }).code).toBe('unknown');
    // Names that exist on Object.prototype must not read as codes.
    expect(classifyMicError({ name: 'constructor' }).code).toBe('unknown');
  });

  it('returns a MicError untouched', () => {
    const own = new MicError('in-use', 'busy');
    expect(classifyMicError(own)).toBe(own);
  });
});

describe('peak', () => {
  it('is the largest magnitude, whatever its sign', () => {
    expect(peak(Float32Array.of(0.1, -0.7, 0.3))).toBeCloseTo(0.7, 6);
    expect(peak(Float32Array.of(-1, 0.5))).toBe(1);
  });

  it('is 0 for silence and for an empty frame', () => {
    expect(peak(new Float32Array(64))).toBe(0);
    expect(peak(new Float32Array(0))).toBe(0);
  });

  it('measures a full-scale sine as 1', () => {
    const sine = new Float32Array(480);
    for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 100 * i) / 48000);
    expect(peak(sine)).toBeCloseTo(1, 3);
  });
});

describe('levelWindowSamples', () => {
  it('converts elapsed seconds to samples', () => {
    expect(levelWindowSamples(0.1, 48000, 32768)).toBe(4800);
  });

  it('never goes below one render quantum', () => {
    expect(levelWindowSamples(0, 48000, 32768)).toBe(128);
    expect(levelWindowSamples(-1, 48000, 32768)).toBe(128);
    expect(levelWindowSamples(NaN, 48000, 32768)).toBe(128);
  });

  it('never exceeds the analyser buffer', () => {
    expect(levelWindowSamples(10, 48000, 32768)).toBe(32768);
  });
});

/** Replaces navigator with a stub whose mediaDevices is `mediaDevices`. */
function stubNavigator(mediaDevices: unknown): void {
  vi.stubGlobal('navigator', { mediaDevices });
}

describe('listInputDevices', () => {
  it('returns only audio inputs, keeping empty labels', async () => {
    stubNavigator({
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'a', label: 'USB Mic' },
        { kind: 'audiooutput', deviceId: 'b', label: 'Speakers' },
        { kind: 'videoinput', deviceId: 'c', label: 'Cam' },
        { kind: 'audioinput', deviceId: 'd', label: '' },
      ],
    });
    expect(await listInputDevices()).toEqual([
      { deviceId: 'a', label: 'USB Mic' },
      { deviceId: 'd', label: '' },
    ]);
  });

  it('is empty when mediaDevices is missing or enumeration fails', async () => {
    stubNavigator(undefined);
    expect(await listInputDevices()).toEqual([]);
    stubNavigator({
      enumerateDevices: async () => {
        throw new Error('nope');
      },
    });
    expect(await listInputDevices()).toEqual([]);
  });

  it('is empty when there is no navigator at all', async () => {
    vi.stubGlobal('navigator', undefined);
    expect(await listInputDevices()).toEqual([]);
  });
});

describe('onDeviceChange', () => {
  it('subscribes to devicechange and unsubscribes cleanly', () => {
    const target = new EventTarget();
    stubNavigator(target);
    const cb = vi.fn();
    const off = onDeviceChange(cb);
    target.dispatchEvent(new Event('devicechange'));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    target.dispatchEvent(new Event('devicechange'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('hands back a harmless unsubscribe when unsupported', () => {
    stubNavigator(undefined);
    expect(() => onDeviceChange(() => {})()).not.toThrow();
  });
});

/** A minimal MediaStreamTrack that records stop() and ended listeners. */
function fakeTrack(label: string, settings: MediaTrackSettings) {
  const ended = new Set<() => void>();
  return {
    label,
    stopped: false,
    stop() {
      this.stopped = true;
    },
    getSettings: () => settings,
    addEventListener: (_type: string, cb: () => void) => void ended.add(cb),
    removeEventListener: (_type: string, cb: () => void) => void ended.delete(cb),
    fireEnded: () => ended.forEach((cb) => cb()),
    listenerCount: () => ended.size,
  };
}

type FakeTrack = ReturnType<typeof fakeTrack>;

function fakeStream(track: FakeTrack) {
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

/** Fake engine whose analyser replays `window` as its newest samples. */
function fakeEngine() {
  const state = { nowS: 0, window: new Float32Array(0), resumed: 0 };
  const analyser = {
    fftSize: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData(buf: Float32Array) {
      buf.fill(0);
      buf.set(state.window, buf.length - state.window.length);
    },
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: 48000,
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
  };
  const engine = {
    context,
    now: () => state.nowS,
    resume: async () => {
      state.resumed++;
    },
  } as unknown as AudioEngine;
  return { engine, state, analyser, source, context };
}

function stubGetUserMedia(impl: (c: MediaStreamConstraints) => Promise<unknown>) {
  const getUserMedia = vi.fn(impl);
  stubNavigator({ getUserMedia, enumerateDevices: async () => [] });
  vi.stubGlobal('AudioContext', class {});
  return getUserMedia;
}

describe('MicCapture', () => {
  it('reports unsupported where getUserMedia is missing', async () => {
    stubNavigator(undefined);
    expect(MicCapture.isSupported()).toBe(false);
    const { engine } = fakeEngine();
    await expect(new MicCapture(engine).open(null)).rejects.toMatchObject({
      name: 'MicError',
      code: 'unsupported',
    });
  });

  it('opens with the raw-mic constraints and exposes the stream details', async () => {
    const track = fakeTrack('Studio Mic', { deviceId: 'real-id', echoCancellation: false });
    const getUserMedia = stubGetUserMedia(async () => fakeStream(track));
    const { engine, source, analyser, state } = fakeEngine();
    const mic = new MicCapture(engine);
    expect(MicCapture.isSupported()).toBe(true);

    await mic.open('wanted-id', 2);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: 'wanted-id' },
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    });
    expect(mic.label).toBe('Studio Mic');
    expect(mic.deviceId).toBe('real-id');
    expect(mic.settings).toEqual({ deviceId: 'real-id', echoCancellation: false });
    expect(mic.source).toBe(source);
    expect(mic.stream).not.toBeNull();
    expect(state.resumed).toBe(1);
    // The mic feeds the analyser and nothing else.
    expect(source.connect).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(analyser);
  });

  it('closes the previous stream when a new one is opened', async () => {
    const first = fakeTrack('One', { deviceId: '1' });
    const second = fakeTrack('Two', { deviceId: '2' });
    const queue = [first, second];
    stubGetUserMedia(async () => fakeStream(queue.shift()!));
    const mic = new MicCapture(fakeEngine().engine);

    await mic.open('1');
    await mic.open('2');

    expect(first.stopped).toBe(true);
    expect(first.listenerCount()).toBe(0);
    expect(second.stopped).toBe(false);
    expect(mic.label).toBe('Two');
  });

  it('stops everything on close and is safe to close twice', async () => {
    const track = fakeTrack('Mic', { deviceId: 'x' });
    stubGetUserMedia(async () => fakeStream(track));
    const { engine, source } = fakeEngine();
    const mic = new MicCapture(engine);
    await mic.open(null);

    mic.close();
    mic.close();

    expect(track.stopped).toBe(true);
    expect(source.disconnect).toHaveBeenCalled();
    expect(mic.stream).toBeNull();
    expect(mic.source).toBeNull();
    expect(mic.deviceId).toBeNull();
    expect(mic.label).toBe('');
    expect(mic.settings).toBeNull();
    expect(mic.level()).toBe(0);
  });

  it('throws a classified MicError when the browser refuses', async () => {
    stubGetUserMedia(async () => {
      throw new DOMException('blocked', 'NotAllowedError');
    });
    const mic = new MicCapture(fakeEngine().engine);
    const failure = await mic.open(null).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MicError);
    expect((failure as MicError).code).toBe('denied');
    expect(mic.stream).toBeNull();
  });

  it('stops the stream and reports unsupported if the context rejects it', async () => {
    const track = fakeTrack('Mic', { deviceId: 'x' });
    stubGetUserMedia(async () => fakeStream(track));
    const { engine, context } = fakeEngine();
    context.createMediaStreamSource.mockImplementation(() => {
      throw new DOMException('rate mismatch', 'NotSupportedError');
    });
    const mic = new MicCapture(engine);
    await expect(mic.open(null)).rejects.toMatchObject({ code: 'unsupported' });
    expect(track.stopped).toBe(true);
    expect(mic.stream).toBeNull();
  });

  it('drops a stream that arrives after close() overtook the open', async () => {
    const track = fakeTrack('Late', { deviceId: 'x' });
    let release: (stream: unknown) => void = () => {};
    stubGetUserMedia(() => new Promise((resolve) => (release = resolve)));
    const mic = new MicCapture(fakeEngine().engine);

    const opening = mic.open(null);
    mic.close();
    release(fakeStream(track));
    await opening;

    expect(track.stopped).toBe(true);
    expect(mic.stream).toBeNull();
  });

  it('tells subscribers when the browser ends the track', async () => {
    const track = fakeTrack('Mic', { deviceId: 'x' });
    stubGetUserMedia(async () => fakeStream(track));
    const mic = new MicCapture(fakeEngine().engine);
    await mic.open(null);
    const cb = vi.fn();
    const off = mic.onEnded(cb);
    track.fireEnded();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    track.fireEnded();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  describe('level', () => {
    async function openMic() {
      const track = fakeTrack('Mic', { deviceId: 'x' });
      stubGetUserMedia(async () => fakeStream(track));
      const fake = fakeEngine();
      const mic = new MicCapture(fake.engine);
      await mic.open(null);
      return { mic, ...fake };
    }

    it('reads the peak of what arrived since the previous call', async () => {
      const { mic, state } = await openMic();
      // 0.1 s later: a 4800-sample window, with a 0.5 spike inside it.
      state.nowS = 0.1;
      state.window = new Float32Array(4800);
      state.window[100] = -0.5;
      expect(mic.level()).toBeCloseTo(0.5, 6);

      // 1 ms later: only the newest 128 samples count, so the spike is gone.
      state.nowS = 0.101;
      state.window = new Float32Array(4800);
      state.window[100] = -0.5;
      state.window[4799] = 0.25;
      expect(mic.level()).toBeCloseTo(0.25, 6);
    });

    it('is 0 for silence and never above 1', async () => {
      const { mic, state } = await openMic();
      state.nowS = 0.05;
      expect(mic.level()).toBe(0);
      state.nowS = 0.1;
      state.window = Float32Array.of(0, 1.7);
      expect(mic.level()).toBe(1);
    });
  });
});
