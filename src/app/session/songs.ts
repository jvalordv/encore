/**
 * Songs and transports: loading a dropped file or a pasted YouTube link, and
 * the one active Transport everything else reads. Owns the embed lifecycle
 * (the video that is the song, the one loading behind it), the load token that
 * lets a newer load win, the copy of the transport's state into the store and
 * the lane, and the status line's word on ads. Exactly one transport is
 * active; a load that fails leaves the song in use as it was.
 */
import type { SongInfo } from '../../audio/player';
import { isRunning } from '../../audio/transport';
import type { TrackInfo, Transport, TransportEvent, TransportState } from '../../audio/transport';
import { loadYouTubeApi } from '../../audio/youtube-api';
import type { YouTubeApi } from '../../audio/youtube-api';
import { EmbedClosedError, YouTubeTransport } from '../../audio/youtube-transport';
import type { EmbedHost } from '../../audio/youtube-transport';
import { parseYouTubeUrl } from '../../audio/youtube-url';
import { describeLoadFailure, formatClock } from '../state';
import type { SessionCore } from './core';
import { messageOf, pageOrigin } from './helpers';

/** Every event a transport can send; the Session listens to all of them. */
const TRANSPORT_EVENTS: readonly TransportEvent[] = [
  'load',
  'play',
  'pause',
  'seek',
  'ended',
  'loop',
  'state',
];
/** Said while an advertisement is in the video player. */
const AD_STATUS = 'An ad is playing in the video. Nothing is drawn or recorded until it ends.';
/** The same, shorter, across the pitch lane. */
const AD_LANE_NOTICE = 'Ad playing: pitch is paused';

/** Loads songs and owns the active transport and the embed lifecycle. */
export class SongController {
  /**
   * The transport everything reads: the audio player, or the YouTube embed
   * once a link has loaded. Null only when this browser has no Web Audio.
   */
  active: Transport | null;
  /**
   * The YouTube transport that is the song, or null. Another may be loading
   * behind it (`loadingEmbed`) and takes over only once it is ready, so a link
   * that fails to load costs the song in use nothing.
   */
  embed: YouTubeTransport | null = null;
  /** Bumped by every load, so a slower, older one cannot overwrite a newer. */
  loadToken = 0;
  private loadingEmbed: YouTubeTransport | null = null;
  private embedHost: EmbedHost | null = null;
  private readonly loadApi: () => Promise<YouTubeApi>;
  // The state the last sync saw, to notice an ad starting or ending.
  private lastState: TransportState = 'empty';

  constructor(
    private readonly core: SessionCore,
    loadApi?: () => Promise<YouTubeApi>,
  ) {
    this.loadApi = loadApi ?? (() => loadYouTubeApi());
    this.active = core.parts?.player ?? null;
  }

  /**
   * Hands over the pane the YouTube player is built into. Without one a
   * pasted link is refused; null takes it away again.
   */
  attachEmbedHost(host: EmbedHost | null): void {
    this.embedHost = host;
  }

  /** Decodes and loads a dropped or picked audio file. */
  async loadSong(file: File): Promise<void> {
    const { parts, store, takes } = this.core;
    if (!parts) return;
    const token = ++this.loadToken;
    // A link still loading is overtaken by this file, whatever comes of it, and
    // so is a preparation under way: both would race this load for the player.
    this.discardLoadingEmbed();
    this.core.prepare.cancelAttempt();
    if (store.state.recording) await takes.finishRecording();
    store.setStatus(`Loading ${file.name}…`);
    let info: SongInfo;
    try {
      info = await parts.player.load(file);
    } catch (error) {
      this.reportLoadFailure(token, error);
      return;
    }
    if (token !== this.loadToken) return;
    // A file replaces any YouTube video, and the audio player is the
    // transport again; load() already dropped its stems, so a take that was
    // replaying is gone, and is forgotten here too. A take begun on the video
    // while the file decoded ends with it: closing the player sends no event.
    if (store.state.recording) void takes.finishRecording();
    this.disposeEmbed();
    this.activate(parts.player);
    takes.endReplay();
    this.core.lane?.clearFrames();
    // The file plays as it is; its karaoke track is made in the background.
    this.core.stems.beginFile(file);
    await takes.refreshTakes();
    const next = store.state.input.open ? 'Press Space to play.' : 'Pick a microphone, then press Play.';
    store.setStatus(`Loaded ${info.name} (${formatClock(info.durationS)}). ${next}`);
  }

