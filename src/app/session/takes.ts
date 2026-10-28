/**
 * Takes: recording from the current position, saving a take with its f0
 * trace, replaying one under the song (or by itself under a YouTube video),
 * and deleting. Owns the recording in progress, the frames collected for it
 * (fed by the frame bus), the replay trace the lane is fed from while a take
 * plays, and the take played by itself. The take store is the one in
 * src/app/takes.ts; the Recorder is an injected part.
 */
import type { PitchFrame } from '../../analysis/pitch';
import type { TakeRecording } from '../../audio/recorder';
import type { ClockKind, TrackInfo } from '../../audio/transport';
import { decodeWav, encodeWavBlob, songTimeOfSample } from '../../audio/wav';
import { formatClock } from '../state';
import type { TakeRecord } from '../takes';
import type { SessionCore } from './core';
import { firstFrameIndex, messageOf, sleep } from './helpers';
import type { SessionParts } from './types';

/** Stem ids; 'original' is the player's own and is never removed. */
const ORIGINAL_STEM = 'original';
const TAKE_STEM = 'take';
/** Level of the song while a take plays over it, so the voice stays clear. */
export const DUCKED_ORIGINAL_GAIN = 0.6;
/** Seconds of song heard before the take's first sample when it is played. */
const TAKE_LEAD_IN_S = 1;
/** Wait after starting the song so its sources are really running. */
const RECORD_LEAD_MS = 60;
/** Seconds of take trace redrawn behind the playhead after a seek. */
const REPLAY_BACK_S = 6;
/** A replay frame this far ahead of the playhead means time ran backwards. */
const REPLAY_SLACK_S = 0.05;
/** Longest wait for a video to start when Record has to press Play for it. */
const EMBED_START_TIMEOUT_MS = 4000;

/** A take being replayed: its f0 trace, fed to the lane as the song plays. */
interface Replay {
  frames: PitchFrame[];
  next: number;
}

/**
 * A take playing by itself, over no song: what replaying a take under a
 * YouTube video does, since the video's sound cannot be mixed with it. The
 * playhead is the take's own, on song time.
 */
export interface SoloTake {
  source: AudioBufferSourceNode;
  /** Context time at which the take's first sample plays. */
  startedAtContextS: number;
  /** Song time of the take's first sample, with its latency shift applied. */
  offsetS: number;
}

/** What a recording in progress needs to remember until it is saved. */
interface Recording {
  song: TrackInfo;
  /** True when Record started the song, so stopping Record pauses it again. */
  startedPlayback: boolean;
  /** The clock the song time came from, kept with the take. */
  clock: ClockKind;
}

/** Records, saves, replays and deletes takes. */
export class TakeController {
  /** True from the Record press until the recorder is running. */
  startingRecord = false;
  /** The take being replayed by itself over a video, or null. */
  solo: SoloTake | null = null;
  private recording: Recording | null = null;
  private takeFrames: PitchFrame[] | null = null;
  private finishing: Promise<void> | null = null;
  private replay: Replay | null = null;

  constructor(private readonly core: SessionCore) {
    // The recorder's half of the frame bus: every frame goes into the take.
    core.bus.subscribe(({ frame }) => {
      this.takeFrames?.push({ t: frame.t, f0: frame.f0, clarity: frame.clarity, rms: frame.rms });
    });
  }

  /**
   * Starts recording from the current position, playing the song if needed, or
   * stops and saves the take in progress.
   */
  async toggleRecord(): Promise<void> {
    if (this.core.store.state.recording) {
      const started = this.recording?.startedPlayback ?? false;
      const done = this.finishRecording();
      if (started) this.core.songs.active?.pause();
      await done;
      return;
    }
    await this.startRecording();
  }

  /**
   * Plays a saved take under the song, aligned as it was sung. Under a
   * YouTube video the take plays by itself instead, because the video's sound
   * cannot be mixed with it, and the status line says so.
   */
  async playTake(id: string): Promise<void> {
    const { parts, store, songs } = this.core;
    const state = store.state;
    if (!parts || !songs.active || state.recording || state.calibrating) return;
    try {
      const take = await (await this.core.takesReady).get(id);
      if (!take) {
        store.setStatus('That take is gone.', 'warn');
        await this.refreshTakes();
        return;
      }
      if (take.songHash !== state.song?.hash) {
        store.setStatus('That take belongs to another song.', 'warn');
        return;
      }
      const wav = decodeWav(await take.wav.arrayBuffer());
      const buffer = parts.engine.context.createBuffer(1, wav.pcm.length, wav.sampleRate);
      buffer.getChannelData(0).set(wav.pcm);
      // The sung audio trails the song by the latency it was recorded with, so
      // it is placed that much earlier to sound the way it was meant to.
      const offsetS = songTimeOfSample(0, wav.sampleRate, take.startedAtSongS ?? 0, take.latencyS);
      if (songs.active?.clock === 'embed') {
        this.playTakeAlone(parts, id, take, buffer, offsetS);
        return;
      }
      parts.player.addStem(TAKE_STEM, buffer, offsetS);
      parts.player.setStemGain(TAKE_STEM, 1);
      parts.player.setStemGain(ORIGINAL_STEM, DUCKED_ORIGINAL_GAIN);
      this.replay = { frames: take.frames, next: 0 };
      store.patch({ playingTakeId: id });
      // The seek event restarts the trace from just behind the playhead.
      parts.player.seek(Math.max(0, offsetS - TAKE_LEAD_IN_S));
      parts.player.play();
      store.setStatus(`Playing take from ${formatClock(take.startedAtSongS ?? 0)}.`);
    } catch (error) {
      store.setStatus(`Could not play the take: ${messageOf(error)}`, 'error');
    }
  }

