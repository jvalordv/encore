/**
 * The Session's side of singer profiles: it loads the list at start (making
 * it from the W5 names and colours on the first run), keeps `state.profiles`
 * and the stored copy in step, mirrors singer A's and B's names and colours
 * into the duet so the lane's ribbons and the cards keep working, and carries
 * out choosing, renaming, adding and deleting. Deleting a profile removes
 * that singer's takes from the take store (only the ones they sang as singer
 * A; singer B's share of someone else's duet stays with that take, marked as
 * no singer) or, when asked to keep them, marks those takes NO_SINGER and
 * leaves them in the store, where they count for nobody. Nothing
 * about a person is held here beyond the list: Progress, the streak, stars and
 * the range are read over the takes of the active profile by the controllers
 * that own them, which watch `state.profiles`.
 */
import { messageOf } from './helpers';
import {
  activeProfile,
  addProfile,
  chooseActive,
  chooseSecond,
  ensureSecond,
  loadProfiles,
  mergeProfiles,
  newProfileId,
  ownsTake,
  profileById,
  recolourProfile,
  removeProfile,
  renameProfile,
  saveProfiles,
  singersOnDelete,
} from '../profiles';
import type { Outcome, Profile, ProfilesData } from '../profiles';
import type { ProfileDialog } from '../state';
import type { TakeSingers } from '../takes';
import type { SessionCore } from './core';

/** What deleting a profile did: how many takes went or stayed, or why nothing did. */
export type DeleteOutcome =
  | { ok: true; removedTakes: number; keptTakes: number }
  | { ok: false; note: string };

/** Words for a change refused because a take is being recorded. */
const STOP_FIRST = 'Stop recording first.';

/** Owns the profile list and what follows from changing it. */
export class ProfilesController {
  private makeId: () => string = newProfileId;

  constructor(private readonly core: SessionCore) {
    const { store, settingsStore, current } = core;
    let data = loadProfiles(settingsStore, current.duet, this.makeId);
    if (current.duet.secondSinger) data = ensureSecond(data, this.makeId);
    store.patch({ profiles: data });
    this.persist(data);
    this.mirror();
    // Turning singer B on needs a profile in B's slot, however it is turned on.
    store.subscribe((state, changed) => {
      if (!changed.has('duet')) return;
      const p = state.profiles;
      if (state.duet.secondSinger && (p.secondId === null || p.secondId === p.activeId)) {
        this.apply(ensureSecond(p, this.makeId), false);
      }
    });
  }

  private get data(): ProfilesData {
    return this.core.store.state.profiles;
  }

  /** Opens or closes the profile dialog (`null` closes it). */
  setDialog(dialog: ProfileDialog | null): void {
    this.core.store.patch({ profileDialog: dialog });
  }

  /** The profiles as the settings file carries them. */
  list(): Profile[] {
    return this.data.list.map((p) => ({ ...p }));
  }

  /** Makes `id` the singer in `slot` (A: the active singer; B: the second). */
  choose(slot: 0 | 1, id: string): string | null {
    if (this.core.store.state.recording) return this.refuse(STOP_FIRST);
    const { data } = this;
    if (profileById(data, id) === null) return this.refuse('That singer is gone.');
    if (slot === 0) {
      if (id === data.activeId) return null;
      this.apply(chooseActive(data, id), true);
      return null;
    }
    const outcome = chooseSecond(data, id);
    if (!outcome.ok) return this.refuse(outcome.note);
    this.apply(outcome.data, outcome.data.activeId !== data.activeId);
    return null;
  }

  /** Adds a singer and puts them in `slot`; the note says why not, else null. */
  create(name: string, slot: 0 | 1 = 0): string | null {
    if (this.core.store.state.recording) return this.refuse(STOP_FIRST);
    const added = addProfile(this.data, name, this.makeId);
    if (!added.ok) return this.refuse(added.note);
    this.apply(added.data, false);
    return this.choose(slot, added.id as string);
  }

  /** Renames a singer in place; the note says why not, else null. */
  rename(id: string, name: string): string | null {
    const outcome = renameProfile(this.data, id, name);
    return this.finish(outcome, false);
  }

  /** Sets a singer's ribbon colour; null is the skin's own. */
  setColour(id: string, colour: string | null): void {
    this.apply(recolourProfile(this.data, id, colour), false);
  }

  /** How many takes deleting `id` would remove (Mic check takes are nobody's). */
  async countTakes(id: string): Promise<number> {
    const takes = await (await this.core.takesReady).list();
    return takes.filter((t) => ownsTake(t, id, this.data.legacyId)).length;
  }

