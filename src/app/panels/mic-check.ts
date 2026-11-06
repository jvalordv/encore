/**
 * The Mic check panel: a choice of voice range and a Start button, then one
 * prompt at a time with a countdown and the live meter, then a card with the
 * findings, a table of current and recommended values, and the buttons that
 * apply them. It speaks about the mic and the room only and never grades the
 * singing, so it shows in either practice mode. With the service away the
 * steps still run; the card then says the advice needs it and offers Save WAV
 * and Save JSON. Drawn from `state.micCheck` and `state.input`; the words and
 * the table rows come from pure functions, tested in
 * test/mic-check-panel.test.ts.
 */
import type { MelodyRange, SectionLabel } from '../../analysis/test-melody';
import type { AnalysedSection, SectionVerdict, TakeAnalysis, TuningValues } from '../../service/types';
import { downloadBlob } from '../download';
import { isActivePhase, PAIR_CHANGED, STEP_HINTS, STEP_PROMPTS, TIMED_PHASES } from '../mic-check';
import type { Session } from '../session';
import { meterFraction } from '../state';
import type { AppState, StateStore } from '../state';
import type { TakeFileKind } from '../take-export';
import { describeMicHealth } from './mic-health';
import type { MountPanel } from './panel';

/** One line of the table of current and recommended values. */
export interface TuningRow {
  label: string;
  current: string;
  /** The value on offer, or null when the current one stays. */
  recommended: string | null;
}

/** Plain names of the stretches, for the verdict list. */
const SECTION_NAMES: Record<SectionLabel, string> = {
  quiet: 'Quiet room',
  speakers: 'Speakers only',
  'sing-along': 'Singing along',
  'sing-alone': 'Singing alone',
};

/** What a verdict means for the mic, in plain words. */
const VERDICT_WORDS: Record<SectionVerdict, string> = {
  silence: 'Quiet, as it should be',
  singer: 'Your voice came through',
  likely_bleed: 'The melody reached the mic through the speakers',
  unclear: 'Could not tell',
};

/** The words for a stretch of the check and what the service found in it. */
export function describeSection(section: AnalysedSection): { name: string; verdict: string } {
  const name = SECTION_NAMES[section.label as SectionLabel] ?? section.label;
  return { name, verdict: VERDICT_WORDS[section.verdict] ?? 'Could not tell' };
}

interface RowSpec {
  key: keyof TuningValues;
  label: string;
  format: (value: number) => string;
}

const ROWS: readonly RowSpec[] = [
  { key: 'draw_margin_db', label: 'Voice level above room noise', format: (v) => `${v.toFixed(1)} dB` },
  { key: 'clarity_threshold', label: 'Pitch clarity needed', format: (v) => v.toFixed(2) },
  { key: 'bleed_match_cents', label: 'Echo match window', format: (v) => `${Math.round(v)} cents` },
  { key: 'bleed_min_match', label: 'Share that must match', format: (v) => `${Math.round(v * 100)}%` },
  { key: 'bleed_max_median_cents', label: 'Echo error limit', format: (v) => `${Math.round(v)} cents` },
  { key: 'latency_s', label: 'Latency', format: (v) => `${Math.round(v * 1000)} ms` },
];

/** The rows that have a recommendation, current value beside it. */
export function tuningRows(analysis: TakeAnalysis): TuningRow[] {
  const rows: TuningRow[] = [];
  for (const { key, label, format } of ROWS) {
    const offer = analysis.recommended[key];
    if (offer === null || offer === undefined) continue;
    const current = analysis.current[key];
    rows.push({ label, current: current === null ? 'not set' : format(current), recommended: format(offer) });
  }
  return rows;
}

/** What the panel needs: the state to draw, the intents, the toggle button. */
export interface MicCheckPanelDeps {
  store: StateStore;
  session: Pick<
    Session,
    'startMicCheck' | 'cancelMicCheck' | 'closeMicCheck' | 'applyMicCheck' | 'resetMicTuning' | 'exportTake'
  >;
  /** The button beside Calibrate; it opens the panel. */
  toggle: HTMLButtonElement;
}

