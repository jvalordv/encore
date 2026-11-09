/**
 * The Settings panel: a drawer, opened from the header's Settings button,
 * that gathers every setting in one place: microphone and output, timing,
 * mic tuning, karaoke, learning, singers, library, search, service and
 * appearance, then Reset all, Export and Import. It owns no values. Each
 * control reads the same store the inline control reads (the state store, or
 * `session.settings` for what the state does not hold) and writes through the
 * same Session intent, and it redraws whenever the state or the settings
 * revision changes, so changing a value here or at the inline control leaves
 * both showing it. Reset all and Import apply through those intents too and
 * never touch takes, the Library, lyrics or favorites.
 */
import type { Session } from '../session';
import { isActivePhase } from '../mic-check';
import type { PanelLayout } from '../panel-layout';
import { SETTINGS_FILE_NAME } from '../settings-io';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';
import { shownColour } from './profile-select';
import { makeKit } from './settings-fields';
import type { Choice } from './settings-fields';

/** The skin, which lives in the page rather than in the Session. */
export interface SkinPort {
  /** Every skin as [id, name]. */
  choices: readonly Choice[];
  /** The skin a reset returns to. */
  defaultId: string;
  current(): string;
  set(id: string): void;
  /** Calls back when any control changes the skin; returns an unsubscribe. */
  onChange(cb: () => void): () => void;
}

/** What the panel needs: the state, the intents and the buttons it works with. */
export interface SettingsPanelDeps {
  store: StateStore;
  session: Pick<
    Session,
    | 'settings'
    | 'duet'
    | 'profiles'
    | 'deviceLists'
    | 'onDevices'
    | 'refreshDevices'
    | 'chooseInput'
    | 'chooseOutput'
    | 'setMonitor'
    | 'calibrate'
    | 'setLatency'
    | 'setEmbedOffset'
    | 'micTuning'
    | 'resetMicTuning'
    | 'setNoteGuide'
    | 'setKeyboard'
    | 'setGuideLevel'
    | 'setBackingShown'
    | 'setMode'
    | 'setScoring'
    | 'setHoverHelp'
    | 'setOctaveInvariant'
    | 'setClarity'
    | 'setAutoAdvance'
    | 'setAutoReference'
    | 'setSearchKey'
    | 'setServiceUrl'
    | 'testService'
    | 'exportSettings'
    | 'importSettings'
    | 'resetAllSettings'
    | 'setLibraryOpen'
  >;
  /** The song panel's layout, which Reset all puts back to its default. */
  layout?: { get(): PanelLayout; set(next: PanelLayout): void; reset(): void };
  /** The header button that opens the drawer. */
  toggle: HTMLButtonElement;
  /** The header's Mic check button; the panel's own button presses it. */
  micCheckToggle: HTMLButtonElement;
  skin: SkinPort;
  /** Hands a finished file to the browser as a download. */
  download(text: string, name: string): void;
}

/** Select values for "the system default". */
const DEFAULT = '@default';

const ms = (s: number | null): string => (s === null ? '' : String(Math.round(s * 1000)));

