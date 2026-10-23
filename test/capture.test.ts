/**
 * Unit tests for the PCM capture path: the pure chunk assembler that runs in
 * the worklet, the concatenation that builds a take, and PcmCapture's
 * load/start/stop protocol against a fake AudioWorkletNode. The processor's
 * registration needs a real audio thread and is exercised by the Playwright
 * smoke test in a later phase.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PcmCapture, concatChunks } from '../src/audio/capture';
import { CAPTURE_CHUNK_SIZE, CAPTURE_PROCESSOR_NAME, ChunkAssembler } from '../src/audio/capture-worklet';
import type { CaptureMessage } from '../src/audio/capture-worklet';
import type { AudioEngine } from '../src/audio/engine';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** `n` samples counting up from `from`, so any reordering shows in a test. */
function ramp(n: number, from = 0): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => from + i);
}

describe('concatChunks', () => {
  it('joins chunks in order', () => {
    const out = concatChunks([ramp(3, 0), ramp(2, 3), ramp(4, 5)]);
    expect(Array.from(out)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('gives an empty array for no chunks and skips empty ones', () => {
    expect(concatChunks([]).length).toBe(0);
    expect(Array.from(concatChunks([new Float32Array(0), ramp(2), new Float32Array(0)]))).toEqual([0, 1]);
  });

  it('copies, so later edits to a chunk do not change the take', () => {
    const chunk = ramp(2);
    const out = concatChunks([chunk]);
    chunk[0] = 99;
    expect(out[0]).toBe(0);
  });
});

describe('ChunkAssembler', () => {
  const rate = 48000;

  function collect(size: number) {
    const chunks: { t: number; samples: Float32Array }[] = [];
    const assembler = new ChunkAssembler(size, (t, samples) => chunks.push({ t, samples }));
    return { assembler, chunks };
  }

  it('emits a chunk each time it fills, stamped with its first sample', () => {
    const { assembler, chunks } = collect(256);
    const t0 = 10;
    // 8 render quanta of 128 = 1024 samples = 4 chunks of 256.
    for (let q = 0; q < 8; q++) assembler.push(ramp(128, q * 128), t0 + (q * 128) / rate, rate);
    expect(chunks).toHaveLength(4);
    chunks.forEach((c, i) => {
      expect(c.samples).toHaveLength(256);
      expect(c.samples[0]).toBe(i * 256);
      expect(c.t).toBeCloseTo(t0 + (i * 256) / rate, 9);
    });
  });

  it('holds back a partial chunk until flush, then trims it', () => {
    const { assembler, chunks } = collect(256);
    assembler.push(ramp(128), 5, rate);
    assembler.push(ramp(100, 128), 5 + 128 / rate, rate);
    expect(chunks).toHaveLength(0);
    assembler.flush();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].samples).toHaveLength(228);
    expect(chunks[0].t).toBe(5);
    expect(chunks[0].samples[227]).toBe(227);
  });

  it('splits a block that straddles a chunk boundary and times the second half', () => {
    const { assembler, chunks } = collect(100);
    assembler.push(ramp(60), 0, rate);
    assembler.push(ramp(100, 60), 60 / rate, rate);
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0].samples)).toEqual(Array.from(ramp(100)));
    assembler.flush();
    expect(chunks).toHaveLength(2);
    expect(chunks[1].samples).toHaveLength(60);
    expect(chunks[1].samples[0]).toBe(100);
    expect(chunks[1].t).toBeCloseTo(100 / rate, 9);
  });

  it('keeps every sample exactly once across chunks, in order', () => {
    const { assembler, chunks } = collect(CAPTURE_CHUNK_SIZE);
    const total = 5000;
    for (let at = 0; at < total; at += 128) {
      assembler.push(ramp(Math.min(128, total - at), at), at / rate, rate);
    }
    assembler.flush();
    expect(Array.from(concatChunks(chunks.map((c) => c.samples)))).toEqual(Array.from(ramp(total)));
  });

  it('flush on an empty assembler emits nothing and can repeat', () => {
    const { assembler, chunks } = collect(64);
    assembler.flush();
    assembler.push(ramp(64), 0, rate);
    assembler.flush();
    assembler.flush();
    expect(chunks).toHaveLength(1);
  });

  it('copies its input, so the caller may reuse the block', () => {
    const { assembler, chunks } = collect(4);
    const block = Float32Array.of(1, 2, 3, 4);
    assembler.push(block, 0, rate);
    block.fill(0);
    expect(Array.from(chunks[0].samples)).toEqual([1, 2, 3, 4]);
  });

  it('uses the chunk size the contract specifies', () => {
    expect(CAPTURE_CHUNK_SIZE).toBe(2048);
    expect(CAPTURE_PROCESSOR_NAME).toBe('encore-capture');
  });
});

