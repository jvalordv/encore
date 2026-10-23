/**
 * Unit tests for the take recorder against a fake engine clock, mic and PCM
 * capture: start/stop protocol, the song-time anchor (including the gap before
 * the worklet's first chunk), latency carry-through, duration, and the state
 * machine's refusals. The worklet itself needs a real audio thread.
 */
import { describe, expect, it } from 'vitest';
import type { PcmTake } from '../src/audio/capture';
import { Recorder } from '../src/audio/recorder';
import type { RecorderCapture, RecorderEngine, RecorderMic } from '../src/audio/recorder';
import { songTimeOfSample } from '../src/audio/wav';

/** A capture that records calls and hands back a canned take on stop. */
class FakeCapture implements RecorderCapture {
  calls: string[] = [];
  started: AudioNode | null = null;
  take: PcmTake = { pcm: new Float32Array(0), sampleRate: 48000, startedAtContextS: 0 };
  loadError: Error | null = null;
  stopError: Error | null = null;
  private active = false;

  async load(): Promise<void> {
    this.calls.push('load');
    if (this.loadError) throw this.loadError;
  }

  start(source: AudioNode): void {
    this.calls.push('start');
    this.started = source;
    this.active = true;
  }

  async stop(): Promise<PcmTake> {
    this.calls.push('stop');
    if (!this.active) throw new Error('not recording');
    this.active = false;
    if (this.stopError) throw this.stopError;
    return this.take;
  }
}

/** A clock the test moves by hand. */
function clock(at: number): RecorderEngine & { set(t: number): void } {
  let t = at;
  return { now: () => t, set: (v) => void (t = v) };
}

const SOURCE = { tag: 'mic-source' } as unknown as MediaStreamAudioSourceNode;

function rig(source: MediaStreamAudioSourceNode | null = SOURCE) {
  const engine = clock(10);
  const capture = new FakeCapture();
  const mic: RecorderMic = { source };
  return { engine, capture, recorder: new Recorder(engine, mic, capture) };
}

