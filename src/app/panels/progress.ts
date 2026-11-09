/**
 * The Progress drawer, learning mode's: a button in the header opens a panel
 * that slides over the lane from the right (it never reflows the page) and
 * closes with its x button, the Escape key or a press outside it; focus moves
 * into it and comes back to the button. It shows the active singer's progress
 * and says whose in its title, so a different singer chosen in the header or
 * the Singers panel redraws it at once. A picker chooses one song or all songs,
 * and each measure gets a small sparkline over the takes with its best, latest
 * and change since the first week as plain numbers, a line on what its
 * direction means, and an honest line on the trend (which says so when there
 * are few takes). It reads take summaries only, through the Session's
 * `listAllTakes`, keeps what it loaded and reloads only when the takes or the
 * active singer change, on open if that happened while closed; a song change
 * redraws from the cache. Karaoke mode hides the button and closes the drawer,
 * so nothing of it shows there. The words and rows come from app/progress.ts,
 * the series from analysis/progress.ts, the per-singer reading of takes from
 * app/profiles.ts, the dismissing from app/drawer.ts.
 */
import { takePoints } from '../../analysis/progress';
import type { TakePoint } from '../../analysis/progress';
import { sparklineSvg } from '../../render/sparkline';
import { attachDismiss } from '../drawer';
import { activeProfile, takesOfProfile } from '../profiles';
import { ALL_SONGS, defaultSong, progressRows, songChoices } from '../progress';
import type { ProgressRow } from '../progress';
import type { Session } from '../session';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to read, the intents, the header buttons. */
export interface ProgressPanelDeps {
  store: StateStore;
  session: Pick<Session, 'listAllTakes' | 'setLibraryOpen'>;
  toggle: HTMLButtonElement;
  /** The Settings button: that drawer sits in the same place, one at a time. */
  settingsToggle: HTMLButtonElement;
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

/** Builds the drawer into `host` and wires `toggle`; the returned function undoes both. */
export const mountProgressPanel: MountPanel<ProgressPanelDeps> = (host, { store, session, toggle, settingsToggle }) => {
  const doc = host.ownerDocument;
  let open = false;
  let points: TakePoint[] = [];
  /** The picker's value; null until the singer picks, then theirs. */
  let chosen: string | null = null;
  let loading = 0;
  /** True until the cached points match the stored takes and the active singer. */
  let stale = true;
  let shownFor = store.state.profiles.activeId;
  /** True while another singer's takes are being read, so nothing old shows. */
  let switching = true;

  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-labelledby', 'progress-title');
  host.tabIndex = -1;
  const head = doc.createElement('div');
  head.className = 'library-head';
  const title = doc.createElement('h2');
  title.id = 'progress-title';
  title.className = 'panel-title';
  title.dataset.testid = 'progress-title';
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.className = 'drawer-close';
  close.dataset.testid = 'progress-close';
  close.setAttribute('aria-label', 'Close Progress');
  close.dataset.help = 'Close (Esc)';
  head.append(title, close);
  const picker = doc.createElement('select');
  picker.dataset.testid = 'progress-song';
  picker.setAttribute('aria-label', 'Song');
  const count = doc.createElement('p');
  count.className = 'progress-note';
  count.dataset.testid = 'progress-count';
  const list = doc.createElement('div');
  list.className = 'progress-list';
  host.append(head, picker, count, list);

  const singer = (): string => activeProfile(store.state.profiles).name;
  const currentHash = (): string | null => store.state.song?.hash ?? null;
  const selected = (): string => {
    const wanted = chosen ?? defaultSong(points, currentHash());
    return wanted === ALL_SONGS || points.some((p) => p.songHash === wanted) ? wanted : ALL_SONGS;
  };

  const draw = (): void => {
    title.textContent = `Progress: ${singer()}`;
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
    const rows = switching ? [] : progressRows(points, value === ALL_SONGS ? null : value);
    const takes = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.takes));
    count.textContent = switching
      ? `Reading ${singer()}'s takes…`
      : points.length === 0
        ? `No learning takes for ${singer()} yet. Record a take in learning mode and it shows up here.`
        : `${takes} ${takes === 1 ? 'take' : 'takes'} measured here. Mic check takes are left out.`;
    list.replaceChildren(...rows.map((r) => drawRow(doc, r)));
  };

  const load = async (): Promise<void> => {
    const ticket = ++loading;
    const { activeId, legacyId } = store.state.profiles;
    try {
      const summaries = await session.listAllTakes();
      // A singer switched while the drawer was closed starts no new load; this
      // one is for someone else, so what the subscriber marked stale stays so.
      if (ticket !== loading || store.state.profiles.activeId !== activeId) return;
      points = takePoints(takesOfProfile(summaries, activeId, legacyId));
      shownFor = activeId;
      switching = false;
      stale = false;
    } catch {
      if (ticket !== loading || store.state.profiles.activeId !== activeId) return;
      points = [];
      switching = false;
    }
    draw();
  };

  function render(): void {
    const learning = store.state.mode === 'learning';
    toggle.hidden = !learning;
    if (!learning) open = false;
    toggle.setAttribute('aria-expanded', String(open));
    host.hidden = !open;
  }

  const setOpen = (next: boolean, restoreFocus = false): void => {
    if (next === open) return;
    open = next;
    render();
    if (open) {
      // The Library and Settings drawers sit in the same place; one at a time.
      session.setLibraryOpen(false);
      if (settingsToggle.getAttribute('aria-expanded') === 'true') settingsToggle.click();
      draw();
      if (stale) void load();
      close.focus();
    } else if (restoreFocus) toggle.focus();
  };

  const onToggle = (): void => setOpen(!open, false);
  const onClose = (): void => setOpen(false, true);
  const onPick = (): void => {
    chosen = picker.value;
    draw();
  };
  toggle.addEventListener('click', onToggle);
  close.addEventListener('click', onClose);
  picker.addEventListener('change', onPick);
  // Settings opening by keyboard fires no press outside, so watch the button's
  // state instead; the observer is the same whichever mounted first.
  const View = doc.defaultView;
  const watcher = View
    ? new View.MutationObserver(() => {
        if (open && settingsToggle.getAttribute('aria-expanded') === 'true') setOpen(false);
      })
    : null;
  watcher?.observe(settingsToggle, { attributes: true, attributeFilter: ['aria-expanded'] });
  const detach = attachDismiss(doc, {
    isOpen: () => open,
    close: (restoreFocus) => setOpen(false, restoreFocus),
    // Anything marked keep-drawer (the singer pickers, the profile dialog) is
    // part of working with this drawer, so pressing there does not close it.
    inside: () => [host, toggle, ...Array.from(doc.querySelectorAll<HTMLElement>('[data-keep-drawer]'))],
  });

  const unsubscribe = store.subscribe((state, changed) => {
    if (changed.has('mode')) render();
    if (changed.has('takes')) stale = true;
    if (changed.has('profiles') && state.profiles.activeId !== shownFor) {
      stale = true;
      switching = true;
      points = [];
      chosen = null;
    }
    // The Library drawer opening takes this place.
    if (changed.has('library') && state.library.open && open) setOpen(false);
    if (!open) return;
    if (changed.has('profiles')) draw();
    if (stale) void load();
    else if (changed.has('song')) draw();
  });
  render();

  return () => {
    loading++;
    unsubscribe();
    detach();
    watcher?.disconnect();
    toggle.removeEventListener('click', onToggle);
    close.removeEventListener('click', onClose);
    picker.removeEventListener('change', onPick);
    host.replaceChildren();
  };
};
