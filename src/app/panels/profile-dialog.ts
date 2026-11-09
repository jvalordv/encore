/**
 * The in-app dialogs about singer profiles, drawn from `state.profileDialog`
 * (never window.confirm or alert, which block the page): "New singer" (a name,
 * then Create) and "Manage singers" (a row per singer with a colour, a name to
 * Rename in place and Delete). Delete does not act at once: it asks, naming
 * what goes (that singer's takes, progress, streak, bests and range), that it
 * cannot be undone, and offers the buttons "Delete <name> and N takes", "Delete
 * <name>, keep N takes" (the takes stay, marked as no singer's) and Cancel; a
 * singer with no takes gets just "Delete <name>" and Cancel.
 * The last singer cannot be deleted. The dialog traps Tab, closes with Escape
 * (first Escape cancels a pending delete), the x and a press on the backdrop,
 * moves focus in on open and gives it back to what had it on close.
 */
import { defaultName, profileById } from '../profiles';
import type { Profile, ProfilesData } from '../profiles';
import type { Session } from '../session';
import type { ProfileDialog, StateStore } from '../state';
import type { MountPanel } from './panel';
import { shownColour } from './profile-select';

/** What the dialog needs: the state to draw and the profile intents. */
export interface ProfileDialogDeps {
  store: StateStore;
  session: Pick<Session, 'profiles'>;
}

/** "1 take" or "12 takes". */
function takesOf(n: number): string {
  return `${n} ${n === 1 ? 'take' : 'takes'}`;
}

/** "Delete Sam and 12 takes" (just "Delete Sam" with none): deletes the recordings too. */
export function deleteLabel(name: string, takes: number): string {
  return takes === 0 ? `Delete ${name}` : `Delete ${name} and ${takesOf(takes)}`;
}

/** "Delete Sam, keep 12 takes": the singer goes, the recordings stay as No singer. */
export function keepLabel(name: string, takes: number): string {
  return `Delete ${name}, keep ${takesOf(takes)}`;
}

/** The sentence saying what each choice does, with the count. */
export function deleteWarning(name: string, takes: number): string {
  if (takes === 0) {
    return `This deletes ${name} and ${name}'s progress, streak, personal bests and range. It cannot be undone.`;
  }
  return (
    `"${deleteLabel(name, takes)}" also deletes the ${takesOf(takes)} (recordings), and with them ${name}'s ` +
    `progress, streak, personal bests and range. "${keepLabel(name, takes)}" deletes only ${name}: the ` +
    `${takes === 1 ? 'take stays' : 'takes stay'} under All singers as No singer and count toward nobody's ` +
    `progress, streak, stars, bests or range. Deleting a singer cannot be undone.`
  );
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled])';

