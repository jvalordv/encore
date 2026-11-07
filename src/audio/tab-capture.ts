/**
 * Records the sound of the embedded video from this tab, for "Capture for
 * learning". The browser's tab share (`getDisplayMedia`) gives a stream whose
 * audio is whatever the tab plays; the video track is dropped at once, since
 * only the sound is wanted. The audio goes through the same PCM worklet as the
 * mic (capture.ts), so there is no lossy codec, and each block is placed at
 * the video time the embed clock gives it (capture-assembler.ts), only while
 * the video is playing: an ad, a buffering spell or a pause adds nothing. The
 * result is a WAV of the video's length, silent where nothing was heard.
 *
 * The stream is not the mic and is not routed to the speakers: the tab keeps
 * playing on its own. The source of the stream is injectable, which is the
 * test seam `?captureFake` uses (src/app/session/capture-seam.ts), since a
 * headless browser cannot pick a tab.
 */
import { PcmCapture } from './capture';
import { CaptureAssembler } from './capture-assembler';
import type { AudioEngine } from './engine';
import type { TransportState } from './transport';
import { encodeWavBlob } from './wav';

/** Gives the stream whose audio is the tab's sound. */
export type TabAudioSource = () => Promise<MediaStream>;

/**
 * A recording whose loudest sample is below this is silence: a muted tab or
 * a share that was stopped feeds exact zeros, and real music, however quiet,
 * peaks far above it (about -80 dBFS).
 */
export const SILENT_PEAK = 1e-4;

/** Said when the share ended while recording. */
export const SHARE_ENDED_MESSAGE = 'The tab share stopped, so the capture was cancelled.';
/** Said when the recording holds nothing but silence. */
export const SILENT_MESSAGE =
  "The captured audio was silent — share the tab with 'Share tab audio' on and keep it unmuted.";

/** How often progress is reported, milliseconds. */
const PROGRESS_MS = 250;

/** True when this browser can share a tab, and with it the tab's sound. */
export function tabShareSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * The real source: asks to share this tab with its audio, keeps only the
 * audio tracks and stops the video at once. A stream with no audio track is
 * returned as is, and the caller says what to do about it.
 */
export const displayTabSource: TabAudioSource = async () => {
  // The two extra hints are Chrome's; other browsers ignore unknown members.
  const options = {
    video: true,
    audio: true,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  } as DisplayMediaStreamOptions;
  const shared = await navigator.mediaDevices.getDisplayMedia(options);
  for (const track of shared.getVideoTracks()) {
    track.stop();
    shared.removeTrack(track);
  }
  return shared;
};

/** The slice of the embed transport that the capture reads and drives. */
export interface CaptureEmbed {
  readonly state: TransportState;
  readonly positionS: number;
  readonly durationS: number;
  seek(positionS: number): void;
  play(): void;
  pause(): void;
  on(event: 'seek' | 'ended', listener: () => void): () => void;
}

/** The slice of the engine the capture reads. */
export type CaptureEngine = Pick<AudioEngine, 'context' | 'now'>;

/** What a finished capture is. */
export interface CaptureResult {
  wav: Blob;
  coverage: number;
  largestGapS: number;
  durationS: number;
}

/** Hooks a running capture reports to. */
export interface TabCaptureHooks {
  /** Coverage and the largest gap, a few times a second. */
  onProgress(coverage: number, largestGapS: number): void;
  /** The video played to its end. */
  onEnded(): void;
  /** The share stopped before the recording was finished. */
  onFailed(message: string): void;
}