  /**
   * Plays the take by itself, because the song is a YouTube video whose sound
   * cannot be mixed with it. The video is paused so it does not talk over the
   * take, and the lane follows the take's own playhead.
   */
  private playTakeAlone(
    parts: SessionParts,
    id: string,
    take: TakeRecord,
    buffer: AudioBuffer,
    offsetS: number,
  ): void {
    const { engine } = parts;
    this.endReplay();
    this.core.songs.active?.pause();
    void engine.resume().catch(() => {});
    const source = engine.context.createBufferSource();
    source.buffer = buffer;
    source.connect(engine.master);
    source.onended = () => {
      if (this.solo?.source === source) this.stopTake();
    };
    const startedAtContextS = engine.now();
    source.start();
    this.solo = { source, startedAtContextS, offsetS };
    this.replay = { frames: take.frames, next: firstFrameIndex(take.frames, offsetS - REPLAY_BACK_S) };
    this.core.lane?.clearFrames();
    this.core.store.patch({ playingTakeId: id });
    this.core.store.setStatus(
      `Playing the take by itself from ${formatClock(take.startedAtSongS ?? 0)}: ` +
        'replay over a YouTube video is not synced yet.',
    );
  }

  /** Stops the take, restores the song's level and pauses. */
  stopTake(): void {
    if (!this.core.parts || this.core.store.state.playingTakeId === null) return;
    this.endReplay();
    this.core.lane?.clearFrames();
    this.core.songs.active?.pause();
  }

  /** Deletes a take from storage. */
  async deleteTake(id: string): Promise<void> {
    const { store } = this.core;
    if (store.state.playingTakeId === id) this.stopTake();
    try {
      await (await this.core.takesReady).remove(id);
      await this.refreshTakes();
      store.setStatus('Take deleted.');
    } catch (error) {
      store.setStatus(`Could not delete the take: ${messageOf(error)}`, 'error');
    }
  }

  /** Stops whatever take is replaying, on the song or by itself. */
  endReplay(): void {
    const wasSolo = this.solo !== null;
    this.stopSolo();
    const player = this.core.parts?.player;
    if (player && !wasSolo && this.core.store.state.playingTakeId !== null) {
      player.removeStem(TAKE_STEM);
      player.setStemGain(ORIGINAL_STEM, 1);
    }
    this.replay = null;
    this.core.store.patch({ playingTakeId: null });
  }

  /** Silences the take that plays by itself, if there is one. */
  stopSolo(): void {
    const solo = this.solo;
    if (!solo) return;
    this.solo = null;
    solo.source.onended = null;
    try {
      solo.source.stop();
    } catch {
      // Already stopped; either way it is silent.
    }
    solo.source.disconnect();
  }

