/**
 * The Session owns every long-lived object of the practice loop (audio
 * engine, player, mic, tracker, recorder, take store, settings) and the
 * StateStore the UI reads. The UI never touches those objects; it calls the
 * intents here (loadSong, loadLink, play, chooseInput, calibrate,
 * toggleRecord, ...) and renders the state they leave behind. That is also
 * what makes the shell portable: a native window only has to call the same
 * intents (see "Built to become an app" in docs/ARCHITECTURE.md).
 *
 * This file is the facade. The work is done by controllers in
 * src/app/session/, one per concern, sharing a SessionCore that holds the
 * store, the parts and the settings: songs and transports (songs.ts),
 * playback and loop (playback.ts), the service and prepared audio
 * (prepare.ts), the karaoke track from the service (stems.ts) and the mix of
 * its stems (mix.ts), the song search (search.ts), the mic (input.ts), devices
 * and output (devices.ts), latency and calibration (latency.ts), takes
 * (takes.ts) and learning mode (scoring.ts: the practice mode, the live grade
 * of each frame and the report a take gets). Tracker frames reach the take
 * recorder and, graded in learning mode, the lane through a frame bus
 * (frame-bus.ts).
 *
 * The song comes from one of two transports (src/audio/transport.ts): the
 * audio Player for a dropped file, or a YouTubeTransport for a pasted link.
 * Exactly one is active, and everything that needs the song's position or
 * state (the lane, recording, loop A/B, the seek bar, the clock readout)
 * reads the active one; loading a file or a link swaps it once it is ready,
 * and a load that fails leaves the song in use as it was.
 *
 * A linked song has a second mode. When the person asks (or turns on the
 * automatic setting), the link is sent to the service, which fetches the
 * video's audio; the Session loads it into the audio Player, under the same
 * `yt-<id>` key the video's takes use, and makes the Player the active
 * transport. The embed stays on the page as a muted picture that an
 * EmbedFollower keeps in step (src/audio/embed-follower.ts). From then on the
 * song runs on the engine clock with the calibrated latency and no embed
 * offset, and takes recorded on it say so. Nothing is sent to the service for
 * a link without that request, and a newer load always wins over a preparation
 * still under way (the load token), as it does over a slower link.
 *
 * Browsers want a user gesture before they start audio or open a mic, so each
 * intent that needs one does it itself and is meant to be called straight from
 * a click or key handler. Song time is the master clock: tracker frames arrive
 * stamped with context time and are moved onto song time, minus the calibrated
 * round-trip latency (and, for a YouTube video, the embed offset), before they
 * reach the lane or a take. The maths for that is in the pure exports of
 * session/helpers.ts (frameToSongTime and friends), tested without any audio
 * and re-exported here. Importing this file touches no browser API.
 */
import type { MonitorMode } from '../audio/mic';
import type { Transport } from '../audio/transport';
import type { EmbedHost } from '../audio/youtube-transport';
import type { SearchFilter, SearchResult } from '../search';
import type { MixChoice } from './mix';
import { SessionCore } from './session/core';
import { buildParts } from './session/parts';
import type { DeviceLists, LaneSink, SessionOptions, SessionParts } from './session/types';
import { loadSettings } from './settings';
import type { PracticeMode, Settings } from './settings';
import { StateStore } from './state';
import { localStorageStore } from './storage';
import { memoryTakeStore, openTakeStore } from './takes';

export {
  DEFAULT_LOOP_S,
  FRAME_JITTER_S,
  firstFrameIndex,
  frameToSongTime,
  loopWithPoint,
  orderedFrameTime,
} from './session/helpers';
export { DUCKED_ORIGINAL_GAIN } from './session/takes';
export type { DeviceLists, LaneSink, SessionOptions, SessionParts } from './session/types';

/** Owns the practice loop's objects and turns UI intents into state. */
export class Session {
  /** The state the UI renders; subscribe to it for changes. */
  readonly store: StateStore;
  /** The audio objects, or null when this browser has no Web Audio. */
  readonly parts: SessionParts | null;

  private readonly core: SessionCore;
  private started = false;

