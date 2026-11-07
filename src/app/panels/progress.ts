/**
 * The Progress panel, learning mode's: a button in the header opens it, a
 * picker chooses one song or all songs, and each measure gets a small
 * sparkline over the takes with its best, latest and change since the first
 * week as plain numbers, a line on what its direction means, and an honest
 * line on the trend (which says so when there are few takes). It reads take
 * summaries only, through the Session's `listAllTakes`, and keeps what it
 * loaded and reloads only when the takes change (a take added or removed),
 * on open if that happened while closed; a song change redraws from the cache. Karaoke mode hides the button and closes the
 * panel, so nothing of it shows there. The words and rows come from
 * app/progress.ts, the series from analysis/progress.ts.
 */
import { takePoints } from '../../analysis/progress';
import type { TakePoint } from '../../analysis/progress';
import { sparklineSvg } from '../../render/sparkline';
import { ALL_SONGS, defaultSong, progressRows, songChoices } from '../progress';
import type { ProgressRow } from '../progress';
import type { Session } from '../session';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to read, the one intent, the header button. */
export interface ProgressPanelDeps {
  store: StateStore;
  session: Pick<Session, 'listAllTakes'>;
  toggle: HTMLButtonElement;
}

/** One measure's row as elements. */
function drawRow(doc: Document, row: ProgressRow): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'progress-row';
  el.dataset.testid = 'progress-row';
  el.dataset.measure = row.key;
  const title = doc.createElement('h4');
  title.textContent = row.qualifier === null ? row.label : `${row.label} (${row.qualifier})`;
  const spark = doc.createElement('div');
  spark.className = 'progress-spark';
  spark.dataset.testid = 'progress-spark';
  spark.dataset.points = String(row.values.length);
  spark.innerHTML = sparklineSvg(row.values, 120, 32, `${row.label}, ${row.values.length} takes`);
  const numbers = doc.createElement('p');
  numbers.className = 'progress-numbers';
  numbers.dataset.testid = 'progress-numbers';
  const parts = [`Latest ${row.latest}`];
  if (row.best !== null) parts.push(`best ${row.best}`);
  if (row.baseline !== null) parts.push(`first week ${row.baseline}`);
  parts.push(row.change === null ? 'change since first week: none yet' : `change since first week ${row.change}`);
  numbers.textContent = parts.join(', ');
  const meaning = doc.createElement('p');
  meaning.className = 'progress-note';
  meaning.textContent = row.meaning;
  const trend = doc.createElement('p');
  trend.className = 'progress-note';
  trend.dataset.testid = 'progress-trend';
  trend.textContent = row.trend;
  el.append(title, spark, numbers, meaning, trend);
  return el;
}

/** Builds the panel into `host` and wires `toggle`; the returned function undoes both. */
export const mountProgressPanel: MountPanel<ProgressPanelDeps> = (host, { store, session, toggle }) => {
  const doc = host.ownerDocument;
  let open = false;
  let points: TakePoint[] = [];
  /** The picker's value; null until the singer picks, then theirs. */
  let chosen: string | null = null;
  let loading = 0;
  /** True until the cached points match the stored takes. */
  let stale = true;

  const title = doc.createElement('h3');
  title.className = 'group-title';
  title.textContent = 'Progress';
  const picker = doc.createElement('select');
  picker.dataset.testid = 'progress-song';
  picker.setAttribute('aria-label', 'Song');
  const count = doc.createElement('p');
  count.className = 'progress-note';
  count.dataset.testid = 'progress-count';
  const list = doc.createElement('div');
  list.className = 'progress-list';
  host.append(title, picker, count, list);

  const currentHash = (): string | null => store.state.song?.hash ?? null;
  const selected = (): string => {
    const wanted = chosen ?? defaultSong(points, currentHash());
    return wanted === ALL_SONGS || points.some((p) => p.songHash === wanted) ? wanted : ALL_SONGS;
  };

  const draw = (): void => {
    const value = selected();
    const choices = songChoices(points, currentHash());
    picker.replaceChildren(
      ...choices.map((c) => {
        const option = doc.createElement('option');
        option.value = c.value;
        option.textContent = c.label;
        return option;
      }),
    );
    picker.value = value;
    const rows = progressRows(points, value === ALL_SONGS ? null : value);
    const takes = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.takes));
    count.textContent =
      points.length === 0
        ? 'No learning takes yet. Record a take in learning mode and it shows up here.'
        : `${takes} ${takes === 1 ? 'take' : 'takes'} measured here. Mic check takes are left out.`;
    list.replaceChildren(...rows.map((r) => drawRow(doc, r)));
  };

  const load = async (): Promise<void> => {
    const ticket = ++loading;
    try {
      const summaries = await session.listAllTakes();
      if (ticket !== loading) return;
      points = takePoints(summaries);
      stale = false;
    } catch {
      if (ticket !== loading) return;
      points = [];
    }
    draw();
  };

  const render = (): void => {
    const learning = store.state.mode === 'learning';
    toggle.hidden = !learning;
    if (!learning) open = false;
    toggle.setAttribute('aria-expanded', String(open));
    host.hidden = !open;
  };

  const onToggle = (): void => {
    open = !open;
    render();
    if (open && stale) void load();
    else if (open) draw();
  };
  const onPick = (): void => {
    chosen = picker.value;
    draw();
  };
  toggle.addEventListener('click', onToggle);
  picker.addEventListener('change', onPick);

  const unsubscribe = store.subscribe((_state, changed) => {
    if (changed.has('mode')) render();
    if (changed.has('takes')) stale = true;
    if (!open) return;
    if (stale) void load();
    else if (changed.has('song')) draw();
  });
  render();

  return () => {
    loading++;
    unsubscribe();
    toggle.removeEventListener('click', onToggle);
    picker.removeEventListener('change', onPick);
    host.replaceChildren();
  };
};
