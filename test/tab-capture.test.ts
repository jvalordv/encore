/**
 * Tests for the tab recorder (src/audio/tab-capture.ts) and the session's
 * capture controller (src/app/session/capture.ts), over a fake embed, engine,
 * stream and PCM worklet: how a block is timed and when it is dropped, what is
 * released on each way out, the refusal of a silent result, a share that
 * ends, and the controller leaving no run behind when the song changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureController } from '../src/app/session/capture';
import { SHARE_ENDED_MESSAGE, SILENT_MESSAGE, TabCapture } from '../src/audio/tab-capture';
import type { CaptureEmbed, TabCaptureHooks } from '../src/audio/tab-capture';
import type { TransportState } from '../src/audio/transport';

type ChunkListener = (t: number, samples: Float32Array) => void;

const mocks = vi.hoisted(() => {
  const pcms: Array<{
    listener: ((t: number, samples: Float32Array) => void) | null;
    stopped: boolean;
  }> = [];
  class FakePcm {
    static isSupported = () => true;
    listener: ((t: number, samples: Float32Array) => void) | null = null;
    stopped = false;
    constructor() {
      pcms.push(this);
    }
    async load(): Promise<void> {}
    start(): void {}
    async stop(): Promise<void> {
      this.stopped = true;
    }
    onChunk(cb: (t: number, samples: Float32Array) => void): () => void {
      this.listener = cb;
      return () => {
        this.listener = null;
      };
    }
  }
  return { pcms, FakePcm, upload: vi.fn() };
});
const { pcms, upload } = mocks;

vi.mock('../src/audio/capture', () => ({ PcmCapture: mocks.FakePcm }));
vi.mock('../src/service/client', () => ({
  isAbortError: (e: unknown) => e instanceof DOMException && e.name === 'AbortError',
  ServiceClient: class {
    uploadCapture = mocks.upload;
  },
}));
vi.mock('../src/app/session/capture-seam', () => ({ fakeCaptureSource: () => null }));

class FakeTrack {
  stopped = false;
  private ended: Array<() => void> = [];
  addEventListener(_type: string, cb: () => void): void {
    this.ended.push(cb);
  }
  stop(): void {
    this.stopped = true;
  }
  end(): void {
    for (const cb of this.ended) cb();
  }
}

function fakeStream(track = new FakeTrack()) {
  return {
    track,
    stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream,
  };
}

class FakeEmbed {
  state: TransportState = 'playing';
  positionS = 0;
  durationS = 10;
  videoId = 'dQw4w9WgXcQ';
  info = { name: 'x' };
  paused = false;
  private listeners = new Map<string, Array<() => void>>();
  seek(s: number): void {
    this.positionS = s;
  }
  play(): void {}
  pause(): void {
    this.paused = true;
  }
  on(event: string, cb: () => void): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return () => undefined;
  }
  emit(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }
}

function makeEngine() {
  const source = { disconnect: vi.fn() };
  const engine = {
    nowS: 5,
    now(): number {
      return this.nowS;
    },
    context: { sampleRate: 1000, createMediaStreamSource: () => source },
    ensureRunning: async () => undefined,
  };
  return { engine, source };
}

function hooks() {
  const h = {
    failed: [] as string[],
    onProgress: vi.fn(),
    onEnded: vi.fn(),
    onFailed: (m: string) => {
      h.failed.push(m);
    },
  };
  return h satisfies TabCaptureHooks;
}

const loud = (n: number) => new Float32Array(n).fill(0.5);
const asEmbed = (e: FakeEmbed) => e as unknown as CaptureEmbed;

async function started() {
  const embed = new FakeEmbed();
  const { engine, source } = makeEngine();
  const { stream, track } = fakeStream();
  const capture = new TabCapture(engine as never, asEmbed(embed), async () => stream);
  expect(await capture.request()).toBe(true);
  const h = hooks();
  await capture.start(h);
  return { capture, embed, engine, source, track, h, pcm: pcms[pcms.length - 1] };
}

beforeEach(() => {
  pcms.length = 0;
  upload.mockReset();
  // Progress is throttled by the wall clock; each read here is 300 ms later.
  let clockMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clockMs += 300));
});

describe('TabCapture.place', () => {
  it('drops the first playing block, then places by the embed clock', async () => {
    const { capture, embed, engine, h } = await started();
    embed.positionS = 3;
    engine.nowS = 5;
    // The first playing block follows one that was not playing: dropped.
    capture.place(4.5, loud(500), h);
    // This one began 0.5 s ago, so its first sample is at 3 - 0.5 = 2.5 s.
    capture.place(4.5, loud(500), h);
    const { wav, coverage } = await capture.finish();
    expect(coverage).toBeCloseTo(0.05, 3);
    const view = new Int16Array(await wav.arrayBuffer(), 44);
    expect(view[2400]).toBe(0);
    expect(view[2600]).not.toBe(0);
    expect(view[3100]).toBe(0);
  });

  it('drops a block that straddles a pause', async () => {
    const { capture, embed, h } = await started();
    embed.positionS = 5;
    capture.place(5, loud(100), h);
    embed.state = 'paused';
    capture.place(5, loud(100), h);
    embed.state = 'playing';
    capture.place(5, loud(100), h);
    capture.place(5, loud(100), h);
    expect((await capture.finish()).coverage).toBeCloseTo(0.01, 3);
  });
});

describe('TabCapture release and refusals', () => {
  it('releases on done', async () => {
    const { capture, embed, source, track, pcm, h } = await started();
    embed.positionS = 5;
    capture.place(5, loud(500), h);
    capture.place(5, loud(500), h);
    await capture.finish();
    expect(track.stopped).toBe(true);
    expect(source.disconnect).toHaveBeenCalled();
    expect(pcm.stopped).toBe(true);
    expect(pcm.listener).toBeNull();
    expect(embed.paused).toBe(true);
  });

  it('releases on cancel, which can be repeated', async () => {
    const { capture, source, track, pcm } = await started();
    await capture.cancel();
    await capture.cancel();
    expect(track.stopped).toBe(true);
    expect(source.disconnect).toHaveBeenCalled();
    expect(pcm.stopped).toBe(true);
  });

  it('reports an ended share and releases on cancel after it', async () => {
    const { capture, track, h } = await started();
    track.end();
    expect(h.failed).toEqual([SHARE_ENDED_MESSAGE]);
    await capture.cancel();
    expect(track.stopped).toBe(true);
  });

  it('fails a start() whose share ended before it', async () => {
    const embed = new FakeEmbed();
    const { engine } = makeEngine();
    const { stream, track } = fakeStream();
    const capture = new TabCapture(engine as never, asEmbed(embed), async () => stream);
    await capture.request();
    track.end();
    const h = hooks();
    await capture.start(h);
    expect(h.failed).toEqual([SHARE_ENDED_MESSAGE]);
  });

  it('refuses a silent result and still releases', async () => {
    const { capture, embed, track, h } = await started();
    embed.positionS = 5;
    capture.place(5, new Float32Array(500), h);
    capture.place(5, new Float32Array(500), h);
    await expect(capture.finish()).rejects.toThrow(SILENT_MESSAGE);
    expect(track.stopped).toBe(true);
  });

  it('releases and returns false for a share with no audio', async () => {
    const embed = new FakeEmbed();
    const { engine } = makeEngine();
    const track = new FakeTrack();
    const stream = { getAudioTracks: () => [], getTracks: () => [track] } as unknown as MediaStream;
    const capture = new TabCapture(engine as never, asEmbed(embed), async () => stream);
    expect(await capture.request()).toBe(false);
    expect(track.stopped).toBe(true);
  });
});

function makeController() {
  const embed = new FakeEmbed();
  const { engine } = makeEngine();
  const { stream, track } = fakeStream();
  const state = {
    capture: { phase: 'idle', coverage: 0, largestGapS: 0, uploadFraction: 0, message: '' } as {
      phase: string;
      message: string;
    },
    prepare: { phase: 'ready', message: '' },
    recording: false,
  };
  const core = {
    store: {
      state,
      patch: (p: Record<string, unknown>) => Object.assign(state, p),
      setStatus: vi.fn(),
    },
    songs: { embed, loadToken: 1 },
    parts: { engine },
    current: { serviceUrl: 'http://x' },
    prepare: { prepare: vi.fn(async () => undefined) },
  };
  const controller = new CaptureController(core as never);
  // The seam is mocked away, so hand the controller the fake share directly.
  (controller as unknown as { sourceOf: () => unknown }).sourceOf = () => async () => stream;
  return { controller, core, embed, state, track };
}

function playThrough(embed: FakeEmbed): void {
  const pcm = pcms[pcms.length - 1];
  const emit: ChunkListener = (t, samples) => pcm.listener?.(t, samples);
  for (let i = 0; i < 26; i += 1) {
    embed.positionS = i * 0.4;
    emit(5, loud(400));
  }
  embed.emit('ended');
}

describe('CaptureController', () => {
  it('resets during the upload when the song changes, instead of staying busy', async () => {
    const { controller, core, embed, state } = makeController();
    let release: () => void = () => undefined;
    upload.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ alongside: false, message: '' }))),
    );
    await controller.start();
    playThrough(embed);
    await vi.waitFor(() => expect(state.capture.phase, state.capture.message).toBe('uploading'));
    await vi.waitFor(() => expect(upload).toHaveBeenCalled());
    expect(controller.busy).toBe(true);

    core.songs.loadToken = 2;
    release();
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(state.capture.phase).toBe('idle');
    expect(core.prepare.prepare).not.toHaveBeenCalled();
  });

  it('resets in finish() when the song changed before it began', async () => {
    const { controller, core, embed, state } = makeController();
    await controller.start();
    core.songs.loadToken = 2;
    playThrough(embed);
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(state.capture.phase).toBe('idle');
  });

  it('cancel() drops a run and puts the panel back', async () => {
    const { controller, state } = makeController();
    await controller.start();
    expect(state.capture.phase).toBe('capturing');
    controller.cancel();
    await vi.waitFor(() => expect(state.capture.phase).toBe('idle'));
    expect(controller.busy).toBe(false);
  });

  it('fails the capture with a plain message when the share ends', async () => {
    const { controller, state, track } = makeController();
    await controller.start();
    track.end();
    await vi.waitFor(() => expect(state.capture.phase).toBe('failed'));
    expect(state.capture.message).toBe(SHARE_ENDED_MESSAGE);
  });
});
