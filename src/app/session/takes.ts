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
import type { ClockKind, TrackInfo, Transport } from '../../audio/transport';
import { decodeWav, encodeWavBlob, songTimeOfSample } from '../../audio/wav';
import { framesFor } from '../../duet/split';
import type { DuetCapture } from '../../duet/take';
import { formatClock } from '../state';
import { captureMicSettings, takeExportJson, takeFileName } from '../take-export';
import type { TakeFileKind } from '../take-export';
import { captureEnvironment, keyForSpan, sliceReference, TakeTraceRecorder, toTakeFrame } from '../take-trace';
import type { TakeEnvironment, TakeFrame, TakeTrace, TraceSection } from '../take-trace';
import type { TakeMicSettings, TakeRecord } from '../takes';
import type { SessionCore } from './core';
import { firstFrameIndex, messageOf, sleep } from './helpers';
import type { SessionParts } from './types';

/** The id of the take's stem in the Player. */
const TAKE_STEM = 'take';
/**
 * Level of the song's mix while a take plays over it, so the voice stays
 * clear (the mix controller applies it to whichever stems are sounding).
 */
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
  /** The mic and mix settings as the take began. */
  mic: TakeMicSettings;
  /** The browser, audio and analysis settings as the take began. */
  environment: TakeEnvironment;
  /** The Mic check's labelled stretches; absent on a take over a song. */
  sections?: TraceSection[];
}

/** Records, saves, replays and deletes takes. */
export class TakeController {
  /** True from the Record press until the recorder is running. */
  startingRecord = false;
  /** The take being replayed by itself over a video, or null. */
  solo: SoloTake | null = null;
  /** The id of the take saved last, for the Mic check's result card. */
  lastSavedId: string | null = null;
  private recording: Recording | null = null;
  private takeFrames: TakeFrame[] | null = null;
  private finishing: Promise<void> | null = null;
  private replay: Replay | null = null;
  private readonly trace = new TakeTraceRecorder(() => performance.now());

  constructor(private readonly core: SessionCore) {
    // The recorder's half of the frame bus: every frame goes into the take,
    // with the raw reading and the gate's verdict beside the scored fields.
    core.bus.subscribe(({ singer, frame, rawF0, gateReason }) => {
      // Singer B's frames are kept by the duet controller, for B's own report.
      if (!this.takeFrames || singer !== 0) return;
      this.takeFrames.push(toTakeFrame(frame, rawF0, gateReason));
      this.trace.sampleHealth(frame.t, core.store.state);
    });
    // The event log is the state's changes while a take is being recorded.
    core.store.subscribe((state, changed) => {
      if (this.takeFrames) this.trace.onState(state, changed);
    });
  }

