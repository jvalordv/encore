/**
 * The shared ground of the session controllers: the state store, the audio
 * parts, the settings, the lane, the frame bus, and the controllers
 * themselves, so each can reach the others through one object. Everything is
 * injected (store, settings storage, parts, take store), which is what lets
 * tests build a whole session on fake parts without a browser. The Session
 * facade is a thin layer over this (src/app/session.ts).
 */
import { PitchTracker } from '../../analysis/pitch-tracker';
import { PcmCapture } from '../../audio/capture';
import type { YouTubeApi } from '../../audio/youtube-api';
import { saveSettings } from '../settings';
import type { Settings } from '../settings';
import type { StateStore } from '../state';
import type { KeyValueStore } from '../storage';
import type { TakeStore } from '../takes';
import { DeviceController } from './devices';
import { FrameBus } from './frame-bus';
import { InputController } from './input';
import { LatencyController } from './latency';
import { TickLoop } from './loop';
import { MixController } from './mix';
import { PlaybackController } from './playback';
import { PrepareController } from './prepare';
import { ScoringController } from './scoring';
import { SearchController } from './search';
import type { SearchOptions } from './search';
import { SongController } from './songs';
import { StemsController } from './stems';
import { TakeController } from './takes';
import type { LaneSink, SessionParts } from './types';

/** What the core is built from; the Session facade fills it from its options. */
export interface SessionCoreInit {
  store: StateStore;
  settingsStore: KeyValueStore;
  /** The loaded settings; the core mutates this object and saves it. */
  settings: Settings;
  /** The audio objects, or null when the browser has no Web Audio. */
  parts: SessionParts | null;
  takes: Promise<TakeStore>;
  youtubeApi?: () => Promise<YouTubeApi>;
  /** What the song search reaches out with (see SearchOptions). */
  search?: SearchOptions;
  /** Overrides the worklet support check; tests set it for fake parts. */
  trackerSupported?: boolean;
}

/** The store, the parts, the settings and the controllers, in one place. */
export class SessionCore {
  readonly store: StateStore;
  readonly parts: SessionParts | null;
  readonly settingsStore: KeyValueStore;
  /** The settings as held; controllers change fields and call persist(). */
  readonly current: Settings;
  readonly takesReady: Promise<TakeStore>;
  // Both worklet users have to be available, or live pitch and recording are
  // off together and the status line says why.
  readonly trackerSupported: boolean;
  /** Where song-time pitch frames are announced (see frame-bus.ts). */
  readonly bus = new FrameBus();
  /** The pitch lane to scroll and feed, once the UI has attached one. */
  lane: LaneSink | null = null;

  readonly takes: TakeController;
  readonly scoring: ScoringController;
  readonly songs: SongController;
  readonly playback: PlaybackController;
  readonly prepare: PrepareController;
  readonly input: InputController;
  readonly devices: DeviceController;
  readonly latency: LatencyController;
  readonly mix: MixController;
  readonly stems: StemsController;
  readonly search: SearchController;
  readonly loop: TickLoop;

  constructor(init: SessionCoreInit) {
    this.store = init.store;
    this.parts = init.parts;
    this.settingsStore = init.settingsStore;
    this.current = init.settings;
    this.takesReady = init.takes;
    this.trackerSupported = init.trackerSupported ?? (PitchTracker.isSupported() && PcmCapture.isSupported());

    // The take controller goes first so its frame subscriber runs before the
    // lane's (the scoring controller feeds the lane), as the take recorded a
    // frame before the lane drew it.
    this.takes = new TakeController(this);
    this.scoring = new ScoringController(this);
    this.songs = new SongController(this, init.youtubeApi);
    this.playback = new PlaybackController(this);
    this.prepare = new PrepareController(this);
    this.input = new InputController(this);
    this.devices = new DeviceController(this);
    this.latency = new LatencyController(this);
    this.mix = new MixController(this);
    this.stems = new StemsController(this);
    this.search = new SearchController(this, init.search);
    this.loop = new TickLoop(this);

    const sinkCapable = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    this.store.patch({
      tracker: this.trackerSupported ? 'idle' : 'unsupported',
      embedOffsetS: this.current.embedOffsetS,
      mode: this.current.mode,
      scoring: this.current.scoring,
    });
    this.store.patchSection('input', {
      deviceId: this.current.inputDeviceId,
      monitor: this.current.monitor,
    });
    this.store.patchSection('output', { selectable: this.parts !== null && sinkCapable });
    this.latency.refreshLatency();
    if (this.parts) this.wire(this.parts);
  }

  /** Writes the settings to storage, validated on the way. */
  persist(): void {
    saveSettings(this.settingsStore, this.current);
  }

  private wire(parts: SessionParts): void {
    this.songs.watch(parts.player);
    this.input.wire(parts);
    if (!this.trackerSupported) {
      this.store.setStatus(
        'No AudioWorklet here (it needs localhost or https), so live pitch and recording are off.',
        'warn',
      );
    }
  }
}