  constructor(options: SessionOptions = {}) {
    this.store = options.store ?? new StateStore();
    const settingsStore = options.settings ?? localStorageStore();
    const settings = loadSettings(settingsStore);
    const takes = Promise.resolve(options.takes ?? openTakeStore()).catch(() => memoryTakeStore());
    this.parts = buildParts(this.store, settings.clarityThreshold);
    this.core = new SessionCore({
      store: this.store,
      settingsStore,
      settings,
      parts: this.parts,
      takes,
      youtubeApi: options.youtubeApi,
      search: options.search,
    });
  }

  /** The settings as saved; changing the returned object changes nothing. */
  get settings(): Readonly<Settings> {
    return this.core.current;
  }

  /** The devices seen by the last refreshDevices(). */
  get deviceLists(): DeviceLists {
    return this.core.devices.deviceLists;
  }

  /** The active transport (audio player or YouTube); null without Web Audio. */
  get transport(): Transport | null {
    return this.core.songs.active;
  }

  /**
   * The take playing by itself under a video, or null; the end-to-end run
   * reads it to tell a take that gave way from one still playing.
   */
  get solo(): unknown {
    return this.core.takes.solo;
  }

  /** Hands the Session the lane it should scroll and feed. */
  attachLane(lane: LaneSink): void {
    this.core.lane = lane;
    lane.setTime(this.core.songs.currentPosition());
    this.core.stems.syncLane();
  }

  /**
   * Hands the Session the pane the YouTube player is built into. Without one a
   * pasted link is refused; null takes it away again.
   */
  attachEmbedHost(host: EmbedHost | null): void {
    this.core.songs.attachEmbedHost(host);
  }

  /**
   * Begins the per-frame loop that moves the lane and writes position, level
   * and tracker health, starts watching for devices coming and going, and
   * restores the saved output device. Safe to call twice.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.core.devices.start();
    this.core.loop.start();
  }

  /** Stops the loop, the device watch, the YouTube player and the mic. */
  dispose(): void {
    this.started = false;
    this.core.loop.stop();
    this.core.devices.stop();
    this.core.takes.stopSolo();
    this.core.stems.reset();
    this.core.search.dispose();
    this.core.songs.dispose();
    this.core.input.dispose();
  }

  /** Subscribes to device list changes; returns the unsubscribe function. */
  onDevices(cb: (devices: DeviceLists) => void): () => void {
    return this.core.devices.onDevices(cb);
  }

  /** Re-reads the input and output devices and tells the listeners. */
  refreshDevices(): Promise<DeviceLists> {
    return this.core.devices.refreshDevices();
  }

  // ---- Song and transport -------------------------------------------------

  /** Decodes and loads a dropped or picked audio file. */
  loadSong(file: File): Promise<void> {
    return this.core.songs.loadSong(file);
  }

  /** Loads a pasted YouTube link into the embedded player as the song. */
  loadLink(text: string): Promise<void> {
    return this.core.songs.loadLink(text);
  }

  /** Has the service fetch the linked song's audio and switches to it. */
  prepare(): Promise<void> {
    return this.core.prepare.prepare();
  }

  /** Asks the service again whether it runs, if it was found not to. */
  checkService(): void {
    this.core.prepare.checkService();
    this.core.stems.checkService();
  }

  /** Turns the automatic sending of a link to the service on or off. */
  setAutoPrepareLinks(on: boolean): void {
    this.core.prepare.setAutoPrepareLinks(on);
  }

  /** Chooses the original, the karaoke track, or the track with a vocal guide. */
  setMix(choice: MixChoice): void {
    this.core.mix.setMix(choice);
  }

  /** Sets, and remembers, the original vocal's level in the guide mix (0..1). */
  setGuideLevel(level: number): void {
    this.core.mix.setGuideLevel(level);
  }

  // ---- Learning mode ------------------------------------------------------

  /**
   * Switches between karaoke (never judges) and learning (scores against the
   * original, tips on request); remembers it and sets the search chip to match.
   */
  setMode(mode: PracticeMode): void {
    this.core.scoring.setMode(mode);
  }

  /** Opens a take's report card (learning mode only shows it); null closes it. */
  showReport(takeId: string | null): void {
    this.core.scoring.showReport(takeId);
  }

  // ---- Finding a song -----------------------------------------------------

