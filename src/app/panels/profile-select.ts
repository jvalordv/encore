/**
 * The singer dropdown, in two places: the header's (the active singer, which
 * is singer A) and one in each slot of the Singers panel. They share the same
 * options, every singer then "New singer…" and "Manage singers…", and the same
 * rule for a pick: a singer goes into the slot (the same one as the other slot
 * swaps the two), "New singer…" opens the form for that slot, "Manage
 * singers…" opens the list with Rename and Delete. This file holds the helpers
 * the two share and the header's mount; the dialogs are profile-dialog.ts and
 * the choosing is the Session's `profiles` controller.
 */
import { profileById } from '../profiles';
import type { Profile, ProfilesData } from '../profiles';
import type { Session } from '../session';
import type { StateStore } from '../state';
import type { MountPanel } from './panel';

/** Option values that are actions, not singers. */
export const NEW_VALUE = '@new';
export const MANAGE_VALUE = '@manage';

/** Fills `select` with the singers and the two actions, and selects `selectedId`. */
export function fillProfileSelect(select: HTMLSelectElement, data: ProfilesData, selectedId: string | null): void {
  const doc = select.ownerDocument;
  const options = data.list.map((p) => {
    const o = doc.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    return o;
  });
  const add = (value: string, text: string): HTMLOptionElement => {
    const o = doc.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  select.replaceChildren(...options, add(NEW_VALUE, 'New singer…'), add(MANAGE_VALUE, 'Manage singers…'));
  select.value = selectedId !== null && profileById(data, selectedId) ? selectedId : (data.list[0]?.id ?? '');
}

/**
 * Handles a pick on a singer dropdown for `slot` (0 is A, 1 is B). The select
 * is put back on what the state says, so a refused pick does not stay shown.
 */
export function pickProfile(
  session: Pick<Session, 'profiles'>,
  store: StateStore,
  slot: 0 | 1,
  select: HTMLSelectElement,
): void {
  const value = select.value;
  if (value === NEW_VALUE) session.profiles.setDialog({ kind: 'new', slot });
  else if (value === MANAGE_VALUE) session.profiles.setDialog({ kind: 'manage' });
  else session.profiles.choose(slot, value);
  const { profiles } = store.state;
  fillProfileSelect(select, profiles, slot === 0 ? profiles.activeId : profiles.secondId);
}

/** The colour to show for a singer: their own, or the skin's for the slot they sit in. */
export function shownColour(doc: Document, data: ProfilesData, profile: Profile): string {
  if (profile.colour !== null) return profile.colour;
  const token =
    profile.id === data.activeId ? '--color-singer-a' : profile.id === data.secondId ? '--color-singer-b' : null;
  const view = doc.defaultView;
  const value = token && view ? view.getComputedStyle(doc.documentElement).getPropertyValue(token).trim() : '';
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#808080';
}

/** What the header picker needs. */
export interface ProfilePickerDeps {
  store: StateStore;
  session: Pick<Session, 'profiles'>;
}

/** Builds the header's singer dropdown into `host`; the returned function takes it down. */
export const mountProfilePicker: MountPanel<ProfilePickerDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const label = doc.createElement('label');
  label.htmlFor = 'profile-select';
  label.textContent = 'Singer';
  const select = doc.createElement('select');
  select.id = 'profile-select';
  select.dataset.testid = 'profile-select';
  select.dataset.help = 'Who is singing: their progress, streak and takes are kept apart';
  host.append(label, select);

  const draw = (): void => {
    const { profiles } = store.state;
    // A pick in progress keeps the control; redrawing under an open list closes it.
    fillProfileSelect(select, profiles, profiles.activeId);
    select.disabled = store.state.recording;
  };
  const onChange = (): void => pickProfile(session, store, 0, select);
  select.addEventListener('change', onChange);
  const unsubscribe = store.subscribe((_state, changed) => {
    if (changed.has('profiles') || changed.has('recording')) draw();
  });
  draw();

  return () => {
    unsubscribe();
    select.removeEventListener('change', onChange);
    host.replaceChildren();
  };
};
