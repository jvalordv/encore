/**
 * Latency and its calibration: the chirp measurement for the current device
 * pair, the stored latency per pair, the extra embed offset for a YouTube
 * video and the state's copy of the number the frame clock subtracts. The mic
 * itself is the input controller's; calibration borrows it, reopening it raw
 * for the run when echo cancellation would remove the chirp.
 */
import { CalibrationError, describeLatency, latencyKey, measureLatency } from '../../audio/latency';
import type { LatencyResult } from '../../audio/latency';
import { isRunning } from '../../audio/transport';
import { clampEmbedOffsetS, MAX_EMBED_OFFSET_S, MAX_LATENCY_S } from '../settings';
import type { SessionCore } from './core';
import { messageOf } from './helpers';
import type { SessionParts } from './types';

/** Calibrations under this confidence are reported with a warning. */
const LOW_CONFIDENCE = 0.6;

/** Calibrates, and stores latency and the embed offset. */
export class LatencyController {
  constructor(private readonly core: SessionCore) {}

  /**
   * Measures round-trip latency with chirps and stores it for this pair. A
   * playing song is paused for the run, since it would drown the chirps, and
   * picks up where it left off afterwards. A CalibrationError is the room's
   * answer, not a fault, so it shows as a warning with its numbers.
   */
  async calibrate(): Promise<void> {
    const { parts, store, takes, songs } = this.core;
    const state = store.state;
    if (!parts || state.calibrating || state.recording || takes.startingRecord) return;
    if (!(await this.core.input.ensureInput())) return;
    // The song, whether a file or a YouTube video, would drown the chirps; a
    // take playing by itself would too, and is simply stopped.
    if (takes.solo) takes.stopTake();
    const transport = songs.active;
    const resume = transport !== null && isRunning(state.player);
    if (resume) transport.pause();
    store.patch({ calibrating: true });
    store.setStatus('Calibrating: keep quiet and listen for the chirps.');
    try {
      const result = await this.measureOnRawMic(parts);
      if (result) this.reportCalibration(result);
    } catch (error) {
      // A mic that closed meanwhile has put its own reason on the status line.
      if (store.state.input.open) {
        store.setStatus(messageOf(error), error instanceof CalibrationError ? 'warn' : 'error');
      }
    } finally {
      store.patch({ calibrating: false });
      // Only a song still paused where calibration left it is resumed; one the
      // singer replaced or stopped meanwhile is left alone.
      if (resume && transport === songs.active && transport.state === 'paused') transport.play();
    }
  }

  /**
   * Runs the chirp measurement on a raw mic. Echo cancellation exists to
   * remove what this page plays, so in speaker mode it would remove the chirp
   * and every run would read "not heard". The mic is reopened without it for
   * the run and put back in the saved mode afterwards, whatever the outcome.
   * Null when the swap itself failed; openInput has said why.
   */
  private async measureOnRawMic(parts: SessionParts): Promise<LatencyResult | null> {
    const { input } = this.core;
    const { deviceId, requestedAec } = this.core.store.state.input;
    if (requestedAec && (await input.openInput(deviceId, 'headphones', 'none')) !== 'open') return null;
    try {
      return await measureLatency(parts.engine, parts.mic, parts.capture, {
        onProgress: (done, total) => this.core.store.setStatus(`Calibrating… ${done} of ${total}`),
      });
    } finally {
      if (requestedAec) await input.openInput(deviceId, this.core.current.monitor, 'none');
    }
  }

  private reportCalibration(result: LatencyResult): void {
    this.setLatency(result.delayS);
    // A mic that would not reopen has put its own reason on the status line.
    if (!this.core.store.state.input.open) return;
    const text = describeLatency(result);
    if (result.confidence < LOW_CONFIDENCE) {
      this.core.store.setStatus(`${text}. Confidence is low; try again somewhere quieter.`, 'warn');
    } else {
      this.core.store.setStatus(text);
    }
  }

  /** Sets, or with null clears, the latency for the current device pair. */
  setLatency(s: number | null): void {
    const { store, current } = this.core;
    if (store.state.recording) {
      store.setStatus('Stop recording before changing latency.', 'warn');
      this.refreshLatency();
      return;
    }
    if (s !== null && !(Number.isFinite(s) && s >= 0 && s <= MAX_LATENCY_S)) {
      store.setStatus(`Latency must be between 0 and ${MAX_LATENCY_S * 1000} ms.`, 'warn');
      this.refreshLatency();
      return;
    }
    const key = this.pairKey();
    const map = { ...current.latencyByDevicePair };
    if (s === null) delete map[key];
    else map[key] = s;
    current.latencyByDevicePair = map;
    this.core.persist();
    this.refreshLatency();
  }

  /**
   * Sets the extra delay, in seconds, applied on top of the latency while a
   * YouTube video is the song: the video's own audio output is a path
   * calibration cannot play a chirp through. Limited to plus or minus 0.5 s.
   */
  setEmbedOffset(s: number): void {
    const { store, current } = this.core;
    if (store.state.recording) {
      store.setStatus('Stop recording before changing the embed offset.', 'warn');
      store.patch({ embedOffsetS: current.embedOffsetS });
      return;
    }
    if (!Number.isFinite(s)) {
      store.setStatus('The embed offset must be a number of milliseconds.', 'warn');
      store.patch({ embedOffsetS: current.embedOffsetS });
      return;
    }
    const offset = clampEmbedOffsetS(s);
    current.embedOffsetS = offset;
    this.core.persist();
    store.patch({ embedOffsetS: offset });
    if (offset !== s) {
      store.setStatus(`The embed offset is limited to ${MAX_EMBED_OFFSET_S * 1000} ms either way.`, 'warn');
    }
  }

  private pairKey(): string {
    const { input, output } = this.core.store.state;
    return latencyKey(output.deviceId, input.deviceId);
  }

  /** Copies the stored latency for the current device pair into the state. */
  refreshLatency(): void {
    this.core.store.patch({ latencyS: this.core.current.latencyByDevicePair[this.pairKey()] ?? null });
  }

  /** The latency in force, or zero when none is set. */
  latencyOrZero(): number {
    return this.core.store.state.latencyS ?? 0;
  }
}