  /**
   * Loads a pasted YouTube link into the embedded player and makes it the
   * song, the way loadSong does for a file: a recording in progress is
   * finished, a newer load wins over an older one, the lane is cleared and the
   * takes are those of the video. The API script is fetched now, on first use.
   * The song in use, a file or another video, stays as it is and stays
   * playable until the new video is ready, so a link that cannot be loaded
   * leaves it alone, as a bad file does. Nothing plays until Play is pressed.
   */
  async loadLink(text: string): Promise<void> {
    const { parts, store, takes, prepare } = this.core;
    if (!parts) return;
    const link = parseYouTubeUrl(text);
    if (!link) {
      store.setStatus('That does not look like a YouTube link.', 'warn');
      return;
    }
    const host = this.embedHost;
    if (!host) {
      store.setStatus('This page has no place to show the YouTube player.', 'error');
      return;
    }
    const token = ++this.loadToken;
    // A link still loading is overtaken by this one, and so is a preparation
    // of the video in use: if this load fails that video stays, unprepared.
    this.discardLoadingEmbed();
    prepare.cancelAttempt();
    if (store.state.recording) await takes.finishRecording();
    store.setStatus('Loading the YouTube video…');
    let api: YouTubeApi;
    try {
      api = await this.loadApi();
    } catch (error) {
      this.reportLoadFailure(token, error);
      return;
    }
    if (token !== this.loadToken) return;

    // The new player is built behind the one in use (the pane keeps it out of
    // reach), so the song carries on until this one is ready.
    const transport = new YouTubeTransport({ api, host, origin: pageOrigin() });
    this.loadingEmbed = transport;
    // With no video on the page yet, the pane opens now: a player loads with
    // the size it will have.
    if (this.embed === null) store.patch({ embed: { videoId: link.videoId } });
    this.watch(transport);
    transport.onNotice((notice) => {
      if (this.embed === transport) store.setStatus(notice.text, notice.kind);
    });
    let info: TrackInfo;
    try {
      info = await transport.load(link.videoId, link.startS);
    } catch (error) {
      // A newer load closed this player; it has already taken over.
      if (error instanceof EmbedClosedError) return;
      this.discardLoadingEmbed(transport);
      this.reportLoadFailure(token, error);
      return;
    }
    if (token !== this.loadToken || this.loadingEmbed !== transport) {
      this.discardLoadingEmbed(transport);
      return;
    }

    // Ready: it takes over from the song in use, which is paused and, if it
    // was a video, closed. A take begun on that song while this loaded ends
    // with it: closing the player sends no event.
    if (store.state.recording) void takes.finishRecording();
    const previous = this.embed;
    this.loadingEmbed = null;
    this.embed = transport;
    // The follower goes first: pausing the engine below must not be copied to
    // the video it was following.
    prepare.endPrepared();
    // The stems and melody of the song it replaces are no longer its own.
    this.core.stems.reset();
    store.patch({ embed: { videoId: link.videoId } });
    this.activate(transport);
    previous?.destroy();
    takes.endReplay();
    this.core.lane?.clearFrames();
    // Said before the takes are read, so a message the player sends meanwhile
    // (it can still fail once cued) is the last word, not this one.
    const song = transport.info ?? info;
    const next = store.state.input.open ? 'Press Space to play.' : 'Pick a microphone, then press Play.';
    const length = song.durationS > 0 ? ` (${formatClock(song.durationS)})` : '';
    store.setStatus(`Loaded ${song.name}${length} from YouTube. ${next}`);
    // Whether the service runs is asked now; the link itself goes to it only
    // if the person has turned the automatic setting on, or presses Prepare.
    void prepare.probeService(transport);
    await takes.refreshTakes();
  }

  /** Follows a transport's events; only the active transport's are acted on. */
  watch(transport: Transport): void {
    for (const event of TRANSPORT_EVENTS) {
      transport.on(event, () => this.onTransportEvent(transport, event));
    }
  }

  private onTransportEvent(transport: Transport, event: TransportEvent): void {
    if (transport !== this.active) return;
    const { store, takes } = this.core;
    // A start is the move from not going to going, so note where it was.
    const wasRunning = isRunning(this.lastState);
    this.syncTransport();
    // The video can also be started with YouTube's own controls in the
    // iframe, which never pass through play().
    if (transport.clock === 'embed' && !wasRunning && isRunning(transport.state)) {
      this.embedStarted(transport);
    }
    // A take assumes the song advanced in real time from one anchor, so
    // anything that moves or stops the song ends it: a seek, the end, a pause,
    // or the embed stalling to buffer or showing an ad.
    const breaksTake = event === 'seek' || event === 'ended' || transport.state !== 'playing';
    if (breaksTake && store.state.recording) void takes.finishRecording();
    if (event === 'seek') takes.resyncReplay();
  }

  /**
   * The video has started, or begun to buffer for it, from a state where it
   * was not going. play() does the following before it asks the video to
   * play, but the iframe's own controls skip it, so it is done here as well:
   * a calibration run is not played over, a take playing by itself yields,
   * the audio context runs for the live pitch and the saved mic is reopened.
   */
  private embedStarted(transport: Transport): void {
    const { store, takes } = this.core;
    if (store.state.calibrating) {
      // The video would drown the chirps; the Play button is disabled for the
      // same reason.
      transport.pause();
      store.setStatus('Wait for calibration to finish before playing the video.', 'warn');
      return;
    }
    // Not stopTake(): that would pause the video that has just started.
    if (takes.solo) {
      takes.endReplay();
      this.core.lane?.clearFrames();
    }
    void this.core.parts?.engine.resume().catch(() => {});
    this.core.input.reopenSavedInput();
  }

