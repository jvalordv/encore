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
import { DuetController } from '../../duet/controller';
import { saveSettings } from '../settings';
import type { Settings } from '../settings';
import { memoryLibraryStore } from '../library';
import type { LibraryStore } from '../library';
import type { StateStore } from '../state';
import type { KeyValueStore } from '../storage';
import type { TakeStore } from '../takes';
import { AlignController } from './align';
import { DeviceController } from './devices';
import { FrameBus } from './frame-bus';
import { IngestController } from './ingest';
import { InputController } from './input';
import { BackingController } from './backing';
import { KeyController } from './keys';
import { LibraryController } from './library';
import { LatencyController } from './latency';
import { TickLoop } from './loop';
import { CaptureController } from './capture';
import { MicCheckController } from './mic-check';
import { MicHealthController } from './mic-health';
import { MixController } from './mix';
import { PlaybackController } from './playback';
import { ProfilesController } from './profiles';
import { PrepareController } from './prepare';
import { ScoringController } from './scoring';
import { SearchController } from './search';
import { SettingsController } from './settings';
import type { SearchOptions } from './search';
import { SongController } from './songs';
import { SongReferenceController } from './song-reference';
import { StemsController } from './stems';
import { TakeController } from './takes';
import type { LaneSink, SecondParts, SessionParts } from './types';

/** What the core is built from; the Session facade fills it from its options. */
export interface SessionCoreInit {
  store: StateStore;
  settingsStore: KeyValueStore;
  /** The loaded settings; the core mutates this object and saves it. */
  settings: Settings;
  /** The audio objects, or null when the browser has no Web Audio. */
  parts: SessionParts | null;
  takes: Promise<TakeStore>;
  /** The Library's storage; a memory store when left out. */
  library?: Promise<LibraryStore>;
  youtubeApi?: () => Promise<YouTubeApi>;
  /** What the song search reaches out with (see SearchOptions). */
  search?: SearchOptions;
  /** Overrides the worklet support check; tests set it for fake parts. */
  trackerSupported?: boolean;
  /** Builds singer B's mic and tracker; tests hand fakes, the default is real. */
  secondParts?: () => SecondParts | null;
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
  readonly capture: CaptureController;
  readonly songReference: SongReferenceController;
  readonly input: InputController;
  readonly health: MicHealthController;
  readonly micCheck: MicCheckController;
  readonly devices: DeviceController;
  readonly latency: LatencyController;
  readonly mix: MixController;
  readonly stems: StemsController;
  readonly align: AlignController;
  readonly keys: KeyController;
  readonly backing: BackingController;
  readonly search: SearchController;
  readonly library: LibraryController;
  readonly ingest: IngestController;
  readonly settings: SettingsController;
  readonly duet: DuetController;
  readonly profiles: ProfilesController;
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
    this.capture = new CaptureController(this);
    this.songReference = new SongReferenceController(this);
    this.health = new MicHealthController(this);
    this.micCheck = new MicCheckController(this);
    this.input = new InputController(this);
    this.devices = new DeviceController(this);
    this.latency = new LatencyController(this);
    this.mix = new MixController(this);
    this.stems = new StemsController(this);
    this.align = new AlignController(this);
    this.backing = new BackingController(this);
    this.keys = new KeyController(this);
    this.search = new SearchController(this, init.search);
    this.library = new LibraryController(this, init.library ?? Promise.resolve(memoryLibraryStore()));
    this.ingest = new IngestController(this);
    this.settings = new SettingsController(this);
    this.duet = new DuetController(this, init.secondParts);
    this.profiles = new ProfilesController(this);
    this.loop = new TickLoop(this);

    const sinkCapable = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    this.store.patch({
      tracker: this.trackerSupported ? 'idle' : 'unsupported',
      embedOffsetS: this.current.embedOffsetS,
      mode: this.current.mode,
      scoring: this.current.scoring,
      noteGuide: this.current.noteGuide,
      keyboard: this.current.keyboard,
      hoverHelp: this.current.hoverHelp,
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
    this.store.patch({ settingsRev: this.store.state.settingsRev + 1 });
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