/** Stand-in for AudioWorkletNode: records wiring, lets a test play worklet. */
class FakeNode {
  static last: FakeNode | null = null;
  readonly options: unknown;
  readonly sent: unknown[] = [];
  readonly connections: unknown[] = [];
  disconnected = false;
  closed = false;
  autoFlush: { t: number; samples: Float32Array } | null = null;
  respondToStop = true;
  readonly port = {
    onmessage: null as ((e: { data: CaptureMessage }) => void) | null,
    postMessage: (message: { type: string }) => {
      this.sent.push(message);
      if (message.type !== 'stop' || !this.respondToStop) return;
      queueMicrotask(() => {
        if (this.autoFlush) this.emit({ type: 'chunk', ...this.autoFlush });
        this.emit({ type: 'done' });
      });
    },
    close: () => {
      this.closed = true;
    },
  };

  constructor(_context: unknown, name: string, options: unknown) {
    this.options = { name, ...(options as object) };
    FakeNode.last = this;
  }

  connect(target: unknown) {
    this.connections.push(target);
  }

  disconnect() {
    this.disconnected = true;
  }

  /** Delivers a message from the "worklet" to the main thread. */
  emit(data: CaptureMessage) {
    this.port.onmessage?.({ data });
  }
}

function fakeEngine(opts: { audioWorklet?: boolean } = {}) {
  const addModule = vi.fn(async (_url: string) => {});
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const destination = {};
  const context = {
    sampleRate: 48000,
    destination,
    audioWorklet: opts.audioWorklet === false ? undefined : { addModule },
    createGain: () => gain,
  };
  const state = { nowS: 3 };
  const engine = { context, now: () => state.nowS } as unknown as AudioEngine;
  return { engine, addModule, gain, destination, state };
}

function fakeSource() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