/** One capture of one video's sound. */
export class TabCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private pcm: PcmCapture | null = null;
  private assembler: CaptureAssembler | null = null;
  private cleanups: Array<() => void> = [];
  private lastPlaying = false;
  private lastProgressMs = 0;
  private hooks: TabCaptureHooks | null = null;
  private ended = false;

  constructor(
    private readonly engine: CaptureEngine,
    private readonly embed: CaptureEmbed,
    private readonly sourceOf: TabAudioSource,
  ) {}

  /**
   * Asks for the share. Resolves true when it carries sound, false when it
   * does not (the stream is then released); rejects when the singer
   * dismisses the dialog or the browser refuses.
   */
  async request(): Promise<boolean> {
    const stream = await this.sourceOf();
    if (stream.getAudioTracks().length === 0) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    this.stream = stream;
    // Chrome's "Stop sharing" bar ends the tracks, after which they feed
    // zeros that would count as heard.
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => this.shareEnded());
    }
    return true;
  }

  /**
   * Starts the video from the top and records it. Needs a successful
   * request(), and a video whose length is known.
   */
  async start(hooks: TabCaptureHooks): Promise<void> {
    const { stream, embed } = this;
    if (!stream) throw new Error('TabCapture.start() needs request() first.');
    if (!(embed.durationS > 0)) throw new Error("The video's length is not known yet.");
    const { context } = this.engine;
    this.hooks = hooks;
    if (this.ended) {
      hooks.onFailed(SHARE_ENDED_MESSAGE);
      return;
    }
    this.assembler = new CaptureAssembler(context.sampleRate, embed.durationS);
    const pcm = new PcmCapture(this.engine as AudioEngine);
    await pcm.load();
    const source = context.createMediaStreamSource(stream);
    this.source = source;
    this.pcm = pcm;
    this.cleanups.push(
      pcm.onChunk((t, samples) => this.place(t, samples, hooks)),
      // A jump is not a continuation, whatever the next block's time says.
      embed.on('seek', () => this.assembler?.breakRun()),
      embed.on('ended', () => hooks.onEnded()),
    );
    pcm.start(source);
    embed.seek(0);
    embed.play();
  }

  /** Ends the recording and returns the video's audio as a WAV. */
  async finish(): Promise<CaptureResult> {
    const { assembler } = this;
    if (!assembler) throw new Error('TabCapture.finish() while not capturing.');
    await this.pcm?.stop().catch(() => undefined);
    this.release();
    this.embed.pause();
    if (peakOf(assembler.pcm) < SILENT_PEAK) throw new Error(SILENT_MESSAGE);
    return {
      wav: encodeWavBlob(assembler.pcm, assembler.sampleRate, 16),
      coverage: assembler.coverage,
      largestGapS: assembler.largestGapS,
      durationS: assembler.durationS,
    };
  }

  /** Ends the recording and drops it. Safe at any point, and to repeat. */
  async cancel(): Promise<void> {
    await this.pcm?.stop().catch(() => undefined);
    this.release();
    this.assembler = null;
  }

  private shareEnded(): void {
    this.ended = true;
    // Before start() there is no recording to fail; start() checks the flag.
    if (this.assembler) this.hooks?.onFailed(SHARE_ENDED_MESSAGE);
  }

  /** Feeds one block from the worklet, timed by the embed clock. */
  place(t: number, samples: Float32Array, hooks: TabCaptureHooks): void {
    const assembler = this.assembler;
    if (!assembler) return;
    const playing = this.embed.state === 'playing';
    // A block that began before the video was playing, or that straddles the
    // moment it stopped, is dropped with the one before it.
    if (playing && this.lastPlaying) {
      // The clock reads the position now; the block began (now - t) ago.
      const startS = this.embed.positionS - (this.engine.now() - t);
      assembler.place(samples, startS);
    }
    this.lastPlaying = playing;
    const nowMs = performance.now();
    if (nowMs - this.lastProgressMs >= PROGRESS_MS) {
      this.lastProgressMs = nowMs;
      hooks.onProgress(assembler.coverage, assembler.largestGapS);
    }
  }

  private release(): void {
    for (const undo of this.cleanups.splice(0)) undo();
    try {
      this.source?.disconnect();
    } catch {
      // Already disconnected, which is the state wanted.
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.source = null;
    this.stream = null;
    this.pcm = null;
  }
}

function peakOf(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = Math.abs(pcm[i]);
    if (value > peak) peak = value;
  }
  return peak;
}
