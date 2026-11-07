/**
 * The singers panel: singer A's and singer B's names and ribbon colours, the
 * switch that turns singer B on, and, for B, a second input with its own
 * picker, level meter, mic state, latency and Calibrate. With B on and no
 * second mic open, the two share the one mic by turns (the note under the
 * switch says how the lane's strip is clicked); with a second mic open each
 * has a mic. The picker warns beside a Bluetooth Hands-Free mic. Built once
 * and updated from `state.duet` and `state.singers`; the controller in
 * src/duet does the work.
 */
import { HANDS_FREE_WARNING, isHandsFreeLabel } from '../../duet/hands-free';
import type { SingerIndex } from '../../duet/settings';
import type { Session } from '../session';
import type { AppState, StateStore } from '../state';
import { meterFraction } from '../state';
import { describeMicHealth } from './mic-health';
import type { MountPanel } from './panel';

/** What the panel needs: the state, and the duet's intents and devices. */
export interface SingersPanelDeps {
  store: StateStore;
  session: Pick<Session, 'duet' | 'deviceLists' | 'onDevices' | 'refreshDevices'>;
}

/** Said under the switch while B shares the one mic. */
export const TURNS_NOTE =
  'One mic, two singers: take turns. Click a stretch in the strip along the top of the lane to change who sings it: A, B, then both.';
/** Said under the switch while B has a mic of their own. */
export const TWO_MICS_NOTE = 'Each singer has a mic. Both sing the whole song; each gets their own card.';

/** What the turns follow, in words. */
export function turnSourceLine(source: AppState['duet']['turnSource']): string {
  if (source === 'lyrics') return 'Turns follow the lyric lines.';
  if (source === 'phrases') return 'Turns follow the phrases of the melody.';
  return 'Turns appear once the song has a melody or synced lyrics.';
}

const DEFAULT_VALUE = '@default';