describe('PcmCapture', () => {
  beforeEach(() => {
    FakeNode.last = null;
    vi.stubGlobal('AudioWorkletNode', FakeNode);
  });

  it('is unsupported where AudioWorklet is absent', () => {
    expect(PcmCapture.isSupported()).toBe(false);
  });

  it('loads the module once per context, even across instances', async () => {
    const { engine, addModule } = fakeEngine();
    await Promise.all([new PcmCapture(engine).load(), new PcmCapture(engine).load()]);
    await new PcmCapture(engine).load();
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(typeof addModule.mock.calls[0][0]).toBe('string');
  });

  it('retries after a failed load', async () => {
    const { engine, addModule } = fakeEngine();
    addModule.mockRejectedValueOnce(new Error('network'));
    const capture = new PcmCapture(engine);
    await expect(capture.load()).rejects.toThrow('network');
    await capture.load();
    expect(addModule).toHaveBeenCalledTimes(2);
  });

  it('rejects load when the context has no audioWorklet', async () => {
    const { engine } = fakeEngine({ audioWorklet: false });
    await expect(new PcmCapture(engine).load()).rejects.toThrow(/AudioWorklet/);
  });

  it('refuses to start before load, to double start, and to stop while idle', async () => {
    const { engine } = fakeEngine();
    const capture = new PcmCapture(engine);
    expect(() => capture.start(fakeSource() as unknown as AudioNode)).toThrow(/load/);
    await expect(capture.stop()).rejects.toThrow(/not recording/);
    await capture.load();
    capture.start(fakeSource() as unknown as AudioNode);
    expect(() => capture.start(fakeSource() as unknown as AudioNode)).toThrow(/already/);
  });

  it('wires source to a muted sink on the destination, mono and explicit', async () => {
    const { engine, gain, destination } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    const source = fakeSource();
    capture.start(source as unknown as AudioNode);

    const node = FakeNode.last!;
    expect(node.options).toMatchObject({
      name: 'encore-capture',
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(node.connections).toEqual([gain]);
    expect(gain.gain.value).toBe(0);
    expect(gain.connect).toHaveBeenCalledWith(destination);
    expect(capture.recording).toBe(true);
  });

  it('streams chunks to taps while recording and stops listening on unsubscribe', async () => {
    const { engine } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    const seen: number[] = [];
    const off = capture.onChunk((t) => seen.push(t));
    capture.start(fakeSource() as unknown as AudioNode);
    FakeNode.last!.emit({ type: 'chunk', t: 1, samples: ramp(4) });
    off();
    FakeNode.last!.emit({ type: 'chunk', t: 2, samples: ramp(4) });
    expect(seen).toEqual([1]);
  });

  it('survives a throwing tap without losing audio or skipping other taps', async () => {
    const { engine } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    // Capture the deferred rethrow instead of letting it hit the test runner.
    const deferred: (() => void)[] = [];
    vi.stubGlobal('queueMicrotask', (fn: () => void) => deferred.push(fn));
    const later = vi.fn();
    capture.onChunk(() => {
      throw new Error('tap broke');
    });
    capture.onChunk(later);
    capture.start(fakeSource() as unknown as AudioNode);
    FakeNode.last!.emit({ type: 'chunk', t: 1, samples: ramp(4) });

    expect(later).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toThrow('tap broke');

    // The fake worklet answers stop() through queueMicrotask; restore it.
    vi.unstubAllGlobals();
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const take = await capture.stop();
    expect(take.pcm).toHaveLength(4);
  });

  it('returns the concatenated take with the first chunk time and context rate', async () => {
    const { engine } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    const source = fakeSource();
    capture.start(source as unknown as AudioNode);
    const node = FakeNode.last!;
    node.emit({ type: 'chunk', t: 7.5, samples: ramp(4, 0) });
    node.emit({ type: 'chunk', t: 7.5 + 4 / 48000, samples: ramp(4, 4) });
    // The worklet's partial chunk arrives in answer to the stop command.
    node.autoFlush = { t: 7.5 + 8 / 48000, samples: ramp(3, 8) };

    const pending = capture.stop();
    expect(capture.recording).toBe(false);
    const take = await pending;

    expect(node.sent).toEqual([{ type: 'stop' }]);
    expect(Array.from(take.pcm)).toEqual(Array.from(ramp(11)));
    expect(take.sampleRate).toBe(48000);
    expect(take.startedAtContextS).toBe(7.5);
    expect(node.closed).toBe(true);
    expect(node.disconnected).toBe(true);
    expect(source.disconnect).toHaveBeenCalledWith(node);
    expect(capture.recording).toBe(false);
  });

  it('still returns the take when the source was already disconnected', async () => {
    const { engine } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    const source = fakeSource();
    source.disconnect.mockImplementation(() => {
      throw new Error('InvalidAccessError: not connected');
    });
    capture.start(source as unknown as AudioNode);
    const node = FakeNode.last!;
    node.emit({ type: 'chunk', t: 1, samples: ramp(4, 0) });

    const take = await capture.stop();

    expect(Array.from(take.pcm)).toEqual(Array.from(ramp(4)));
    expect(node.disconnected).toBe(true);
    expect(capture.recording).toBe(false);
  });

  it('shares one stop between concurrent callers', async () => {
    const { engine } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    capture.start(fakeSource() as unknown as AudioNode);
    const first = capture.stop();
    const second = capture.stop();
    expect(second).toBe(first);
    await first;
    expect(FakeNode.last!.sent).toHaveLength(1);
  });

  it('falls back to the start time when no audio arrived', async () => {
    const { engine, state } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    state.nowS = 42;
    capture.start(fakeSource() as unknown as AudioNode);
    const take = await capture.stop();
    expect(take.pcm).toHaveLength(0);
    expect(take.startedAtContextS).toBe(42);
  });

  it('gives up on a worklet that never answers and returns what it has', async () => {
    vi.useFakeTimers();
    const { engine } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    capture.start(fakeSource() as unknown as AudioNode);
    const node = FakeNode.last!;
    node.respondToStop = false;
    node.emit({ type: 'chunk', t: 1, samples: ramp(5) });

    const pending = capture.stop();
    await vi.advanceTimersByTimeAsync(1500);
    const take = await pending;

    expect(take.pcm).toHaveLength(5);
    expect(capture.recording).toBe(false);
  });

  it('can record again after a stop, starting from a clean slate', async () => {
    const { engine } = fakeEngine();
    const capture = new PcmCapture(engine);
    await capture.load();
    capture.start(fakeSource() as unknown as AudioNode);
    FakeNode.last!.emit({ type: 'chunk', t: 1, samples: ramp(6) });
    await capture.stop();

    capture.start(fakeSource() as unknown as AudioNode);
    FakeNode.last!.emit({ type: 'chunk', t: 9, samples: ramp(2) });
    const take = await capture.stop();
    expect(take.pcm).toHaveLength(2);
    expect(take.startedAtContextS).toBe(9);
  });
});

describe('capture processor', () => {
  /** Loads a fresh copy of the worklet module inside a fake worklet scope. */
  async function loadProcessor() {
    const posted: { message: CaptureMessage; transfer?: unknown[] }[] = [];
    class FakeProcessor {
      readonly port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: (message: CaptureMessage, transfer?: unknown[]) => {
          posted.push({ message, transfer });
        },
      };
    }
    const registered: Record<string, new () => unknown> = {};
    vi.stubGlobal('AudioWorkletProcessor', FakeProcessor);
    vi.stubGlobal('registerProcessor', (name: string, ctor: new () => unknown) => {
      registered[name] = ctor;
    });
    vi.stubGlobal('sampleRate', 48000);
    vi.stubGlobal('currentTime', 0);
    vi.resetModules();
    await import('../src/audio/capture-worklet');
    type Processor = FakeProcessor & {
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    };
    const processor = new registered[CAPTURE_PROCESSOR_NAME]() as Processor;
    const run = (input: Float32Array[] | undefined, at: number): boolean => {
      vi.stubGlobal('currentTime', at);
      return processor.process(input ? [input] : [[]], [[new Float32Array(128)]]);
    };
    return { processor, posted, run, registered };
  }

  it('registers under the contract name only inside a worklet scope', async () => {
    const { registered } = await loadProcessor();
    expect(Object.keys(registered)).toEqual(['encore-capture']);
    // Plain import with no worklet globals must be harmless.
    vi.unstubAllGlobals();
    vi.resetModules();
    await expect(import('../src/audio/capture-worklet')).resolves.toBeDefined();
  });

  it('posts a 2048-sample chunk per 16 quanta, transferring the buffer', async () => {
    const { posted, run } = await loadProcessor();
    for (let q = 0; q < 16; q++) {
      expect(run([ramp(128, q * 128)], 2 + (q * 128) / 48000)).toBe(true);
    }
    expect(posted).toHaveLength(1);
    const { message, transfer } = posted[0];
    if (message.type !== 'chunk') throw new Error('expected a chunk');
    expect(message.samples).toHaveLength(2048);
    expect(message.samples[2047]).toBe(2047);
    expect(message.t).toBe(2);
    expect(transfer).toEqual([message.samples.buffer]);
  });

  it('flushes the partial chunk then reports done on stop, and goes quiet', async () => {
    const { processor, posted, run } = await loadProcessor();
    run([ramp(128)], 1);
    run([ramp(128, 128)], 1 + 128 / 48000);
    processor.port.onmessage?.({ data: { type: 'stop' } });

    expect(posted.map((p) => p.message.type)).toEqual(['chunk', 'done']);
    const chunk = posted[0].message;
    if (chunk.type !== 'chunk') throw new Error('expected a chunk');
    expect(chunk.samples).toHaveLength(256);
    expect(chunk.t).toBe(1);
    // Done exactly once, and process() asks to be released afterwards.
    processor.port.onmessage?.({ data: { type: 'stop' } });
    expect(posted).toHaveLength(2);
    expect(run([ramp(128)], 2)).toBe(false);
  });

  it('writes zeros when no input is connected, keeping sample time intact', async () => {
    const { processor, posted, run } = await loadProcessor();
    run([ramp(128, 1)], 0);
    run(undefined, 128 / 48000);
    run([ramp(128, 1)], 256 / 48000);
    processor.port.onmessage?.({ data: { type: 'stop' } });
    const chunk = posted[0].message;
    if (chunk.type !== 'chunk') throw new Error('expected a chunk');
    expect(chunk.samples).toHaveLength(384);
    expect(chunk.samples[128]).toBe(0);
    expect(chunk.samples[255]).toBe(0);
    expect(chunk.samples[256]).toBe(1);
  });

  it('ignores commands it does not know', async () => {
    const { processor, posted, run } = await loadProcessor();
    processor.port.onmessage?.({ data: { type: 'bogus' } });
    processor.port.onmessage?.({ data: undefined });
    expect(posted).toHaveLength(0);
    expect(run([ramp(128)], 0)).toBe(true);
  });
});