  /**
   * Deletes a singer. Their takes (the ones they sang as singer A) are deleted
   * too, or with `keepTakes` stay in the store marked as nobody's.
   */
  async remove(id: string, keepTakes = false): Promise<DeleteOutcome> {
    const { store } = this.core;
    if (store.state.recording) return { ok: false, note: STOP_FIRST };
    const outcome = removeProfile(this.data, id);
    if (!outcome.ok) return { ok: false, note: outcome.note };
    const name = profileById(this.data, id)?.name ?? 'The singer';
    try {
      const takes = await this.core.takesReady;
      const all = await takes.list();
      const { legacyId } = this.data;
      const mine = all.filter((t) => ownsTake(t, id, legacyId));
      if (!keepTakes && mine.some((t) => t.id === store.state.playingTakeId)) this.core.takes.stopTake();
      // Each mark is remembered so a take that starts mid-delete can undo them:
      // the singer is kept whole, with their takes still theirs.
      const marked: Array<{ id: string; was: TakeSingers }> = [];
      const undo = async (): Promise<void> => {
        for (const m of marked) await takes.setSingers(m.id, m.was);
      };
      const interrupted = async (): Promise<DeleteOutcome | null> => {
        if (!store.state.recording) return null;
        await undo();
        const note = `${STOP_FIRST} ${name} is kept; delete again afterwards.`;
        store.setStatus(note, 'warn');
        return { ok: false, note };
      };
      for (const take of all) {
        const singers = singersOnDelete(take, id, legacyId, keepTakes);
        if (!singers) continue;
        const stopped = await interrupted();
        if (stopped) return stopped;
        const was: TakeSingers = {};
        if ('profileId' in singers) was.profileId = take.profileId;
        if ('profileIdB' in singers) was.profileIdB = take.profileIdB;
        marked.push({ id: take.id, was });
        await takes.setSingers(take.id, singers);
      }
      // A take started during the awaits must keep the singer it began with,
      // and nothing is deleted under it.
      const stopped = await interrupted();
      if (stopped) return stopped;
      if (!keepTakes) for (const take of mine) await takes.remove(take.id);
      // Re-derived after the awaits: the list may have changed meanwhile.
      const again = removeProfile(this.data, id);
      if (again.ok) this.apply(again.data, true);
      const n = `${mine.length} ${mine.length === 1 ? 'take' : 'takes'}`;
      store.setStatus(keepTakes ? `${name} deleted; ${n} kept as No singer.` : `${name} and ${n} deleted.`);
      return keepTakes
        ? { ok: true, removedTakes: 0, keptTakes: mine.length }
        : { ok: true, removedTakes: mine.length, keptTakes: 0 };
    } catch (error) {
      const note = `Could not delete ${name}: ${messageOf(error)}`;
      store.setStatus(note, 'error');
      return { ok: false, note };
    } finally {
      // Takes may be gone or marked even when the delete stopped part way.
      await this.core.takes.refreshTakes().catch(() => undefined);
    }
  }

  /** Folds an imported file's singers into the list; how many were added or changed. */
  merge(incoming: readonly Profile[]): number {
    const { data, changed } = mergeProfiles(this.data, incoming);
    if (changed > 0) this.apply(data, false);
    return changed;
  }

  private refuse(note: string): string {
    this.core.store.setStatus(note, 'warn');
    return note;
  }

  private finish(outcome: Outcome, activeMayChange: boolean): string | null {
    if (!outcome.ok) return this.refuse(outcome.note);
    this.apply(outcome.data, activeMayChange);
    return null;
  }

  /** Stores and publishes `data`; when singer A changed, re-reads their numbers. */
  private apply(next: ProfilesData, activeChanged: boolean): void {
    // With singer B on, B's slot must always hold a profile other than A's.
    const data = this.core.store.state.duet.secondSinger ? ensureSecond(next, this.makeId) : next;
    this.persist(data);
    this.core.store.patch({ profiles: data });
    this.mirror();
    if (activeChanged) {
      void this.core.keys.refreshRange();
      this.core.store.setStatus(`Singing as ${activeProfile(data).name}.`);
    }
  }

  private persist(data: ProfilesData): void {
    try {
      saveProfiles(this.core.settingsStore, data);
    } catch {
      // The list still serves this session.
    }
  }

  /** The duet's names and colours are the two slots' profiles. */
  private mirror(): void {
    const { duet, store } = this.core;
    const { list, activeId, secondId } = store.state.profiles;
    const slots: Array<[0 | 1, Profile | undefined]> = [
      [0, list.find((p) => p.id === activeId)],
      [1, list.find((p) => p.id === secondId)],
    ];
    for (const [slot, profile] of slots) {
      if (!profile) continue;
      if (store.state.duet.names[slot] !== profile.name) duet.setName(slot, profile.name);
      if (store.state.duet.colours[slot] !== profile.colour) duet.setColour(slot, profile.colour);
    }
  }
}
