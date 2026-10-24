/**
 * The seam between "where the song's sound and clock come from" and everything
 * that reads them. The audio Player is one transport (Web Audio, a
 * sample-accurate clock) and YouTubeTransport (an embedded player whose clock
 * is its reported time, guarded) is the other. The Session, the pitch lane,
 * recording, loop A/B, the seek bar and the clock readout only ever talk to the
 * active Transport, so the source of a song can change without any of them
 * knowing (see "YouTube playback in the app" in docs/ARCHITECTURE.md). Types
 * and one tiny pure helper; DOM-free.
 */

/** Which clock a song runs on; takes record it so their alignment is honest. */
export type ClockKind = 'engine' | 'embed';

/**
 * Transport state. 'ready' is loaded and idle at the start. 'buffering' and
 * 'ad' are states of the embed only: the user wants playback but the clock is
 * not advancing (the video is loading more, or an advertisement is in the
 * player). Nothing is stamped or recorded in either.
 */
export type TransportState = 'empty' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ad';

/**
 * Things a transport tells its listeners. A change of `state` is announced by
 * at least one of 'play', 'pause', 'ended', 'load' or 'state': 'play' when the
 * clock starts advancing, 'pause' when it stops for any reason but the end (a
 * pause, buffering, an ad), 'ended' at the end of the song, and 'state' for
 * changes between states that are none of those, such as a stop or a
 * buffering spell that ends in a pause. 'seek' means the position jumped: a
 * seek, a stop, or a clock discontinuity the transport noticed on its own.
 * 'load' means the song, or what is known about it, changed. 'loop' means the
 * loop region changed. The audio player never fires 'state' (its `stop()` from
 * a pause at the very start is its one silent move, to 'ready') and does not
 * announce loop wraps; a position that wraps is not a jump.
 */
export type TransportEvent = 'load' | 'play' | 'pause' | 'seek' | 'ended' | 'loop' | 'state';

/** A section of the song to repeat, in seconds of song time. */
export interface LoopRegion {
  startS: number;
  endS: number;
}

/** What every source can say about the loaded song. */
export interface TrackInfo {
  /** Shown in the song panel: the file name, or the video's title. */
  name: string;
  durationS: number;
  /**
   * What takes are filed under: the sha256 hex of a dropped file (an
   * 8-character FNV-1a hex when crypto.subtle is missing), or `yt-<video id>`
   * for a YouTube video, the same id the service will use for it.
   */
  hash: string;
}

/** Play, pause, seek and loop over one song, whatever supplies its sound. */
export interface Transport {
  /** The clock this transport runs on. */
  readonly clock: ClockKind;
  readonly state: TransportState;
  /** Song time in seconds; for the embed this is the guarded clock. */
  readonly positionS: number;
  /** Length of the song, 0 while unknown. */
  readonly durationS: number;
  /** The loaded song, or null before the first successful load. */
  readonly info: TrackInfo | null;
  /** The active loop region, or null. */
  readonly loop: LoopRegion | null;
  /** Starts or resumes playback; from the start if it had reached the end. */
  play(): void;
  /** Pauses at the current position. */
  pause(): void;
  /** Pauses and returns to the start, leaving the transport 'ready'. */
  stop(): void;
  /** Moves the playhead, clamped to the song. */
  seek(positionS: number): void;
  /** Sets or clears (null) the loop region; one too short to loop clears. */
  setLoop(region: LoopRegion | null): void;
  /** Subscribes to an event; returns the function that unsubscribes. */
  on(event: TransportEvent, listener: () => void): () => void;
}

/**
 * True while the song is meant to be going: playing, or waiting on the
 * network or an ad. The Play button reads "Pause" for all three.
 */
export function isRunning(state: TransportState): boolean {
  return state === 'playing' || state === 'buffering' || state === 'ad';
}
