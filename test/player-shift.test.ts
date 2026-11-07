/**
 * The Player's key shift routing on a fake AudioContext: stems feed the
 * shifter's bus while a shift is on and the master when it is not, a stem
 * added unshifted (a replayed take) and a transient song never go through
 * it, the delay is stated while it is in the path, and a browser without
 * AudioWorklet leaves the song as it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../src/audio/engine';
import { SHIFT_LATENCY_SAMPLES } from '../src/audio/pitch-shift';
import { Player } from '../src/audio/player';

const supported = vi.hoisted(() => ({ value: true }));
const node = vi.hoisted(() => ({
  connect: vi.fn(),
  port: { postMessage: vi.fn() },
}));

vi.mock('../src/audio/shift-node', () => ({
  shiftSupported: () => supported.value,
  createShiftNode: vi.fn(async () => node),
  setNodeShift: (n: { port: { postMessage: (m: unknown) => void } }, semitones: number) =>
    n.port.postMessage({ semitones }),
}));

class FakeGain {
  gain = { value: 1, setTargetAtTime: vi.fn() };
  to: unknown = null;
  connect(n: unknown): void {
    this.to = n;
  }
  disconnect(): void {
    this.to = null;
  }
}

class FakeBuffer {
  duration = 10;
  numberOfChannels = 1;
  sampleRate = 48000;
  length = 480000;
  getChannelData(): Float32Array {
    return new Float32Array(1);
  }
}

function setup() {
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => new FakeGain(),
    createBufferSource: () => ({ connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() }),
    decodeAudioData: async () => new FakeBuffer(),
  };
  const master = { id: 'master' };
  const engine = { context: ctx, master, now: () => ctx.currentTime, resume: async () => undefined };
  const player = new Player(engine as unknown as AudioEngine);
  return { player, master };
}

/** Where a stem's gain feeds, read off the fake. */
function feeds(player: Player, id: string): unknown {
  const stems = (player as unknown as { stems: Map<string, { gain: FakeGain }> }).stems;
  return stems.get(id)?.gain.to;
}

beforeEach(() => {
  supported.value = true;
  node.port.postMessage.mockClear();
});

describe('Player.setShift', () => {
  it('starts unshifted, with the stems on the master and no delay', async () => {
    const { player, master } = setup();
    await player.load(new Blob(['x']), 'a.mp3');
    expect(player.shift).toBe(0);
    expect(player.shifterInGraph).toBe(false);
    expect(player.shiftDelayS).toBe(0);
    expect(feeds(player, 'original')).toBe(master);
  });

  it('routes the stems through the shifter and states its delay', async () => {
    const { player, master } = setup();
    await player.load(new Blob(['x']), 'a.mp3');
    expect(await player.setShift(3)).toBe(true);
    expect(player.shift).toBe(3);
    expect(player.shifterInGraph).toBe(true);
    expect(feeds(player, 'original')).not.toBe(master);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ semitones: 3 });
    expect(player.shiftDelayS).toBeCloseTo(SHIFT_LATENCY_SAMPLES / 48000, 9);
    // A stem added now follows the same route.
    player.addStem('karaoke', new FakeBuffer() as unknown as AudioBuffer);
    expect(feeds(player, 'karaoke')).toBe(feeds(player, 'original'));
  });

  it('takes the shifter out of the path at zero, and the delay with it', async () => {
    const { player, master } = setup();
    await player.load(new Blob(['x']), 'a.mp3');
    await player.setShift(-4);
    await player.setShift(0);
    expect(player.shifterInGraph).toBe(false);
    expect(player.shiftDelayS).toBe(0);
    expect(feeds(player, 'original')).toBe(master);
  });

  it('holds the shift to -6..+6 and whole semitones', async () => {
    const { player } = setup();
    await player.load(new Blob(['x']), 'a.mp3');
    await player.setShift(9);
    expect(player.shift).toBe(6);
    await player.setShift(-2.4);
    expect(player.shift).toBe(-2);
  });

  it('keeps an unshifted stem (a replayed take) on the master', async () => {
    const { player, master } = setup();
    await player.load(new Blob(['x']), 'a.mp3');
    player.addStem('take', new FakeBuffer() as unknown as AudioBuffer, 0, undefined, false);
    await player.setShift(2);
    expect(feeds(player, 'take')).toBe(master);
    expect(feeds(player, 'original')).not.toBe(master);
  });

  it('never shifts a transient song, and shifts the song again when it returns', async () => {
    const { player, master } = setup();
    await player.load(new Blob(['x']), 'a.mp3');
    await player.setShift(2);
    const bus = feeds(player, 'original');
    await player.loadTransient(new Blob(['y']), 'test', 'k');
    expect(feeds(player, 'original')).toBe(master);
    expect(player.shifterInGraph).toBe(false);
    player.endTransient();
    expect(feeds(player, 'original')).toBe(bus);
    expect(player.shifterInGraph).toBe(true);
  });

  it('leaves the song as it was where AudioWorklet is missing', async () => {
    supported.value = false;
    const { player, master } = setup();
    await player.load(new Blob(['x']), 'a.mp3');
    expect(await player.setShift(3)).toBe(false);
    expect(player.shift).toBe(0);
    expect(feeds(player, 'original')).toBe(master);
  });
});
