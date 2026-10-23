/**
 * Take recorder. Wraps the open mic and the PCM capture worklet so the rest of
 * the app can say "start at song time s, with this latency" and get back one
 * finished take that knows where it sits on the song's clock. It records the
 * mic's raw audio; the calibrated latency is carried alongside rather than
 * baked into the samples, so a better calibration later can re-align a stored
 * take (see `songTimeOfSample` in wav.ts). The mic is never routed to the
 * speakers (see "Audio graph" in docs/ARCHITECTURE.md).
 */
import type { PcmCapture } from './capture';
import type { AudioEngine } from './engine';
import type { MicCapture } from './mic';

/** A finished recording plus everything needed to place it on song time. */
export interface TakeRecording {
  pcm: Float32Array;
  sampleRate: number;
  /** Song time of pcm[0] before the latency shift (see songTimeOfSample). */
  startedAtSongS: number;
  /** Context time of pcm[0], for lining the take up with live pitch frames. */
  startedAtContextS: number;
  /** Round-trip latency given to start(), used when mapping to song time. */
  latencyS: number;
  durationS: number;
}

/**
 * The slice of the engine the recorder reads: the clock. Real instances
 * satisfy these three slice types; tests hand in small fakes instead.
 */
export type RecorderEngine = Pick<AudioEngine, 'now'>;
/** The slice of the mic the recorder reads: its source node. */
export type RecorderMic = Pick<MicCapture, 'source'>;
/** The slice of the PCM capture the recorder drives. */
export type RecorderCapture = Pick<PcmCapture, 'load' | 'start' | 'stop'>;

type RecorderState = 'idle' | 'starting' | 'recording';

/** Records the mic into a take aligned to the song clock. */
export class Recorder {
  private state: RecorderState = 'idle';
  private stopping: Promise<TakeRecording> | null = null;
  private songTimeS = 0;
  private contextS = 0;
  private latencyS = 0;

  constructor(
    private readonly engine: RecorderEngine,
    private readonly mic: RecorderMic,
    private readonly capture: RecorderCapture,
  ) {}

  /**
   * Starts recording the open mic. `songTimeS` is the song position at the
   * moment of this call, and the song is taken to be advancing in real time;
   * `latencyS` is the calibrated round-trip latency for this device pair.
   */
  async start(songTimeS: number, latencyS: number): Promise<void> {
    if (!Number.isFinite(songTimeS)) throw new RangeError(`Song time must be finite, got ${songTimeS}`);
    // A bad latency would skew every timing score, so refuse it rather than
    // quietly recording as if calibration were zero.
    if (!Number.isFinite(latencyS)) throw new RangeError(`Latency must be finite, got ${latencyS}`);
    if (this.state !== 'idle' || this.stopping) throw new Error('Recorder is already recording.');
    const source = this.mic.source;
    if (!source) throw new Error('Open the mic before recording.');

    // Read the clock before the awaits below so loading the worklet does not
    // count as song time the take never heard.
    const contextS = this.engine.now();
    this.state = 'starting';
    try {
      await this.capture.load();
      this.capture.start(source);
    } catch (error) {
      this.state = 'idle';
      throw error;
    }
    this.songTimeS = songTimeS;
    this.contextS = contextS;
    this.latencyS = latencyS;
    this.state = 'recording';
  }

  /** Ends the recording; concurrent calls share one result. */
  stop(): Promise<TakeRecording> {
    if (this.stopping) return this.stopping;
    if (this.state !== 'recording') return Promise.reject(new Error('Recorder.stop() while not recording.'));
    this.stopping = this.finish().finally(() => {
      this.stopping = null;
      this.state = 'idle';
    });
    return this.stopping;
  }

  /** True from a successful start() until stop() is called. */
  get recording(): boolean {
    return this.state === 'recording' && this.stopping === null;
  }

  private async finish(): Promise<TakeRecording> {
    const take = await this.capture.stop();
    // The worklet's first chunk lands a little after start(); the take's
    // sample 0 is that chunk, so move the song-time anchor by the same gap.
    const startedAtSongS = this.songTimeS + (take.startedAtContextS - this.contextS);
    return {
      pcm: take.pcm,
      sampleRate: take.sampleRate,
      startedAtSongS,
      startedAtContextS: take.startedAtContextS,
      latencyS: this.latencyS,
      durationS: take.pcm.length / take.sampleRate,
    };
  }
}
