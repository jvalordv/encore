/**
 * Playback intents over the active transport: play, pause, stop, seek, nudge
 * and the loop A/B controls. Each is a thin guard (no song, calibration or a
 * take in the way) before the call to the transport, which is why they sit
 * apart from the loading code that owns which transport is active.
 */
import { normaliseLoop } from '../../audio/player';
import { isRunning } from '../../audio/transport';
import type { LoopRegion } from '../../audio/transport';
import { formatClock } from '../state';
import type { SessionCore } from './core';
import { loopWithPoint } from './helpers';

/** Plays, pauses, seeks and loops whichever transport is active. */
export class PlaybackController {
  constructor(private readonly core: SessionCore) {}

  /** Plays, resuming the saved mic first if none is open. */
  play(): void {
    const { parts, store, takes } = this.core;
    const transport = this.core.songs.active;
    if (!parts || !transport) return;
    if (transport.state === 'empty') {
      store.setStatus('Drop an audio file on the page or paste a YouTube link to start.');
      return;
    }
    // The song would drown the chirps; the Play button is already disabled,
    // and this keeps the Space key from starting it anyway.
    if (store.state.calibrating) return;
    // A take playing by itself yields to the song.
    if (takes.solo) takes.stopTake();
    // The audio player starts the context itself; the embed does not touch it,
    // and live pitch needs it running.
    if (transport.clock === 'embed') void parts.engine.resume().catch(() => {});
    transport.play();
    this.core.input.reopenSavedInput();
  }

  /** Pauses at the current position. */
  pause(): void {
    this.core.songs.active?.pause();
  }

  /** Play when paused, pause when playing (or buffering, or in an ad). */
  togglePlay(): void {
    if (isRunning(this.core.store.state.player)) this.pause();
    else this.play();
  }

  /** Stops, ending any recording, and returns to the start. */
  stop(): void {
    const { store, takes } = this.core;
    if (store.state.recording) void takes.finishRecording();
    if (takes.solo) takes.stopTake();
    this.core.songs.active?.stop();
  }

  /** Moves the playhead to `s` seconds; this ends a recording in progress. */
  seek(s: number): void {
    if (!this.core.songs.hasSong()) return;
    if (this.core.takes.solo) this.core.takes.stopTake();
    this.core.songs.active?.seek(s);
  }

  /** Moves the playhead by `ds` seconds, negative for back. */
  nudge(ds: number): void {
    const transport = this.core.songs.active;
    if (!transport || !this.core.songs.hasSong()) return;
    if (this.core.takes.solo) this.core.takes.stopTake();
    transport.seek(transport.positionS + ds);
  }

  /**
   * Sets a loop from `a` to `b` seconds when both are given. With neither, it
   * clears the loop if there is one, else loops a short stretch from here.
   */
  toggleLoop(a?: number, b?: number): void {
    const transport = this.core.songs.active;
    if (!transport || !this.core.songs.hasSong() || !this.canEditLoop()) return;
    if (a !== undefined && b !== undefined) {
      this.applyLoop(normaliseLoop({ startS: a, endS: b }, this.core.store.state.durationS));
    } else if (transport.loop) {
      transport.setLoop(null);
      this.core.store.setStatus('Loop off.');
    } else {
      this.setLoopPoint('a');
    }
  }

  /** Marks the loop's start (A) or end (B) at the current position. */
  setLoopPoint(which: 'a' | 'b'): void {
    const transport = this.core.songs.active;
    if (!transport || !this.core.songs.hasSong() || !this.canEditLoop()) return;
    const { durationS } = this.core.store.state;
    const region = loopWithPoint(which, transport.positionS, transport.loop, durationS);
    if (!this.applyLoop(region)) return;
    // B is pressed at the playhead, so the loop ends where the song already
    // is. A run that starts past a loop's end plays on, so without this jump
    // the loop would never engage and the passage could not be repeated.
    const loop = transport.loop;
    if (which === 'b' && loop && transport.positionS >= loop.endS) transport.seek(loop.startS);
  }

  private canEditLoop(): boolean {
    if (!this.core.store.state.recording) return true;
    this.core.store.setStatus('Stop recording before changing the loop.', 'warn');
    return false;
  }

  /** Applies a loop and says so; false when it was refused as too short. */
  private applyLoop(region: LoopRegion | null): boolean {
    const transport = this.core.songs.active;
    if (!transport) return false;
    if (!region) {
      this.core.store.setStatus('That loop is too short; move the other end further away.', 'warn');
      return false;
    }
    transport.setLoop(region);
    if (!transport.loop) {
      // A video's length can still be unknown just after it loads.
      this.core.store.setStatus('The loop could not be set yet; the length of the song is not known.', 'warn');
      return false;
    }
    this.core.store.setStatus(`Loop ${formatClock(region.startS)} to ${formatClock(region.endS)}.`);
    return true;
  }
}