  /**
   * Starts recording from the current position, playing the song if needed, or
   * stops and saves the take in progress.
   */
  async toggleRecord(): Promise<void> {
    if (this.core.micCheck.active) {
      this.core.store.setStatus('The Mic check is running. Press Cancel in its panel to stop it.', 'warn');
      return;
    }
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
   * cannot be mixed with it, and the status line says so. `fromS`, a song
   * time, starts the replay a lead-in before that moment instead of at the
   * take's beginning (the report card's Replay).
   */
  async playTake(id: string, fromS?: number): Promise<void> {
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
      // Where the replay begins on song time: a lead-in before the moment asked
      // for, never before the take's own first sample.
      const startS = Math.max(offsetS, (fromS ?? offsetS) - TAKE_LEAD_IN_S);
      if (songs.active?.clock === 'embed') {
        this.playTakeAlone(parts, id, take, buffer, offsetS, startS);
        return;
      }
      // The lane and the song play in the key the take was sung in, and the
      // shifter delays the song, so the voice is placed that much later.
      await this.core.keys.lend(take.shiftSemitones ?? 0);
      // A take is the singer's own pitch; the key shift does not move it.
      parts.player.addStem(TAKE_STEM, buffer, offsetS + parts.player.shiftDelayS, undefined, false);
      parts.player.setStemGain(TAKE_STEM, 1);
      // Whatever the mix, the song gives way to the take.
      this.core.mix.setDucked(true);
      this.replay = { frames: take.frames, next: 0 };
      store.patch({ playingTakeId: id });
      // The seek event restarts the trace from just behind the playhead.
      parts.player.seek(Math.max(0, fromS === undefined ? offsetS - TAKE_LEAD_IN_S : startS));
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
    startS: number,
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
    // Starting inside the buffer: the playhead reads as if the take had begun
    // that much earlier, so it lands on song time `startS`.
    const intoTakeS = Math.max(0, startS - offsetS);
    const startedAtContextS = engine.now() - intoTakeS;
    source.start(0, intoTakeS);
    this.solo = { source, startedAtContextS, offsetS };
    this.replay = { frames: take.frames, next: firstFrameIndex(take.frames, startS - REPLAY_BACK_S) };
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
      this.core.mix.setDucked(false);
    }
    this.replay = null;
    this.core.keys.release();
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
      await this.arm(transport, song, startedPlayback);
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

  /**
   * Starts the recorder at the transport's position and begins the take's
   * records: mic and mix settings, environment, event log. `sections` marks
   * the take as a Mic check.
   */
  private async arm(
    transport: Transport,
    song: TrackInfo,
    startedPlayback: boolean,
    sections?: TraceSection[],
  ): Promise<void> {
    const { parts, store, songs } = this.core;
    if (!parts) return;
    await parts.recorder.start(transport.positionS, this.core.latency.latencyOrZero() + songs.embedOffsetNow());
    const tuning = this.core.health.tuning();
    const mic = captureMicSettings(store.state, tuning.clarityThreshold, this.core.health.floorDb);
    const environment = captureEnvironment(
      {
        trackSettings: parts.mic.settings,
        context: parts.engine.context,
        clarityThreshold: tuning.clarityThreshold,
        octaveInvariant: this.core.current.octaveInvariant,
        tuning,
      },
      store.state,
    );
    this.recording = { song, startedPlayback, clock: transport.clock, mic, environment, sections };
    this.takeFrames = [];
    // The Mic check measures singer A's mic alone; a song take may be a duet.
    if (!sections) this.core.duet.beginTake();
    this.trace.start(store.state);
    store.patch({ recording: true });
  }

