/**
 * Capture for learning: the session side. Drives the capture machine
 * (src/app/capture.ts) from the tab recorder (src/audio/tab-capture.ts): asks
 * for the share, records the video as it plays once, and on its end (or the
 * singer's Stop, with most of it heard) uploads the WAV to the service and
 * then runs the ordinary prepared-link flow, which finds the song the service
 * now holds and brings in its melody and key. Opt-in: nothing here runs until
 * `start` is called by a press of the button. The mic is untouched; the
 * capture is the tab's own output.
 */
import { PcmCapture } from '../../audio/capture';
import { tabShareSupported, TabCapture, displayTabSource } from '../../audio/tab-capture';
import type { TabAudioSource } from '../../audio/tab-capture';
import type { YouTubeTransport } from '../../audio/youtube-transport';
import { isAbortError, ServiceClient } from '../../service/client';
import { captureReducer, initialCapture, isCapturing } from '../capture';
import type { CaptureEvent, CapturePhase } from '../capture';
import { describeServiceError } from '../prepare';
import { fakeCaptureSource } from './capture-seam';
import type { SessionCore } from './core';
import { messageOf } from './helpers';

/** Longest wait for the audio context to run before recording starts. */
const CONTEXT_START_WAIT_MS = 2000;

/** One capture in hand: the recorder, and what it belongs to. */
interface Run {
  embed: YouTubeTransport;
  token: number;
  recorder: TabCapture;
  controller: AbortController;
}

/** Runs captures, one at a time, for the video that is the song. */
export class CaptureController {
  private run: Run | null = null;

  constructor(private readonly core: SessionCore) {}

  /** True when a share with sound can be asked for here. */
  get supported(): boolean {
    return this.sourceOf() !== null;
  }

  /** The seam's source if the address asks for one, else the real share. */
  private sourceOf(): TabAudioSource | null {
    const context = this.core.parts?.engine.context;
    if (!context || !PcmCapture.isSupported()) return null;
    const fake = fakeCaptureSource(context as AudioContext);
    if (fake) return fake;
    return tabShareSupported() ? displayTabSource : null;
  }

  private send(event: CaptureEvent): void {
    const { store } = this.core;
    const next = captureReducer(store.state.capture, event);
    if (next !== store.state.capture) store.patch({ capture: next });
  }

  /**
   * Starts a capture of the linked video. Does nothing unless the panel is
   * offering one: a video is the song, the service answered, no capture runs.
   */
  async start(): Promise<void> {
    const { store, songs, parts } = this.core;
    const embed = songs.embed;
    const source = this.sourceOf();
    const { phase } = store.state.prepare;
    if (!embed || !parts || !source || this.run) return;
    if (phase !== 'ready' && phase !== 'failed') return;
    if (store.state.recording) {
      store.setStatus('Stop the recording before capturing the video.', 'warn');
      return;
    }
    const run: Run = {
      embed,
      token: songs.loadToken,
      recorder: new TabCapture(parts.engine, embed, source),
      controller: new AbortController(),
    };
    this.run = run;
    this.send({ type: 'start' });
    try {
      const hasAudio = await run.recorder.request();
      if (!this.isCurrent(run)) {
        void this.abandon(run);
        return;
      }
      this.send({ type: 'stream', hasAudio });
      if (!hasAudio) {
        this.end(run);
        store.setStatus(store.state.capture.message, 'warn');
        return;
      }
      await parts.engine.ensureRunning(CONTEXT_START_WAIT_MS);
      if (!this.isCurrent(run)) {
        void this.abandon(run);
        return;
      }
      await run.recorder.start({
        onProgress: (coverage, largestGapS) => {
          if (this.isCurrent(run)) this.send({ type: 'progress', coverage, largestGapS });
          else void this.abandon(run);
        },
        onEnded: () => void this.finish(run, 'ended'),
        onFailed: (message) => void this.fail(run, message),
      });
      if (!this.isCurrent(run)) void this.abandon(run);
    } catch (error) {
      await this.fail(run, describeShareFailure(error));
    }
  }

  /** Ends the capture early, when most of the video has been heard. */
  async stop(): Promise<void> {
    if (this.run) await this.finish(this.run, 'stop');
  }

  /** Drops a capture under way, as when the video is replaced. */
  cancel(): void {
    const { run } = this;
    if (run) void this.abandon(run);
  }

  private isCurrent(run: Run): boolean {
    return (
      this.run === run &&
      run.token === this.core.songs.loadToken &&
      this.core.songs.embed === run.embed &&
      !run.controller.signal.aborted
    );
  }

  /** Stops a run whose video has gone, and puts the panel back. */
  private async abandon(run: Run): Promise<void> {
    if (this.run !== run) return;
    run.controller.abort();
    await run.recorder.cancel();
    this.end(run);
    this.send({ type: 'reset' });
  }

  private end(run: Run): void {
    if (this.run === run) this.run = null;
  }

  private async fail(run: Run, message: string): Promise<void> {
    if (this.run !== run) return;
    await run.recorder.cancel();
    this.end(run);
    this.send({ type: 'fail', message });
    this.core.store.setStatus(message, 'error');
  }

  /** Hands a finished recording on: upload, then the prepared-link flow. */
  private async finish(run: Run, reason: 'ended' | 'stop'): Promise<void> {
    const { store } = this.core;
    if (!this.isCurrent(run)) {
      void this.abandon(run);
      return;
    }
    if (store.state.capture.phase !== 'capturing') return;
    this.send({ type: 'finish', reason });
    // Read again: the machine may have refused the event or failed on it.
    const phase = this.phaseNow();
    if (phase === 'failed') {
      await run.recorder.cancel();
      this.end(run);
      store.setStatus(store.state.capture.message, 'warn');
      return;
    }
    if (phase !== 'uploading') return;
    try {
      let result;
      try {
        result = await run.recorder.finish();
      } catch (error) {
        await this.fail(run, messageOf(error));
        return;
      }
      const file = new File([result.wav], `${run.embed.videoId}.wav`, { type: 'audio/wav' });
      const client = new ServiceClient({ baseUrl: this.core.current.serviceUrl });
      const stored = await client.uploadCapture(run.embed.videoId, file, {
        title: run.embed.info?.name,
        signal: run.controller.signal,
        onProgress: (fraction) => {
          if (this.isCurrent(run)) this.send({ type: 'upload-progress', fraction });
        },
      });
      if (!this.isCurrent(run)) {
        void this.abandon(run);
        return;
      }
      this.send({ type: 'uploaded' });
      // The song is the service's now; this is the flow a pasted link takes.
      this.end(run);
      await this.core.prepare.prepare();
      const { prepare } = store.state;
      if (prepare.phase === 'prepared') {
        // A capture kept beside a download did not become the song's audio.
        this.send({ type: 'prepared', note: stored.alongside ? stored.message : '' });
      }
      else if (prepare.phase === 'failed') this.send({ type: 'fail', message: prepare.message });
      else this.send({ type: 'reset' });
    } catch (error) {
      if (isAbortError(error)) return;
      await this.fail(run, describeServiceError(error));
    }
  }

  private phaseNow(): CapturePhase {
    return this.core.store.state.capture.phase;
  }

  /** True while the button, Stop or the upload hold the song. */
  get busy(): boolean {
    return isCapturing(this.core.store.state.capture);
  }
}

/** What went wrong with the share, in words the singer can act on. */
function describeShareFailure(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return 'The share was cancelled, so nothing was captured.';
  }
  return `Could not capture the video: ${messageOf(error)}`;
}