/** Builds the panel into `host`; the returned function takes it down. */
export const mountMicCheckPanel: MountPanel<MicCheckPanelDeps> = (host, { store, session, toggle }) => {
  const doc = host.ownerDocument;
  let open = false;
  let range: MelodyRange = 'low';

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = '',
    testid = '',
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    if (testid) node.dataset.testid = testid;
    return node;
  };
  const button = (text: string, testid: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', '', text, testid);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const lines = (items: readonly string[], testid: string): HTMLElement => {
    const list = el('ul', 'mic-check-lines', '', testid);
    for (const text of items) list.append(el('li', '', text));
    return list;
  };
  const save = (takeId: string, kind: TakeFileKind): (() => void) => () => {
    void session.exportTake(takeId, kind).then((file) => {
      if (file) downloadBlob(doc, file.blob, file.name);
    });
  };
  const saveButtons = (takeId: string): HTMLElement[] => [
    button('Save WAV', 'mic-check-save-wav', save(takeId, 'wav')),
    button('Save JSON', 'mic-check-save-json', save(takeId, 'json')),
  ];

  const row = (...buttons: HTMLElement[]): HTMLElement => {
    const box = el('div', 'button-row', '', 'mic-check-actions');
    box.append(...buttons);
    return box;
  };
  let liveFill: HTMLElement | null = null;
  let liveState: HTMLElement | null = null;

  function intro(): HTMLElement[] {
    const choice = el('div', 'segmented', '', 'mic-check-range');
    choice.setAttribute('role', 'group');
    choice.setAttribute('aria-label', 'Voice range');
    for (const [value, text] of [
      ['low', 'Lower voice'],
      ['high', 'Higher voice'],
    ] as const) {
      const b = button(text, `mic-check-range-${value}`, () => {
        range = value;
        render(store.state);
      });
      b.setAttribute('aria-pressed', String(range === value));
      choice.append(b);
    }
    const start = button('Start', 'mic-check-start', () => void session.startMicCheck(range));
    const close = button('Close', 'mic-check-dismiss', () => {
      open = false;
      render(store.state);
    });
    return [
      el(
        'p',
        '',
        'About 40 seconds. It measures your room and your mic, not your singing: stay quiet, ' +
          'then sing along with a test melody. Use a comfortable voice range.',
      ),
      choice,
      row(start, close),
    ];
  }

  /** Moves the live meter and the line under it without rebuilding the panel. */
  function updateLive(state: AppState): void {
    if (liveFill) liveFill.style.width = `${(meterFraction(state.input.level) * 100).toFixed(1)}%`;
    if (liveState) liveState.textContent = describeMicHealth(state.input).state;
  }

  function running(state: AppState): HTMLElement[] {
    const { micCheck } = state;
    const label = micCheck.phase as SectionLabel;
    const meter = el('div', 'meter', '', 'mic-check-meter');
    liveFill = el('div', 'meter-fill');
    meter.append(liveFill);
    liveState = el('div', 'song-meta', '', 'mic-check-state');
    updateLive(state);
    const out: HTMLElement[] = [];
    if (TIMED_PHASES.includes(micCheck.phase)) {
      out.push(
        el('h4', 'mic-check-prompt', STEP_PROMPTS[label], 'mic-check-prompt'),
        el('p', 'song-meta', STEP_HINTS[label]),
        el('div', 'mic-check-countdown', `${micCheck.stepLeftS} s`, 'mic-check-countdown'),
        meter,
        liveState,
      );
    } else {
      out.push(el('p', '', 'Analysing your recording…', 'mic-check-analysing'));
    }
    out.push(row(button('Cancel', 'mic-check-cancel', () => session.cancelMicCheck())));
    return out;
  }

  function result(state: AppState): HTMLElement[] {
    const { analysis, takeId, applied, pairChanged } = state.micCheck;
    if (!analysis) return [];
    const out: HTMLElement[] = [];
    out.push(el('h4', 'mic-check-prompt', 'Mic check result', 'mic-check-title'));
    if (analysis.findings.length > 0) out.push(lines(analysis.findings, 'mic-check-findings'));
    if (analysis.sections.length > 0) {
      const list = el('ul', 'mic-check-lines', '', 'mic-check-sections');
      for (const section of analysis.sections) {
        const { name, verdict } = describeSection(section);
        list.append(el('li', '', `${name}: ${verdict}`));
      }
      out.push(list);
    }
    const rows = tuningRows(analysis);
    if (rows.length === 0) {
      out.push(el('p', '', 'Your current settings already suit this mic and room.', 'mic-check-nochange'));
    } else {
      const table = el('table', 'mic-check-table', '', 'mic-check-table');
      for (const row of rows) {
        const tr = el('tr');
        tr.append(el('th', '', row.label), el('td', '', `${row.current} → ${row.recommended}`));
        table.append(tr);
      }
      out.push(table);
    }
    if (analysis.notes.length > 0) out.push(lines(analysis.notes, 'mic-check-notes'));
    const apply = button(applied ? 'Settings in use' : 'Use these settings', 'mic-check-apply', () =>
      session.applyMicCheck(),
    );
    apply.disabled = rows.length === 0 || applied || pairChanged;
    if (pairChanged) out.push(el('p', '', PAIR_CHANGED, 'mic-check-pair-changed'));
    out.push(
      row(apply, button('Reset to defaults', 'mic-check-reset', () => session.resetMicTuning())),
      row(...(takeId ? saveButtons(takeId) : []), button('Close', 'mic-check-close', () => session.closeMicCheck())),
    );
    return out;
  }

  function stopped(state: AppState): HTMLElement[] {
    const { message, needsService, takeId } = state.micCheck;
    const out: HTMLElement[] = [el('p', '', message ?? 'The Mic check stopped.', 'mic-check-message')];
    if (needsService) out.push(el('p', 'song-meta', 'The steps ran and the recording is kept.'));
    if (takeId) out.push(row(...saveButtons(takeId)));
    out.push(
      row(
        button('Try again', 'mic-check-again', () => void session.startMicCheck(state.micCheck.range)),
        button('Close', 'mic-check-close', () => session.closeMicCheck()),
      ),
    );
    return out;
  }

  function render(state: AppState): void {
    const { phase } = state.micCheck;
    // Once a check has begun the phase owns the panel; closing its card
    // returns to a hidden panel, not back to the intro.
    if (phase !== 'idle') open = false;
    const busy = state.recording || state.calibrating || isActivePhase(phase);
    toggle.disabled = busy || state.tracker === 'unsupported';
    toggle.setAttribute('aria-expanded', String(open || phase !== 'idle'));
    const shown = open || phase !== 'idle';
    host.hidden = !shown;
    host.dataset.phase = phase;
    if (!shown) {
      host.replaceChildren();
      return;
    }
    const title = el('h3', 'group-title', 'Mic check');
    liveFill = liveState = null;
    let body: HTMLElement[];
    if (phase === 'idle') body = intro();
    else if (isActivePhase(phase)) body = running(state);
    else if (phase === 'result') body = result(state);
    else body = stopped(state);
    host.replaceChildren(title, ...body);
  }

  const onToggle = (): void => {
    open = !open;
    render(store.state);
  };
  toggle.addEventListener('click', onToggle);
  const unsubscribe = store.subscribe((state, changed) => {
    if (changed.has('micCheck') || changed.has('recording') || changed.has('calibrating') || changed.has('tracker')) {
      render(state);
    } else if (changed.has('input')) {
      updateLive(state);
    }
  });
  render(store.state);

  return () => {
    unsubscribe();
    toggle.removeEventListener('click', onToggle);
    host.replaceChildren();
  };
};
