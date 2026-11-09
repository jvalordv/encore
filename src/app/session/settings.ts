/**
 * The Settings panel's side of the Session: the settings that no inline
 * control owns (service address, octave invariance, the keyboard view's
 * home), a health test for the service, and the three whole-object actions,
 * Reset all, export and import. Applying a whole Settings object goes through
 * the same intents the inline controls call (setMode, setNoteGuide,
 * setClarity, ...), one by one, so the lane, the tracker, the state and the
 * stored object all move together and there is no second source of truth.
 * Reset all and import touch settings only: takes, singer profiles, the
 * Library, lyrics, favorites and the per-song stores (key shift, free
 * phrases, turns) stay; an import adds or updates the singers its file names.
 */
import { ServiceClient } from '../../service/client';
import { describeImport, exportSettingsText, parseSettingsText } from '../settings-io';
import { parseServiceUrl, sanitizeSettings } from '../settings';
import type { Settings } from '../settings';
import type { SessionCore } from './core';

/** The words when a change is refused because a take is being recorded. */
export const FINISH_FIRST = 'Finish recording, calibrating or the Mic check first.';

/** What an import did, for the panel to say and to finish (the skin). */
export interface ImportOutcome {
  /** One plain sentence for the person. */
  message: string;
  /** False when nothing was applied (not our file, or recording). */
  applied: boolean;
  /** The skin the file asked for, for the caller that owns the skin. */
  skin: string | null;
}

/** Applies, resets, exports and imports the settings. */
export class SettingsController {
  constructor(private readonly core: SessionCore) {}

  /** Shows or hides the piano keyboard on the lane, remembering the choice. */
  setKeyboard(on: boolean): void {
    const { core } = this;
    core.current.keyboard = on;
    core.persist();
    core.lane?.setKeyboard(on);
    core.store.patch({ keyboard: on });
  }

  /** Turns hover help popups on or off, remembering the choice. */
  setHoverHelp(on: boolean): void {
    const { core } = this;
    core.current.hoverHelp = on;
    core.persist();
    core.store.patch({ hoverHelp: on });
  }

  /** Keeps a new service address; false (and unchanged) when it is no URL. */
  setServiceUrl(text: string): boolean {
    const url = parseServiceUrl(text);
    if (url === null) return false;
    this.core.current.serviceUrl = url;
    this.core.persist();
    return true;
  }

  /** Judges pitch modulo an octave, or not, and remembers it. */
  setOctaveInvariant(on: boolean): void {
    this.core.current.octaveInvariant = on === true;
    this.core.persist();
  }

  /** Asks the service at the saved address whether it is running. */
  testService(): Promise<boolean> {
    return new ServiceClient({ baseUrl: this.core.current.serviceUrl }).health();
  }

  /** The text of a settings file; the key is in it only when asked for. */
  exportText(skin: string, includeKey: boolean): string {
    const autoAdvance = this.core.store.state.library.autoAdvance;
    const profiles = this.core.profiles.list();
    return exportSettingsText(this.core.current, { skin, autoAdvance, profiles }, includeKey);
  }

  /**
   * Applies a settings file. `skinIds` are the skins the app has; the skin
   * itself is handed back for the caller to apply, since it lives in the page.
   */
  importText(text: string, skinIds: readonly string[], currentSkin: string): ImportOutcome {
    const { store, current } = this.core;
    const parsed = parseSettingsText(text, current, skinIds);
    if (parsed === null) {
      return { message: 'That file is not an Encore settings file.', applied: false, skin: null };
    }
    if (this.busy()) return { message: FINISH_FIRST, applied: false, skin: null };
    const extras: string[] = [];
    if (parsed.skin !== null && parsed.skin !== currentSkin) extras.push('Skin');
    if (parsed.autoAdvance !== null && parsed.autoAdvance !== store.state.library.autoAdvance) {
      extras.push('Auto-advance');
    }
    // Singers from the file are added or updated, never removed, so no take loses its owner.
    if (parsed.profiles !== null && this.core.profiles.merge(parsed.profiles) > 0) extras.push('Singers');
    this.apply(parsed.settings, parsed.autoAdvance);
    return { message: describeImport(parsed, extras), applied: true, skin: parsed.skin };
  }

  /** True while something is using the mic or the settings it reads. */
  private busy(): boolean {
    const { store, takes, micCheck } = this.core;
    return store.state.recording || store.state.calibrating || takes.startingRecord || micCheck.active;
  }

  /** Puts every setting back to its default; false while busy. */
  resetAll(): boolean {
    if (this.busy()) {
      this.core.store.setStatus(FINISH_FIRST, 'warn');
      return false;
    }
    // The key and the pair-keyed numbers are settings too; "all" means all.
    this.apply(sanitizeSettings(null), true);
    this.core.store.setStatus('All settings are back to their defaults.');
    return true;
  }

  /**
   * Moves the running app to `next` through the existing intents. The mic and
   * second mic are not reopened: a device id is stored only while the mic is
   * closed, and singer B's own input is left as it is.
   */
  private apply(next: Settings, autoAdvance: boolean | null): void {
    const { core } = this;
    const { current, store } = core;
    core.mix.setGuideLevel(next.guideLevel);
    core.latency.setEmbedOffset(next.embedOffsetS);
    core.scoring.setMode(next.mode);
    core.scoring.setScoring(next.scoring);
    core.health.setNoteGuide(next.noteGuide);
    this.setKeyboard(next.keyboard);
    this.setHoverHelp(next.hoverHelp);
    core.prepare.setAutoPrepareLinks(next.autoPrepareLinks);
    core.input.setClarity(next.clarityThreshold);
    if (next.youtubeApiKey !== current.youtubeApiKey) core.search.setKey(next.youtubeApiKey);
    if (autoAdvance !== null) core.library.setAutoAdvance(autoAdvance);

    current.serviceUrl = next.serviceUrl;
    current.octaveInvariant = next.octaveInvariant;
    current.searchProvider = next.searchProvider;
    current.latencyByDevicePair = { ...next.latencyByDevicePair };
    current.micTuningByDevicePair = { ...next.micTuningByDevicePair };
    if (!store.state.input.open) {
      current.inputDeviceId = next.inputDeviceId;
      store.patchSection('input', { deviceId: next.inputDeviceId });
    }
    core.persist();
    core.latency.refreshLatency();
    core.health.syncTuning();

    const duet = core.duet;
    // The names and colours of the two slots are the singers' profiles, which a
    // reset keeps (they are people, not preferences) and an import merges.
    duet.setSecondSinger(next.duet.secondSinger);

    void core.input.setMonitor(next.monitor);
    if (next.outputDeviceId !== current.outputDeviceId) void core.devices.chooseOutput(next.outputDeviceId);
  }
}