describe('Recorder', () => {
  it('loads the worklet, starts the capture on the mic source and reports recording', async () => {
    const { recorder, capture } = rig();
    expect(recorder.recording).toBe(false);
    await recorder.start(2, 0.1);
    expect(capture.calls).toEqual(['load', 'start']);
    expect(capture.started).toBe(SOURCE);
    expect(recorder.recording).toBe(true);
  });

  it('returns the take with song time, latency and duration filled in', async () => {
    const { recorder, capture, engine } = rig();
    await recorder.start(12.5, 0.137);
    // Two seconds of audio whose first chunk landed exactly at the start.
    capture.take = { pcm: new Float32Array(96000), sampleRate: 48000, startedAtContextS: 10 };
    engine.set(12);
    const take = await recorder.stop();
    expect(take.pcm).toBe(capture.take.pcm);
    expect(take.sampleRate).toBe(48000);
    expect(take.startedAtSongS).toBeCloseTo(12.5, 12);
    expect(take.startedAtContextS).toBe(10);
    expect(take.latencyS).toBe(0.137);
    expect(take.durationS).toBeCloseTo(2, 12);
    expect(recorder.recording).toBe(false);
  });

  it('moves the song anchor by the gap before the first chunk', async () => {
    const { recorder, capture } = rig();
    await recorder.start(30, 0);
    // The worklet's first block was stamped 23 ms after start().
    capture.take = { pcm: new Float32Array(44100), sampleRate: 44100, startedAtContextS: 10.023 };
    const take = await recorder.stop();
    expect(take.startedAtSongS).toBeCloseTo(30.023, 9);
    expect(take.durationS).toBeCloseTo(1, 12);
    expect(take.sampleRate).toBe(44100);
  });

  it('reads the clock before loading, so load time counts as elapsed song time', async () => {
    const engine = clock(10);
    const capture = new FakeCapture();
    const originalLoad = capture.load.bind(capture);
    capture.load = async () => {
      engine.set(10.4);
      await originalLoad();
    };
    const recorder = new Recorder(engine, { source: SOURCE }, capture);
    await recorder.start(5, 0);
    capture.take = { pcm: new Float32Array(480), sampleRate: 48000, startedAtContextS: 10.41 };
    const take = await recorder.stop();
    // Song was at 5 s when start() was called at context 10 s; the first
    // sample is 0.41 s of context time later.
    expect(take.startedAtSongS).toBeCloseTo(5.41, 9);
  });

  it('places a sample on song time once latency is taken off', async () => {
    const { recorder, capture } = rig();
    await recorder.start(8, 0.1);
    capture.take = { pcm: new Float32Array(48000), sampleRate: 48000, startedAtContextS: 10 };
    const take = await recorder.stop();
    const at = songTimeOfSample(24000, take.sampleRate, take.startedAtSongS, take.latencyS);
    expect(at).toBeCloseTo(8.4, 9);
  });

  it('handles a take with no audio', async () => {
    const { recorder } = rig();
    await recorder.start(1, 0);
    const take = await recorder.stop();
    expect(take.pcm.length).toBe(0);
    expect(take.durationS).toBe(0);
  });

  it('refuses to start without an open mic and leaves the capture alone', async () => {
    const { recorder, capture } = rig(null);
    await expect(recorder.start(0, 0)).rejects.toThrow(/mic/i);
    expect(capture.calls).toEqual([]);
    expect(recorder.recording).toBe(false);
  });

  it('refuses a non-finite song time or latency', async () => {
    const { recorder, capture } = rig();
    await expect(recorder.start(NaN, 0)).rejects.toThrow(RangeError);
    await expect(recorder.start(0, NaN)).rejects.toThrow(RangeError);
    await expect(recorder.start(0, Infinity)).rejects.toThrow(RangeError);
    expect(capture.calls).toEqual([]);
  });

  it('refuses a second start, including one racing the first', async () => {
    const { recorder, capture } = rig();
    const first = recorder.start(0, 0);
    await expect(recorder.start(0, 0)).rejects.toThrow(/already/);
    await first;
    await expect(recorder.start(0, 0)).rejects.toThrow(/already/);
    expect(capture.calls).toEqual(['load', 'start']);
  });

  it('rejects stop when it never started', async () => {
    const { recorder } = rig();
    await expect(recorder.stop()).rejects.toThrow(/not recording/);
  });

  it('shares one result between concurrent stops and then rejects a stray one', async () => {
    const { recorder, capture } = rig();
    await recorder.start(0, 0);
    const a = recorder.stop();
    const b = recorder.stop();
    expect(b).toBe(a);
    expect(recorder.recording).toBe(false);
    await a;
    expect(capture.calls.filter((c) => c === 'stop').length).toBe(1);
    await expect(recorder.stop()).rejects.toThrow(/not recording/);
  });

  it('can record again after a stop, with a fresh anchor', async () => {
    const { recorder, capture, engine } = rig();
    await recorder.start(1, 0.05);
    capture.take = { pcm: new Float32Array(480), sampleRate: 48000, startedAtContextS: 10 };
    await recorder.stop();
    engine.set(50);
    await recorder.start(20, 0.2);
    capture.take = { pcm: new Float32Array(480), sampleRate: 48000, startedAtContextS: 50 };
    const second = await recorder.stop();
    expect(second.startedAtSongS).toBeCloseTo(20, 12);
    expect(second.latencyS).toBe(0.2);
  });

  it('returns to idle when loading the worklet fails, and can retry', async () => {
    const { recorder, capture } = rig();
    capture.loadError = new Error('addModule failed');
    await expect(recorder.start(0, 0)).rejects.toThrow('addModule failed');
    expect(recorder.recording).toBe(false);
    capture.loadError = null;
    await recorder.start(0, 0);
    expect(recorder.recording).toBe(true);
  });

  it('returns to idle when the capture fails on stop, and passes the error on', async () => {
    const { recorder, capture } = rig();
    await recorder.start(0, 0);
    capture.stopError = new Error('worklet gone');
    await expect(recorder.stop()).rejects.toThrow('worklet gone');
    expect(recorder.recording).toBe(false);
    capture.stopError = null;
    await recorder.start(0, 0);
    expect(recorder.recording).toBe(true);
  });
});
