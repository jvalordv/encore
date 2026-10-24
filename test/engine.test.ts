/**
 * Tests for the one piece of the audio engine that is more than a pass-through:
 * `ensureRunning`, which starts the context and waits for its clock to move.
 * The engine is built over a fake AudioContext whose start the test settles by
 * hand and whose clock moves only while the test says it ticks, with manual
 * timers, so a start that is quick, slow, refused or never answered, and a
 * state that turns to running before the clock does, are each a plain sequence
 * of steps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/engine';

type ContextState = 'suspended' | 'running' | 'closed';

/** The parts of an AudioContext the engine uses; the test settles its start. */
class FakeContext {
  static last: FakeContext | null = null;
  state: ContextState = 'suspended';
  currentTime = 0;
  /** True while the device is calling back, so the clock moves with time. */
  ticking = false;
  readonly destination = {};
  resumeCalls = 0;
  private settle: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor() {
    FakeContext.last = this;
  }

  createGain() {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  }

  suspend(): Promise<void> {
    this.state = 'suspended';
    this.ticking = false;
    return Promise.resolve();
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    return new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }

  /** The browser has started the context: its state turns to running. */
  start(): void {
    this.state = 'running';
    this.settle?.resolve();
  }

  /** The browser refuses to start it. */
  refuse(): void {
    this.settle?.reject(new DOMException('not allowed', 'NotAllowedError'));
  }
}

function setup() {
  const engine = new AudioEngine();
  return { engine, context: FakeContext.last! };
}

/** Time passes, 5 ms at a time; the clock moves with it while it ticks. */
async function pass(context: FakeContext, ms: number): Promise<void> {
  for (let spent = 0; spent < ms; spent += 5) {
    if (context.ticking) context.currentTime += 0.005;
    await vi.advanceTimersByTimeAsync(5);
  }
}

describe('AudioEngine.ensureRunning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', FakeContext);
    FakeContext.last = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Asks, and notes the answer when it comes. */
  function ask(engine: AudioEngine, timeoutMs = 2000): { answer: boolean | null } {
    const result: { answer: boolean | null } = { answer: null };
    void engine.ensureRunning(timeoutMs).then((value) => {
      result.answer = value;
    });
    return result;
  }

  it('answers true within a few milliseconds for a context that runs and ticks', async () => {
    const { engine, context } = setup();
    context.state = 'running';
    context.ticking = true;
    const result = ask(engine);
    await pass(context, 5);
    expect(result.answer).toBeNull();
    await pass(context, 10);
    expect(result.answer).toBe(true);
    // Asked to start all the same: a running context takes that as nothing.
    expect(context.resumeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a suspended context and answers true once its clock moves', async () => {
    const { engine, context } = setup();
    const result = ask(engine);
    // A slow start: nothing is answered while the context is still starting.
    await pass(context, 900);
    expect(context.resumeCalls).toBe(1);
    expect(result.answer).toBeNull();
    context.start();
    context.ticking = true;
    await pass(context, 30);
    expect(result.answer).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the clock when the state turns to running before it moves', async () => {
    const { engine, context } = setup();
    const result = ask(engine);
    await pass(context, 100);
    // The device is still being opened: running as far as the state goes.
    context.start();
    await pass(context, 700);
    expect(context.state).toBe('running');
    expect(result.answer).toBeNull();
    context.ticking = true;
    await pass(context, 30);
    expect(result.answer).toBe(true);
  });

  it('answers false when the clock has not moved by the time it was given', async () => {
    const { engine, context } = setup();
    const result = ask(engine, 500);
    context.start();
    await pass(context, 480);
    expect(result.answer).toBeNull();
    await pass(context, 40);
    expect(result.answer).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // It does tick in the end; asking again then finds it so.
    context.ticking = true;
    const again = ask(engine, 500);
    await pass(context, 30);
    expect(again.answer).toBe(true);
  });

  it('answers false, without the whole wait, for a start the browser refuses', async () => {
    const { engine, context } = setup();
    const result = ask(engine, 2000);
    context.refuse();
    await pass(context, 30);
    expect(result.answer).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers false for a start that is never answered, once the time is up', async () => {
    const { engine, context } = setup();
    const result = ask(engine, 500);
    await pass(context, 480);
    expect(result.answer).toBeNull();
    await pass(context, 40);
    expect(result.answer).toBe(false);
  });

  it('answers false for a context that is closed, without starting it', async () => {
    const { engine, context } = setup();
    context.state = 'closed';
    const result = ask(engine, 100);
    await pass(context, 130);
    expect(result.answer).toBe(false);
    expect(context.resumeCalls).toBe(0);
  });
});