  /** Copies the active transport's state into the store and the lane. */
  syncTransport(): void {
    const transport = this.active;
    if (!transport) return;
    const position = this.currentPosition();
    const state = transport.state;
    this.core.store.patch({
      song: transport.info,
      player: state,
      clock: transport.clock,
      positionS: position,
      loop: transport.loop,
      durationS: transport.durationS,
    });
    this.core.lane?.setTime(position);
    this.core.lane?.setNotice(state === 'ad' ? AD_LANE_NOTICE : null);
    this.noteAd(state);
  }

  /** Says so on the status line when an ad starts or ends. */
  private noteAd(state: TransportState): void {
    const before = this.lastState;
    this.lastState = state;
    if (state === 'ad' && before !== 'ad') this.core.store.setStatus(AD_STATUS, 'warn');
    else if (before === 'ad' && state !== 'ad') this.core.store.setStatus('The ad ended.');
  }

  /**
   * Makes `next` the transport everything reads. The one it replaces is
   * paused so two sources are never heard, unless it is a video that has just
   * been muted to follow the engine, and a take that was replaying against it
   * is let go.
   */
  activate(next: Transport, options: { pausePrevious?: boolean } = {}): void {
    const previous = this.active;
    this.active = next;
    if (previous !== next) {
      if (options.pausePrevious !== false) previous?.pause();
      this.core.takes.endReplay();
      this.core.lane?.clearFrames();
      this.lastState = 'empty';
      this.core.input.resetFrameClock();
    }
    this.syncTransport();
  }

  /**
   * Closes the YouTube player that is the song and hands the song back to the
   * audio player: the Player is always there to take it, whether the video was
   * the active transport or, once prepared, only following the Player.
   */
  disposeEmbed(): void {
    const embed = this.embed;
    if (!embed) return;
    this.core.prepare.endPrepared();
    this.embed = null;
    embed.destroy();
    this.core.store.patch({ embed: null });
    if (this.core.parts) this.activate(this.core.parts.player);
  }

  /**
   * Closes the video that is loading (the one given, or whichever there is)
   * and puts the pane back as the song in use needs it: shown for a video,
   * hidden for a file.
   */
  discardLoadingEmbed(which?: YouTubeTransport): void {
    const loading = this.loadingEmbed;
    if (!loading || (which !== undefined && loading !== which)) return;
    this.loadingEmbed = null;
    loading.destroy();
    this.core.store.patch({ embed: this.embed ? { videoId: this.embed.videoId } : null });
  }

  /**
   * Puts a failed load on the status line, unless a newer load has taken the
   * line over. A failed load leaves the song in use alone, so when there is
   * one the message says it is still loaded: it may well be playing on beside
   * a red error.
   */
  private reportLoadFailure(token: number, error: unknown): void {
    if (token !== this.loadToken) return;
    this.core.store.setStatus(describeLoadFailure(messageOf(error), this.hasSong()), 'error');
  }

  /** The playhead: the take's own while it plays by itself, else the song's. */
  currentPosition(): number {
    const solo = this.core.takes.solo;
    if (solo && this.core.parts) {
      return solo.offsetS + Math.max(0, this.core.parts.engine.now() - solo.startedAtContextS);
    }
    return this.active?.positionS ?? 0;
  }

  /** Extra delay for the YouTube path; zero for a file. */
  embedOffsetNow(): number {
    return this.active?.clock === 'embed' ? this.core.current.embedOffsetS : 0;
  }

  /**
   * Resolves true once the transport is playing, false if it is not within
   * `timeoutMs`. The audio player is playing the moment play() returns; the
   * embed takes a few hundred milliseconds (buffering) after the press.
   */
  waitForPlaying(transport: Transport, timeoutMs: number): Promise<boolean> {
    if (transport.state === 'playing') return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const unsubscribe: Array<() => void> = [];
      const finish = (playing: boolean): void => {
        clearTimeout(timer);
        for (const off of unsubscribe) off();
        resolve(playing);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const check = (): void => {
        if (transport.state === 'playing') finish(true);
      };
      for (const event of ['play', 'state'] as const) unsubscribe.push(transport.on(event, check));
    });
  }

  /** True once any song is loaded. */
  hasSong(): boolean {
    return this.core.store.state.player !== 'empty';
  }

  /** Ends the preparation, the loading video and the video in use. */
  dispose(): void {
    this.core.prepare.endPrepared();
    this.discardLoadingEmbed();
    this.disposeEmbed();
  }
}