/** Builds the dialog into `host` (a backdrop element); the returned function takes it down. */
export const mountProfileDialog: MountPanel<ProfileDialogDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const profiles = session.profiles;
  let returnFocus: HTMLElement | null = null;
  let shown: ProfileDialog | null = null;
  /** The singer whose delete is waiting for its confirming press, and the count. */
  let confirming: { id: string; takes: number | null } | null = null;
  let note = '';
  /** The row whose delete was last asked for, so Cancel can hand focus back. */
  let lastConfirmed: string | null = null;

  host.classList.add('dialog-backdrop');
  host.dataset.keepDrawer = '';
  const box = doc.createElement('div');
  box.className = 'dialog';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'profile-dialog-title');
  box.dataset.testid = 'profile-dialog';
  host.append(box);

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (testid) node.dataset.testid = testid;
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(text: string, testid: string, onClick: () => void, className = ''): HTMLButtonElement {
    const b = el('button', testid, className, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  const close = (): void => profiles.setDialog(null);

  function head(title: string): HTMLElement {
    const row = el('div', '', 'dialog-head');
    const h = el('h2', 'profile-dialog-title', 'panel-title', title);
    h.id = 'profile-dialog-title';
    const x = button('×', 'profile-dialog-close', close, 'drawer-close');
    x.setAttribute('aria-label', 'Close');
    row.append(h, x);
    return row;
  }

  function noteLine(): HTMLElement {
    const p = el('p', 'profile-dialog-note', 'song-meta', note);
    p.setAttribute('role', 'status');
    p.hidden = note === '';
    return p;
  }

  function drawNew(slot: 0 | 1, data: ProfilesData): void {
    const input = el('input', 'profile-new-name');
    input.type = 'text';
    input.maxLength = 16;
    input.value = defaultName(data.list);
    input.setAttribute('aria-label', 'Name of the new singer');
    const create = (): void => {
      const problem = profiles.create(input.value, slot);
      if (problem === null) {
        note = '';
        close();
      } else {
        note = problem;
        noteText.textContent = note;
        noteText.hidden = false;
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        create();
      }
    });
    const noteText = noteLine();
    const who = slot === 0 ? 'They will be the active singer.' : 'They will be the second singer.';
    const buttons = el('div', '', 'button-row');
    buttons.append(button('Create singer', 'profile-new-create', create), button('Cancel', 'profile-new-cancel', close));
    box.replaceChildren(
      head('New singer'),
      el('p', '', 'song-meta', `Each singer keeps their own progress, streak and takes. ${who}`),
      input,
      noteText,
      buttons,
    );
    input.focus();
    input.select();
  }

  function manageRow(p: Profile, data: ProfilesData): HTMLElement {
    const row = el('li', 'manage-row', 'manage-row');
    row.dataset.profileId = p.id;
    const colour = el('input', 'manage-colour');
    colour.type = 'color';
    colour.value = shownColour(doc, data, p);
    colour.setAttribute('aria-label', `Colour of ${p.name}`);
    colour.addEventListener('change', () => profiles.setColour(p.id, colour.value));
    const name = el('input', 'manage-name');
    name.type = 'text';
    name.maxLength = 16;
    name.value = p.name;
    name.setAttribute('aria-label', `Name of ${p.name}`);
    const rename = (): void => {
      const problem = profiles.rename(p.id, name.value);
      note = problem ?? `Renamed to ${name.value.trim()}.`;
      draw();
    };
    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        rename();
      }
    });
    const role = p.id === data.activeId ? 'singing now' : p.id === data.secondId ? 'second singer' : '';
    const only = data.list.length <= 1;
    const del = button('Delete', 'manage-delete', () => {
      confirming = { id: p.id, takes: null };
      lastConfirmed = p.id;
      note = '';
      void profiles.countTakes(p.id).then((n) => {
        if (confirming?.id === p.id) confirming.takes = n;
        draw();
      });
      draw();
    });
    del.disabled = only;
    if (only) del.dataset.help = 'The last singer cannot be deleted';
    row.append(colour, name, button('Rename', 'manage-rename', rename), del);
    if (role) row.append(el('span', 'manage-role', 'song-meta', role));
    return row;
  }

  /** Puts focus back on the control that was used before a redraw removed it. */
  function restoreManageFocus(was: HTMLElement | null): void {
    const rows = Array.from(box.querySelectorAll<HTMLElement>('[data-profile-id]'));
    const inRow = was?.closest<HTMLElement>('[data-profile-id]') ?? null;
    const rowId = inRow?.dataset.profileId ?? lastConfirmed;
    const testid = inRow ? was?.dataset.testid : 'manage-delete';
    const target = rows
      .find((r) => r.dataset.profileId === rowId)
      ?.querySelector<HTMLElement>(`[data-testid="${testid}"]:not([disabled])`);
    (target ?? box.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    lastConfirmed = null;
  }

  function drawManage(data: ProfilesData): void {
    const pending = confirming ? profileById(data, confirming.id) : null;
    if (confirming && !pending) confirming = null;
    if (confirming && pending) {
      const takes = confirming.takes;
      const warn = el('p', 'manage-warning', '', takes === null ? 'Counting their takes…' : deleteWarning(pending.name, takes));
      warn.setAttribute('role', 'alert');
      const row = el('div', '', 'button-row');
      const run = (keep: boolean): void => {
        const id = pending.id;
        const n = takes ?? 0;
        yes.disabled = true;
        keepIt.disabled = true;
        void profiles.remove(id, keep).then((outcome) => {
          confirming = null;
          if (!outcome.ok) note = outcome.note;
          else note = keep ? `Deleted ${pending.name}; ${takesOf(n)} kept as No singer.` : `${deleteLabel(pending.name, n).replace(/^Delete /, 'Deleted ')}.`;
          draw();
        });
      };
      const yes = button(takes === null ? 'Delete' : deleteLabel(pending.name, takes), 'manage-delete-confirm', () => run(false), 'danger');
      yes.disabled = takes === null;
      const keepIt = button(keepLabel(pending.name, takes ?? 0), 'manage-delete-keep', () => run(true));
      keepIt.hidden = takes === null || takes === 0;
      row.append(
        yes,
        keepIt,
        button('Cancel', 'manage-delete-cancel', () => {
          confirming = null;
          draw();
        }),
      );
      box.replaceChildren(head(`Delete ${pending.name}?`), warn, row);
      yes.focus();
      return;
    }
    const was = box.contains(doc.activeElement) ? (doc.activeElement as HTMLElement) : null;
    const list = el('ul', 'manage-list', 'manage-list');
    for (const p of data.list) list.append(manageRow(p, data));
    const only = el('p', 'manage-only', 'song-meta', 'The last singer cannot be deleted: rename them instead.');
    only.hidden = data.list.length > 1;
    const add = button('New singer…', 'manage-new', () => profiles.setDialog({ kind: 'new', slot: 0 }));
    box.replaceChildren(head('Manage singers'), list, only, noteLine(), add);
    if (was !== null || lastConfirmed !== null) restoreManageFocus(was);
  }

  function draw(): void {
    const dialog = store.state.profileDialog;
    shown = dialog;
    if (dialog === null) return;
    if (dialog.kind === 'new') drawNew(dialog.slot, store.state.profiles);
    else drawManage(store.state.profiles);
  }

  function show(): void {
    const dialog = store.state.profileDialog;
    if (dialog === null) {
      host.hidden = true;
      confirming = null;
      lastConfirmed = null;
      note = '';
      shown = null;
      box.replaceChildren();
      if (returnFocus?.isConnected) returnFocus.focus();
      returnFocus = null;
      return;
    }
    if (host.hidden) returnFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    host.hidden = false;
    if (!shown || shown.kind !== dialog.kind) {
      confirming = null;
      note = '';
    }
    draw();
    if (dialog.kind === 'manage' && !confirming) {
      // Focus lands on the first control so Tab and Escape work from the keyboard.
      (box.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    }
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (store.state.profileDialog === null) return;
    if (ev.key === 'Escape') {
      // This runs first (capture), so Escape here never reaches a drawer behind.
      ev.preventDefault();
      ev.stopPropagation();
      if (confirming) {
        confirming = null;
        draw();
      } else close();
      return;
    }
    if (ev.key !== 'Tab') return;
    const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if (ev.shiftKey && (active === first || !box.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || !box.contains(active))) {
      ev.preventDefault();
      first.focus();
    }
  };
  const onBackdrop = (ev: Event): void => {
    if (ev.target === host) close();
  };
  doc.addEventListener('keydown', onKey, true);
  host.addEventListener('click', onBackdrop);

  const unsubscribe = store.subscribe((_state, changed) => {
    if (changed.has('profileDialog')) show();
    else if (changed.has('profiles') && store.state.profileDialog !== null) draw();
  });
  show();

  return () => {
    unsubscribe();
    doc.removeEventListener('keydown', onKey, true);
    host.removeEventListener('click', onBackdrop);
    host.replaceChildren();
  };
};