  private async startRecording(): Promise<void> {
    const { parts, store, songs } = this.core;
    const transport = songs.active;
    const state = store.state;
    if (!parts || !transport || this.startingRecord || state.calibrating) return;
    const song = transport.info;
    if (!song) {
      store.setStatus('Load a song before recording.', 'warn');
      return;
    }
    if (transport.loop) {
      // Looped passes would break the one-anchor timing a take relies on.
      store.setStatus('Clear the loop (L) to record; looped passes cannot be recorded yet.', 'warn');
      return;
    }
    // A take still replaying would sit under the new one in the headphones and
    // keep the lane showing its trace instead of the live pitch.
    if (state.playingTakeId !== null) this.stopTake();
    this.startingRecord = true;
    try {
      if (!(await this.core.input.ensureInput())) return;
      if (store.state.tracker !== 'running') {
        store.setStatus('Recording needs AudioWorklet, which is unavailable here.', 'error');
        return;
      }
      const embed = transport.clock === 'embed';
      const startedPlayback = transport.state !== 'playing';
      if (startedPlayback) {
        if (embed) void parts.engine.resume().catch(() => {});
        transport.play();
        // The audio player starts its sources a few milliseconds ahead and the
        // embed needs a moment to buffer; wait for them so the position is the
        // true song time the recorder will anchor to.
        const started = await songs.waitForPlaying(transport, embed ? EMBED_START_TIMEOUT_MS : 0);
        if (!started && embed) {
          store.setStatus(
            transport.state === 'ad'
              ? 'An ad is playing in the video. Press Record again when it ends.'
              : 'The video did not start, so recording was not started. Press Play on the video, then Record.',
            'warn',
          );
        }
        await sleep(RECORD_LEAD_MS);
      }
      if (transport !== songs.active || transport.state !== 'playing') return;
      await parts.recorder.start(
        transport.positionS,
        this.core.latency.latencyOrZero() + songs.embedOffsetNow(),
      );
      this.recording = { song, startedPlayback, clock: transport.clock };
      this.takeFrames = [];
      store.patch({ recording: true });
      const approximate = embed ? ' Timing over a YouTube video is approximate.' : '';
      if (store.state.latencyS === null) {
        store.setStatus(
          `Recording. Latency is not calibrated, so timing will read late.${approximate}`,
          'warn',
        );
      } else {
        store.setStatus(`Recording. Press R to stop.${approximate}`);
      }
      // A pause during the worklet load came before `recording` was true.
      if (transport.state !== 'playing') void this.finishRecording();
    } catch (error) {
      store.setStatus(`Could not start recording: ${messageOf(error)}`, 'error');
    } finally {
      this.startingRecord = false;
      this.core.prepare.kickSwitch();
    }
  }

  /** Stops the recorder and saves the take; concurrent calls share one run. */
  finishRecording(): Promise<void> {
    if (this.finishing) return this.finishing;
    const { parts, store } = this.core;
    const meta = this.recording;
    if (!parts || !meta || !store.state.recording) return Promise.resolve();
    const frames = this.takeFrames ?? [];
    this.takeFrames = null;
    store.setStatus('Saving take…');
    this.finishing = (async () => {
      try {
        await this.saveTake(await parts.recorder.stop(), frames, meta.song, meta.clock);
      } catch (error) {
        store.setStatus(`Could not save the take: ${messageOf(error)}`, 'error');
      } finally {
        this.recording = null;
        this.finishing = null;
        store.patch({ recording: false });
        this.core.prepare.kickSwitch();
      }
    })();
    return this.finishing;
  }

  private async saveTake(
    rec: TakeRecording,
    frames: PitchFrame[],
    song: TrackInfo,
    clock: ClockKind,
  ): Promise<void> {
    if (rec.pcm.length === 0) {
      this.core.store.setStatus('Nothing was recorded.', 'warn');
      return;
    }
    const takes = await this.core.takesReady;
    await takes.save({
      songHash: song.hash,
      songName: song.name,
      createdAt: Date.now(),
      durationS: rec.durationS,
      // For an embed take this includes the embed offset in force, so the WAV
      // and the frames below were shifted by the same amount.
      latencyS: rec.latencyS,
      sampleRate: rec.sampleRate,
      startedAtSongS: rec.startedAtSongS,
      clock,
      // Frames are on song time with the latency already taken off.
      frames,
      wav: encodeWavBlob(rec.pcm, rec.sampleRate, 16),
    });
    await this.refreshTakes();
    this.core.store.setStatus(`Take saved (${rec.durationS.toFixed(1)} s).`);
  }

  /** Reads the saved takes of the loaded song into the state. */
  async refreshTakes(): Promise<void> {
    const song = this.core.songs.active?.info;
    try {
      const list = song ? await (await this.core.takesReady).list(song.hash) : [];
      this.core.store.patch({ takes: list });
    } catch (error) {
      this.core.store.setStatus(`Could not read saved takes: ${messageOf(error)}`, 'warn');
    }
  }

  /** Restarts the take trace from a few seconds behind the playhead. */
  resyncReplay(): void {
    const replay = this.replay;
    if (!replay) return;
    this.core.lane?.clearFrames();
    replay.next = firstFrameIndex(replay.frames, this.core.songs.currentPosition() - REPLAY_BACK_S);
  }

  /** Feeds the lane every take frame the playhead has now reached. */
  feedReplay(position: number): void {
    const replay = this.replay;
    const lane = this.core.lane;
    if (!replay || !lane) return;
    const { frames } = replay;
    // Time ran backwards (a loop wrapped): start the trace over.
    if (replay.next > 0 && frames[replay.next - 1].t > position + REPLAY_SLACK_S) {
      this.resyncReplay();
    }
    while (replay.next < frames.length && frames[replay.next].t <= position) {
      const f = frames[replay.next++];
      lane.pushFrame({ t: f.t, f0: f.f0, clarity: f.clarity });
    }
  }
}