/** The skin's colour for a singer when it is a plain hex, else a neutral grey. */
function skinColour(doc: Document, token: string, fallback: string): string {
  const view = doc.defaultView;
  const value = view ? view.getComputedStyle(doc.documentElement).getPropertyValue(token).trim() : '';
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

/** Builds the panel into `host`; the returned function takes it down. */
export const mountSingersPanel: MountPanel<SingersPanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const { duet } = session;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.dataset.testid = testid;
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(text: string, testid: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', testid, '', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /** A singer's row: colour swatch and name. */
  function singerRow(singer: SingerIndex): { row: HTMLElement; name: HTMLInputElement; colour: HTMLInputElement } {
    const id = singer === 0 ? 'a' : 'b';
    const row = el('div', `singer-${id}-row`, 'singer-row');
    const colour = el('input', `singer-${id}-colour`);
    colour.type = 'color';
    colour.setAttribute('aria-label', `Singer ${id.toUpperCase()} colour`);
    colour.addEventListener('change', () => duet.setColour(singer, colour.value));
    const name = el('input', `singer-${id}-name`);
    name.type = 'text';
    name.maxLength = 16;
    name.setAttribute('aria-label', `Singer ${id.toUpperCase()} name`);
    name.addEventListener('change', () => duet.setName(singer, name.value));
    row.append(colour, name);
    return { row, name, colour };
  }

  const title = el('h3', 'singers-title', 'group-title', 'Singers');
  const a = singerRow(0);
  const toggleLabel = doc.createElement('label');
  toggleLabel.className = 'field singer-toggle';
  const toggle = el('input', 'singer-b-on');
  toggle.type = 'checkbox';
  toggle.addEventListener('change', () => duet.setSecondSinger(toggle.checked));
  toggleLabel.append(toggle, ' Second singer');
  const b = singerRow(1);
  const note = el('p', 'singers-note', 'song-meta');
  const turnsLine = el('p', 'singers-turns', 'song-meta');

  // Singer B's input, in the same order as the Devices group.
  const pick = el('select', 'singer-b-input');
  pick.setAttribute('aria-label', 'Singer B microphone');
  pick.addEventListener('change', () => {
    if (pick.value === '') return;
    void duet.chooseSecondInput(pick.value === DEFAULT_VALUE ? null : pick.value);
  });
  const warning = el('p', 'singer-b-hands-free', 'song-meta', HANDS_FREE_WARNING);
  warning.dataset.kind = 'warn';
  const meter = el('div', 'singer-b-meter', 'meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Singer B microphone level');
  const fill = doc.createElement('div');
  fill.className = 'meter-fill';
  meter.append(fill);
  const state = el('div', 'singer-b-state', 'song-meta mic-state');
  const latency = el('input', 'singer-b-latency');
  latency.type = 'number';
  latency.min = '0';
  latency.max = '2000';
  latency.step = '1';
  latency.placeholder = 'ms';
  latency.setAttribute('aria-label', 'Singer B latency in milliseconds');
  latency.addEventListener('change', () => {
    duet.setSecondLatency(latency.value === '' ? null : Number(latency.value) / 1000);
  });
  const calibrate = button('Calibrate', 'singer-b-calibrate', () => void duet.calibrateSecond());
  const close = button('Close second mic', 'singer-b-close', () => duet.closeSecondInput());
  const micRow = el('div', 'singer-b-mic', 'singer-b-mic');
  micRow.append(
    el('label', 'singer-b-input-label', 'field', 'Second microphone'),
    pick,
    warning,
    meter,
    state,
    el('label', 'singer-b-latency-label', 'field', 'Latency'),
    latency,
    el('div', 'singer-b-buttons', 'button-row'),
  );
  (micRow.lastElementChild as HTMLElement).append(calibrate, close);
  host.append(title, a.row, toggleLabel, b.row, note, turnsLine, micRow);

  function renderPicker(app: AppState): void {
    const want = app.duet.deviceIdB ?? (app.singers[1]?.input.open ? DEFAULT_VALUE : '');
    pick.replaceChildren();
    const first = doc.createElement('option');
    first.value = '';
    first.textContent = 'Choose a second microphone…';
    first.disabled = true;
    const system = doc.createElement('option');
    system.value = DEFAULT_VALUE;
    system.textContent = 'System default';
    pick.append(first, system);
    session.deviceLists.inputs.forEach((d, i) => {
      if (!d.deviceId) return;
      const o = doc.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
      pick.append(o);
    });
    pick.value = [...pick.options].some((o) => o.value === want) ? want : '';
    const label = pick.selectedOptions[0]?.textContent ?? '';
    warning.hidden = !isHandsFreeLabel(label);
  }

  let pickerKey = '';
  function render(app: AppState): void {
    const d = app.duet;
    if (doc.activeElement !== a.name) a.name.value = d.names[0];
    if (doc.activeElement !== b.name) b.name.value = d.names[1];
    a.colour.value = d.colours[0] ?? skinColour(doc, '--color-singer-a', '#7a7a7a');
    b.colour.value = d.colours[1] ?? skinColour(doc, '--color-singer-b', '#a8a8a8');
    toggle.checked = d.secondSinger;
    b.row.hidden = !d.secondSinger;
    note.hidden = !d.secondSinger;
    note.textContent = d.kind === 'two-mics' ? TWO_MICS_NOTE : TURNS_NOTE;
    turnsLine.hidden = d.kind !== 'one-mic';
    turnsLine.textContent = turnSourceLine(d.turnSource);
    micRow.hidden = !d.secondSinger;
    host.dataset.kind = d.kind;
    const input = app.singers[1]?.input;
    const key = `${d.deviceIdB}|${input?.open ?? false}|${input?.label ?? ''}`;
    if (key !== pickerKey) {
      pickerKey = key;
      renderPicker(app);
    }
    const open = input?.open === true;
    fill.style.width = `${(meterFraction(open ? input.level : 0) * 100).toFixed(1)}%`;
    const health = input ? describeMicHealth(input) : null;
    state.textContent = health?.state ?? '';
    state.hidden = !health || health.state === '';
    if (doc.activeElement !== latency) latency.value = d.latencyBS === null ? '' : String(Math.round(d.latencyBS * 1000));
    calibrate.disabled = !open || d.calibratingB || app.calibrating || app.recording;
    close.hidden = !open;
    close.disabled = app.recording;
  }

  const cleanups: Array<() => void> = [];
  cleanups.push(
    store.subscribe((app, changed) => {
      if (changed.has('duet') || changed.has('singers') || changed.has('recording') || changed.has('calibrating')) {
        render(app);
      }
    }),
  );
  // The device list arrives after the page does, and changes as devices come and go.
  cleanups.push(
    session.onDevices(() => {
      pickerKey = '';
      render(store.state);
    }),
  );
  render(store.state);

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.replaceChildren();
  };
};
