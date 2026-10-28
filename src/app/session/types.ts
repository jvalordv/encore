/**
 * Shapes shared by the Session facade and its controllers: the lane methods
 * the Session drives, the audio objects behind it, what can be injected, and
 * the device lists. Types only, so importing this touches no browser API.
 */
import type { PitchTracker } from '../../analysis/pitch-tracker';
import type { PcmCapture } from '../../audio/capture';
import type { AudioEngine } from '../../audio/engine';
import type { InputDevice, MicCapture } from '../../audio/mic';
import type { Player } from '../../audio/player';
import type { Recorder } from '../../audio/recorder';
import type { YouTubeApi } from '../../audio/youtube-api';
import type { PitchLane } from '../../render/pitch-lane';
import type { StateStore } from '../state';
import type { KeyValueStore } from '../storage';
import type { TakeStore } from '../takes';

/** The lane methods the Session drives; PitchLane satisfies them. */
export type LaneSink = Pick<PitchLane, 'setTime' | 'pushFrame' | 'clearFrames' | 'setNotice'>;

/** The audio objects behind the Session, exposed for tests and debugging. */
export interface SessionParts {
  engine: AudioEngine;
  player: Player;
  mic: MicCapture;
  capture: PcmCapture;
  tracker: PitchTracker;
  recorder: Recorder;
}

/** Everything injectable; the defaults are the real browser services. */
export interface SessionOptions {
  /** Where settings persist; default is localStorage under `encore.`. */
  settings?: KeyValueStore;
  /** Take storage; default is IndexedDB with a memory fallback. */
  takes?: TakeStore | Promise<TakeStore>;
  /** State to write into; default is a fresh store. */
  store?: StateStore;
  /**
   * Loads the YouTube IFrame API when a link is first used; the default
   * fetches Google's script. Tests and the end-to-end run substitute a stub.
   */
  youtubeApi?: () => Promise<YouTubeApi>;
}

/** Devices the browser currently offers. */
export interface DeviceLists {
  inputs: InputDevice[];
  outputs: MediaDeviceInfo[];
}