  /**
   * Searches for songs under the chip, or opens YouTube's own search in a new
   * tab when there is no key or the quota is spent; call it from the click.
   */
  searchSongs(text: string, filter?: SearchFilter): void {
    this.core.search.search(text, filter);
  }

  /** Searches for the original behind a karaoke video, as Originals. */
  findOriginal(video: Pick<SearchResult, 'title' | 'channel'>): void {
    this.core.search.findOriginal(video);
  }

  /** Loads a search result as the song, as a pasted link would be. */
  pickResult(videoId: string): Promise<void> {
    return this.core.search.pick(videoId);
  }

  /** Chooses karaoke versions or originals for the next search. */
  setSearchFilter(filter: SearchFilter): void {
    this.core.search.setFilter(filter);
  }

  /** Shows or hides the search while a song is loaded. */
  setSearchOpen(open: boolean): void {
    this.core.search.setOpen(open);
  }

  /** Keeps the YouTube API key for searching ('' forgets it); false if it cannot be one. */
  setSearchKey(text: string): boolean {
    return this.core.search.setKey(text);
  }

  /** Plays, resuming the saved mic first if none is open. */
  play(): void {
    this.core.playback.play();
  }

  /** Pauses at the current position. */
  pause(): void {
    this.core.playback.pause();
  }

  /** Play when paused, pause when playing (or buffering, or in an ad). */
  togglePlay(): void {
    this.core.playback.togglePlay();
  }

  /** Stops, ending any recording, and returns to the start. */
  stop(): void {
    this.core.playback.stop();
  }

  /** Moves the playhead to `s` seconds; this ends a recording in progress. */
  seek(s: number): void {
    this.core.playback.seek(s);
  }

  /** Moves the playhead by `ds` seconds, negative for back. */
  nudge(ds: number): void {
    this.core.playback.nudge(ds);
  }

  /** Sets a loop from `a` to `b`, or clears it, or loops a short stretch. */
  toggleLoop(a?: number, b?: number): void {
    this.core.playback.toggleLoop(a, b);
  }

  /** Marks the loop's start (A) or end (B) at the current position. */
  setLoopPoint(which: 'a' | 'b'): void {
    this.core.playback.setLoopPoint(which);
  }

  // ---- Devices and latency ------------------------------------------------

  /** Opens a microphone (null or '' for the system default). */
  chooseInput(id: string | null): Promise<void> {
    return this.core.input.chooseInput(id);
  }

  /** Chooses headphones (raw mic) or speakers (echo cancelled mic). */
  setMonitor(mode: MonitorMode): Promise<void> {
    return this.core.input.setMonitor(mode);
  }

  /** Closes the microphone and the tracker, ending any recording first. */
  closeInput(): Promise<void> {
    return this.core.input.closeInput();
  }

  /** Sends the song to an output device (null or '' for the default). */
  chooseOutput(id: string | null): Promise<void> {
    return this.core.devices.chooseOutput(id);
  }

  /** Measures round-trip latency with chirps and stores it for this pair. */
  calibrate(): Promise<void> {
    return this.core.latency.calibrate();
  }

  /** Sets, or with null clears, the latency for the current device pair. */
  setLatency(s: number | null): void {
    this.core.latency.setLatency(s);
  }

  /** Sets the extra delay applied while a YouTube video is the song. */
  setEmbedOffset(s: number): void {
    this.core.latency.setEmbedOffset(s);
  }

  /** Sets the clarity a frame needs to count as voiced (0..1). */
  setClarity(v: number): void {
    this.core.input.setClarity(v);
  }

  // ---- Takes --------------------------------------------------------------

  /** Starts recording from here, or stops and saves the take in progress. */
  toggleRecord(): Promise<void> {
    return this.core.takes.toggleRecord();
  }

  /**
   * Plays a saved take under the song, or by itself under a video; `fromS`
   * (song time) starts it a moment before that point instead of at its start.
   */
  playTake(id: string, fromS?: number): Promise<void> {
    return this.core.takes.playTake(id, fromS);
  }

  /** Stops the take, restores the song's level and pauses. */
  stopTake(): void {
    this.core.takes.stopTake();
  }

  /** Deletes a take from storage. */
  deleteTake(id: string): Promise<void> {
    return this.core.takes.deleteTake(id);
  }
}