/** Builds the drawer into `host`; the returned function takes it down. */
export const mountSettingsPanel: MountPanel<SettingsPanelDeps> = (host, deps) => {
  const { store, session, toggle, micCheckToggle, skin, download, layout } = deps;
  const doc = host.ownerDocument;
  const kit = makeKit(doc);
  const { el } = kit;
  const cleanups: Array<() => void> = [];
  const on = (target: HTMLElement, type: 'click' | 'change', fn: () => void): void => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };
  const head = el('div', 'settings-head', 'library-head');
  const title = doc.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Settings';
  head.append(title);
  kit.button(head, 'Close', 'settings-close', () => setOpen(false));
  host.append(head);

  const deviceChoices = (kind: 'inputs' | 'outputs', first: Choice[]): Choice[] => {
    const list: Choice[] = [...first];
    session.deviceLists[kind].forEach((d, i) => {
      if (d.deviceId) list.push([d.deviceId, d.label || `${kind === 'inputs' ? 'Microphone' : 'Output'} ${i + 1}`]);
    });
    return list;
  };

  // ---- Microphone and output ------------------------------------------------
  const mic = kit.section(host, 'Microphone and output', 'settings-mic');
  const inputPick = kit.select(
    mic,
    'Microphone ',
    'settings-input',
    () => deviceChoices('inputs', [['@none', 'Choose a microphone…'], [DEFAULT, 'System default']]),
    (s) => s.input.deviceId ?? (s.input.open ? DEFAULT : '@none'),
    (v) => {
      if (v !== '@none') void session.chooseInput(v === DEFAULT ? null : v);
    },
  );
  const outputPick = kit.select(
    mic,
    'Output ',
    'settings-output',
    () => deviceChoices('outputs', [[DEFAULT, 'System default']]),
    (s) => s.output.deviceId ?? DEFAULT,
    (v) => void session.chooseOutput(v === DEFAULT ? null : v),
  );
  const monitor = kit.segmented(
    mic,
    'Monitor mode',
    'settings-monitor',
    [
      ['headphones', 'Headphones'],
      ['speakers', 'Speakers'],
    ],
    (s) => s.input.monitor,
    (v) => void session.setMonitor(v === 'speakers' ? 'speakers' : 'headphones'),
  );
  const bRow = el('div', 'settings-input-b-row');
  mic.append(bRow);
  const inputBPick = kit.select(
    bRow,
    'Singer B microphone ',
    'settings-input-b',
    () => deviceChoices('inputs', [[DEFAULT, 'System default']]),
    (s) => s.duet.deviceIdB ?? DEFAULT,
    (v) => void session.duet.chooseSecondInput(v === DEFAULT ? null : v),
  );
  const refresh = kit.button(mic, 'Refresh devices', 'settings-refresh', () => void session.refreshDevices());

  // ---- Timing ---------------------------------------------------------------
  const timing = kit.section(host, 'Timing', 'settings-timing');
  const latencyField = kit.text(
    timing,
    'Latency for this microphone and output, ms ',
    'settings-latency',
    'number',
    (s) => ms(s.latencyS),
    (v) => session.setLatency(v.trim() === '' ? null : Number(v) / 1000),
  );
  const embedField = kit.text(
    timing,
    'Embed offset for a YouTube video, ms ',
    'settings-embed-offset',
    'number',
    (s) => ms(s.embedOffsetS),
    (v) => session.setEmbedOffset(v.trim() === '' ? 0 : Number(v) / 1000),
  );
  const timingButtons = el('div', 'settings-timing-buttons', 'button-row');
  const calibrate = kit.button(timingButtons, 'Calibrate', 'settings-calibrate', () => void session.calibrate());
  const micCheckButton = kit.button(timingButtons, 'Mic check', 'settings-mic-check', () => {
    // The inline toggle is disabled while busy; closing the drawer for a
    // click that does nothing would only hide the controls.
    if (micCheckToggle.disabled) return;
    setOpen(false);
    micCheckToggle.click();
  });
  timing.append(timingButtons);

  // ---- Mic tuning -----------------------------------------------------------
  const tuning = kit.section(host, 'Mic tuning for this microphone and output', 'settings-tuning');
  kit.line(tuning, 'settings-tuning-gate', () => `Gate margin: ${session.micTuning.drawMarginDb.toFixed(1)} dB`);
  kit.line(tuning, 'settings-tuning-clarity', () => `Clarity: ${session.micTuning.clarityThreshold.toFixed(2)}`);
  kit.line(
    tuning,
    'settings-tuning-bleed',
    () =>
      `Bleed check: within ${session.micTuning.bleedMatchCents.toFixed(0)} cents, ` +
      `${(session.micTuning.bleedMinMatch * 100).toFixed(0)}% matching, ` +
      `median under ${session.micTuning.bleedMaxMedianCents.toFixed(0)} cents`,
  );
  kit.line(tuning, 'settings-tuning-state', () => {
    const tuned = Object.keys(session.settings.micTuningByDevicePair).length;
    return tuned === 0
      ? 'Using the defaults. Mic check can tune them.'
      : `Tuned for ${tuned} microphone and output ${tuned === 1 ? 'pair' : 'pairs'}.`;
  });
  kit.button(tuning, 'Reset to defaults', 'settings-tuning-reset', () => session.resetMicTuning());

  // ---- Karaoke --------------------------------------------------------------
  const karaoke = kit.section(host, 'Karaoke', 'settings-karaoke');
  kit.check(karaoke, 'Note guide', 'settings-note-guide', (s) => s.noteGuide, (v) => session.setNoteGuide(v));
  kit.check(karaoke, 'Keyboard', 'settings-keyboard', (s) => s.keyboard, (v) => session.setKeyboard(v));
  kit.range(
    karaoke,
    'Vocal guide level ',
    'settings-guide-level',
    [0, 1, 0.05],
    (s) => s.mix.guideLevel,
    (v) => session.setGuideLevel(v),
  );
  kit.check(
    karaoke,
    'Show backing notes (this session only)',
    'settings-backing',
    (s) => s.backing.shown,
    (v) => session.setBackingShown(v),
  );

  // ---- Learning -------------------------------------------------------------
  const learning = kit.section(host, 'Learning', 'settings-learning');
  kit.segmented(
    learning,
    'Mode',
    'settings-mode',
    [
      ['karaoke', 'Karaoke'],
      ['learning', 'Learning'],
    ],
    (s) => s.mode,
    (v) => session.setMode(v === 'learning' ? 'learning' : 'karaoke'),
  );
  kit.segmented(
    learning,
    'Scoring style',
    'settings-scoring',
    [
      ['strict', 'Strict'],
      ['open', 'Open'],
    ],
    (s) => s.scoring,
    (v) => session.setScoring(v === 'open' ? 'open' : 'strict'),
  );
  kit.check(
    learning,
    'Judge pitch within an octave (octave invariance)',
    'settings-octave',
    () => session.settings.octaveInvariant,
    (v) => session.setOctaveInvariant(v),
  );
  kit.range(
    learning,
    'Clarity threshold ',
    'settings-clarity',
    [0, 1, 0.01],
    () => session.settings.clarityThreshold,
    (v) => session.setClarity(v),
  );

  // ---- Singers --------------------------------------------------------------
  const singers = kit.section(host, 'Singers', 'settings-singers');
  // The two slots are singer profiles: the pick chooses who is in the slot,
  // the name and colour fields rename and recolour that profile.
  const slotOf = (s: AppState, i: 0 | 1) => s.profiles.list.find((p) => p.id === (i === 0 ? s.profiles.activeId : s.profiles.secondId));
  const singerPicks: HTMLSelectElement[] = [];
  const nameAndColour = (i: 0 | 1, id: string): void => {
    const pick = kit.select(
      singers,
      `Singer ${id.toUpperCase()} `,
      `settings-singer-${id}-profile`,
      (s) => s.profiles.list.map((p): Choice => [p.id, p.name]),
      (s) => (i === 0 ? s.profiles.activeId : (s.profiles.secondId ?? '')),
      (v) => void session.profiles.choose(i, v),
    );
    singerPicks.push(pick);
    const row = el('div', `settings-singer-${id}`, 'singer-row');
    kit.text(
      row,
      `Singer ${id.toUpperCase()} colour `,
      `settings-singer-${id}-colour`,
      'color',
      (s) => {
        const who = slotOf(s, i);
        return who ? shownColour(doc, s.profiles, who) : '#808080';
      },
      (v) => {
        const who = slotOf(store.state, i);
        if (who) session.profiles.setColour(who.id, v);
      },
    );
    kit.text(
      row,
      `Singer ${id.toUpperCase()} name `,
      `settings-singer-${id}-name`,
      'text',
      (s) => slotOf(s, i)?.name ?? s.duet.names[i],
      (v) => {
        const who = slotOf(store.state, i);
        if (who) session.profiles.rename(who.id, v);
      },
    );
    singers.append(row);
  };
  nameAndColour(0, 'a');
  kit.check(
    singers,
    'Second singer',
    'settings-second-singer',
    (s) => s.duet.secondSinger,
    (v) => session.duet.setSecondSinger(v),
  );
  nameAndColour(1, 'b');

  // ---- Library --------------------------------------------------------------
  const library = kit.section(host, 'Library', 'settings-library');
  kit.check(
    library,
    'Next song when one ends',
    'settings-auto-advance',
    (s) => s.library.autoAdvance,
    (v) => session.setAutoAdvance(v),
  );
  kit.check(
    library,
    'Get the melody for every YouTube song in learning mode (the first Play or Record asks to share the tab audio)',
    'settings-auto-reference',
    () => session.settings.autoReference,
    (v) => session.setAutoReference(v),
  );

  // ---- Search ---------------------------------------------------------------
  const search = kit.section(host, 'Search', 'settings-search');
  kit.select(
    search,
    'Provider ',
    'settings-provider',
    () => [['youtube', 'YouTube']],
    () => session.settings.searchProvider,
    () => undefined,
  );
  const keyField = kit.text(
    search,
    'YouTube API key ',
    'settings-search-key',
    'password',
    () => session.settings.youtubeApiKey,
    (v) => {
      if (!session.setSearchKey(v)) keyNote.textContent = 'That does not look like an API key.';
      else keyNote.textContent = v.trim() === '' ? 'Key removed.' : 'Key saved.';
    },
  );
  kit.check(search, 'Show the key', 'settings-search-key-show', () => keyField.type === 'text', (v) => {
    keyField.type = v ? 'text' : 'password';
  });
  const keyNote = el('p', 'settings-search-note', 'song-meta');
  search.append(keyNote);

  // ---- Service --------------------------------------------------------------
  const service = kit.section(host, 'Service', 'settings-service');
  kit.text(
    service,
    'Service address ',
    'settings-service-url',
    'text',
    () => session.settings.serviceUrl,
    (v) => {
      serviceNote.textContent = session.setServiceUrl(v)
        ? 'Address saved.'
        : 'That is not an http or https address.';
      kit.render(store.state);
    },
  );
  const serviceNote = el('p', 'settings-service-note', 'song-meta');
  kit.button(service, 'Test', 'settings-service-test', () => {
    serviceNote.textContent = 'Asking the service…';
    void session.testService().then((ok) => {
      serviceNote.textContent = ok
        ? 'The service answered.'
        : `Nothing answered at ${session.settings.serviceUrl}. See service/README.md to start it.`;
    });
  });
  service.append(serviceNote);

  // ---- Appearance -----------------------------------------------------------
  const look = kit.section(host, 'Appearance', 'settings-appearance');
  kit.select(look, 'Skin ', 'settings-skin', () => skin.choices, () => skin.current(), (v) => skin.set(v));
  kit.check(look, 'Hover help', 'settings-hover-help', (s) => s.hoverHelp, (v) => session.setHoverHelp(v));

  // ---- Reset, export, import ------------------------------------------------
  const tools = kit.section(host, 'All settings', 'settings-tools');
  const notice = el('p', 'settings-notice', 'song-meta');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const confirmRow = el('div', 'settings-reset-confirm', 'button-row');
  confirmRow.hidden = true;
  const confirmText = el('span', 'settings-reset-text', 'song-meta');
  confirmText.textContent = 'Put every setting back to its default? Takes, the library, lyrics and favorites stay.';
  confirmRow.append(confirmText);
  const resetButton = kit.button(tools, 'Reset all', 'settings-reset', () => {
    confirmRow.hidden = false;
    resetButton.hidden = true;
  });
  const endConfirm = (): void => {
    confirmRow.hidden = true;
    resetButton.hidden = false;
  };
  kit.button(confirmRow, 'Yes, reset', 'settings-reset-yes', () => {
    endConfirm();
    if (session.resetAllSettings()) {
      skin.set(skin.defaultId);
      layout?.reset();
      notice.textContent = 'Every setting is back to its default.';
    } else notice.textContent = 'Finish recording, calibrating or the Mic check first.';
  });
  kit.button(confirmRow, 'Cancel', 'settings-reset-no', endConfirm);
  tools.append(confirmRow);

  let includeKey = false;
  kit.check(tools, 'Include the search key in the export', 'settings-export-key', () => includeKey, (v) => {
    includeKey = v;
  });
  kit.button(tools, 'Export settings', 'settings-export', () => {
    download(session.exportSettings(skin.current(), includeKey, layout?.get()), SETTINGS_FILE_NAME);
    notice.textContent = includeKey ? 'Exported, with the search key.' : 'Exported, without the search key.';
  });
  const importFile = el('input', 'settings-import-file');
  importFile.type = 'file';
  importFile.accept = 'application/json,.json';
  importFile.hidden = true;
  kit.button(tools, 'Import settings', 'settings-import', () => importFile.click());
  on(importFile, 'change', () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file) return;
    void file
      .text()
      .then((text) => {
        const ids = skin.choices.map(([id]) => id);
        const outcome = session.importSettings(text, ids, skin.current(), layout?.get());
        if (outcome.skin !== null) skin.set(outcome.skin);
        if (outcome.layout !== null) layout?.set(outcome.layout);
        notice.textContent = outcome.message;
      })
      .catch(() => {
        notice.textContent = 'That file could not be read.';
      });
  });
  tools.append(importFile, notice);

  // ---- Open, close and redraw -----------------------------------------------
  function setOpen(open: boolean): void {
    host.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      // Both are drawers at the right edge; one at a time.
      session.setLibraryOpen(false);
      void session.refreshDevices();
      render(store.state);
    }
  }
  on(toggle, 'click', () => setOpen(host.hidden));

  function render(state: AppState): void {
    kit.render(state);
    const b = state.duet.secondSinger;
    bRow.hidden = !b;
    // Same rule as the inline controls: a take or a calibration is reading
    // the mic, and the Session refuses these changes too.
    const busy = state.recording || state.calibrating;
    inputPick.disabled = inputBPick.disabled = busy;
    // The Session refuses a singer change mid-take; a disabled pick cannot drift.
    for (const pick of singerPicks) pick.disabled = state.recording;
    outputPick.disabled = busy || !state.output.selectable;
    latencyField.disabled = embedField.disabled = busy;
    refresh.disabled = busy;
    for (const b of Array.from(monitor.children)) (b as HTMLButtonElement).disabled = busy;
    calibrate.disabled = busy || state.tracker === 'unsupported';
    micCheckButton.disabled = busy || isActivePhase(state.micCheck.phase) || state.tracker === 'unsupported';
    calibrate.textContent = state.calibrating ? 'Calibrating…' : 'Calibrate';
  }
  // Redrawing is cheap but the state ticks with every frame; only the keys a
  // control reads, or a save of the settings, redraw an open drawer.
  const WATCHED: ReadonlyArray<keyof AppState> = [
    'input',
    'output',
    'duet',
    'profiles',
    'latencyS',
    'embedOffsetS',
    'calibrating',
    'recording',
    'micCheck',
    'mode',
    'scoring',
    'noteGuide',
    'keyboard',
    'hoverHelp',
    'mix',
    'backing',
    'library',
    'settingsRev',
  ];
  cleanups.push(
    store.subscribe((state, changed) => {
      if (state.library.open && !host.hidden) setOpen(false);
      if (!host.hidden && WATCHED.some((k) => changed.has(k))) render(state);
    }),
  );
  cleanups.push(skin.onChange(() => !host.hidden && render(store.state)));
  cleanups.push(session.onDevices(() => !host.hidden && render(store.state)));

  host.hidden = true;
  render(store.state);

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    kit.dispose();
    host.replaceChildren();
  };
};