  /**
   * Begins the Mic check's take on the song in the player (its test track,
   * already playing). False, with the reason on the status line, when it
   * could not start.
   */
  async beginMicCheckTake(sections: TraceSection[]): Promise<boolean> {
    const { parts, store, songs } = this.core;
    const transport = songs.active;
    const song = transport?.info;
    if (!parts || !transport || !song || this.startingRecord || store.state.recording) return false;
    this.startingRecord = true;
    try {
      if (store.state.tracker !== 'running') {
        store.setStatus('The Mic check needs AudioWorklet, which is unavailable here.', 'error');
        return false;
      }
      await this.arm(transport, song, false, sections);
      return true;
    } catch (error) {
      store.setStatus(`Could not start the Mic check: ${messageOf(error)}`, 'error');
      return false;
    } finally {
      this.startingRecord = false;
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
    const duet = this.core.duet.endTake();
    // Copied now: the log stops here, but the next take reuses the recorder.
    const tracks = { events: [...this.trace.events], health: [...this.trace.health] };
    store.setStatus('Saving take…');
    this.finishing = (async () => {
      try {
        await this.saveTake(await parts.recorder.stop(), frames, meta, tracks, duet);
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

  /** The analysis track: the logs, the environment, melody, key, calibration. */
  private buildTrace(rec: TakeRecording, meta: Recording, tracks: Pick<TakeTrace, 'events' | 'health'>): TakeTrace {
    const fromS = rec.startedAtSongS;
    const toS = fromS + rec.durationS;
    const trace: TakeTrace = { ...tracks, environment: meta.environment };
    const reference = sliceReference(this.core.stems.contour(), fromS, toS);
    if (reference) trace.reference = reference;
    // The previous song's key says nothing about the test track.
    const key = meta.sections ? undefined : keyForSpan(this.core.scoring.keyMap(), fromS, toS);
    if (key) trace.key = key;
    if (meta.sections) trace.sections = meta.sections.map((section) => ({ ...section }));
    const calibration = this.core.latency.lastCalibration;
    if (calibration && calibration.delayS === this.core.store.state.latencyS) trace.calibration = calibration;
    return trace;
  }

  private async saveTake(
    rec: TakeRecording,
    frames: TakeFrame[],
    meta: Recording,
    tracks: Pick<TakeTrace, 'events' | 'health'>,
    duetCapture: DuetCapture | null,
  ): Promise<void> {
    const { song, clock, mic } = meta;
    if (rec.pcm.length === 0) {
      this.core.store.setStatus('Nothing was recorded.', 'warn');
      return;
    }
    const takes = await this.core.takesReady;
    // Learning mode's measurements; none in karaoke mode or without a melody.
    // A duet take has a report per singer: A's is the take's own, B's rides in `duet`.
    const both = duetCapture ? this.core.scoring.duetReportsFor(duetCapture, frames) : null;
    const report = both ? both.report : this.core.scoring.reportFor(frames);
    const trace = this.buildTrace(rec, meta, tracks);
    const id = await takes.save({
      trace,
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
      mic,
      ...(meta.sections ? { kind: 'mic-check' as const } : {}),
      ...(this.core.keys.shift !== 0 && !meta.sections ? { shiftSemitones: this.core.keys.shift } : {}),
      // On one mic shared by two, only A's turns count toward A's streak.
      voicedFrames: (duetCapture?.mode === 'one-mic' ? framesFor(frames, duetCapture.turns, 0) : frames).filter(
        (f) => f.f0 > 0 && Number.isFinite(f.f0),
      ).length,
      // Frames are on song time with the latency already taken off.
      frames,
      wav: encodeWavBlob(rec.pcm, rec.sampleRate, 16),
      ...(report ? { report } : {}),
      ...(both && duetCapture ? { duet: both.duet, ...(duetCapture.framesB.length ? { duetFramesB: duetCapture.framesB } : {}) } : {}),
    });
    this.lastSavedId = id;
    await this.refreshTakes();
    if (report) this.core.scoring.showReport(id);
    this.core.store.setStatus(`Take saved (${rec.durationS.toFixed(1)} s).`);
  }

  /**
   * A take as a file to download: its WAV, or a JSON of its frames and mic
   * settings. Null, with the reason on the status line, when it cannot be read.
   */
  async exportFile(id: string, kind: TakeFileKind): Promise<{ blob: Blob; name: string } | null> {
    const { store } = this.core;
    try {
      const take = await (await this.core.takesReady).get(id);
      if (!take) {
        store.setStatus('That take is gone.', 'warn');
        await this.refreshTakes();
        return null;
      }
      const name = takeFileName(take.songName, take.createdAt, kind);
      if (kind === 'wav') return { blob: take.wav, name };
      const text = JSON.stringify(takeExportJson(take));
      return { blob: new Blob([text], { type: 'application/json' }), name };
    } catch (error) {
      store.setStatus(`Could not save the take: ${messageOf(error)}`, 'error');
      return null;
    }
  }

  /** Reads the saved takes of the loaded song into the state. */
  async refreshTakes(): Promise<void> {
    const song = this.core.songs.active?.info;
    try {
      const list = song ? await (await this.core.takesReady).list(song.hash) : [];
      this.core.store.patch({ takes: list });
      void this.core.keys.refreshRange();
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
