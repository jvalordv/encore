/**
 * Singer profiles: who is singing. A profile is an id, a name and a ribbon
 * colour; the app always has at least one. The active profile is singer A
 * (the header's choice) and a second profile can sit in singer B's slot, never
 * the same one as A. Everything about a person (progress, streak, stars,
 * personal bests, range) is read over the takes that person sang, which a take
 * records as `profileId` (singer A) and, for a duet, `profileIdB` with B's
 * voiced frame count. A take saved before profiles existed has neither and
 * belongs to the profile the first run created (`legacyId`), so no stored take
 * is rewritten. A take kept when its singer was deleted carries the reserved
 * id NO_SINGER in the field instead: an explicit "nobody", which is not the
 * legacy meaning of an absent field. Device things (mic, latency, skin, mode) are not here.
 * Everything in this file is pure and tested in test/profiles.test.ts; the
 * state of the list lives under one key of the key-value store, behind the
 * same KeyValueStore interface as the settings.
 */
import type { TakeReport } from '../analysis/score';
import { cleanColour, cleanName } from '../duet/settings';
import type { DuetSettings } from '../duet/settings';
import type { KeyValueStore } from './storage';
import { newTakeId } from './takes';
import type { TakeSingers } from './takes';

/** One singer. A colour of null means the skin's own colour for the slot. */
export interface Profile {
  id: string;
  name: string;
  colour: string | null;
}

/** The whole list, who is singer A and B, and whom the oldest takes are. */
export interface ProfilesData {
  list: Profile[];
  /** Singer A: the active singer, whose progress the app shows. */
  activeId: string;
  /** Singer B's profile; kept while B is off so the slot remembers. */
  secondId: string | null;
  /** The profile that takes without a `profileId` belong to. */
  legacyId: string;
}

/** A change that either worked or says why not, in plain words. */
export type Outcome = { ok: true; data: ProfilesData; id?: string } | { ok: false; note: string };

/** Key inside the key-value store; the localStorage adapter adds `encore.`. */
export const PROFILES_KEY = 'profiles';

/**
 * The reserved `profileId` (and `profileIdB`) of a take kept after its singer
 * was deleted. No profile can have this id (sanitizeList drops one), so such
 * a take counts for nobody's Progress, streak, stars, bests or range.
 */
export const NO_SINGER = 'none';

/** What the takes list calls the singer of a take marked NO_SINGER. */
export const NO_SINGER_NAME = 'No singer';

/** The most profiles kept; a dropdown of more would not be usable. */
export const MAX_PROFILES = 12;

/** Colours for singers after the first two, which use the skin's own. */
const PALETTE: readonly string[] = [
  '#e4572e',
  '#17bebb',
  '#ffc914',
  '#76b041',
  '#9b5de5',
  '#f15bb5',
  '#00a6ed',
  '#f7882f',
];

/** A fresh profile id. */
export function newProfileId(): string {
  return `p-${newTakeId()}`;
}

/** The colour a profile gets at position `index`: the skin's for the first two. */
export function defaultColour(index: number): string | null {
  return index < 2 ? null : PALETTE[(index - 2) % PALETTE.length];
}

/** "Singer 1", "Singer 2", ...: the lowest number no profile is using. */
export function defaultName(list: readonly Profile[]): string {
  const taken = new Set(list.map((p) => p.name.toLowerCase()));
  for (let n = 1; ; n++) if (!taken.has(`singer ${n}`)) return `Singer ${n}`;
}

/** The profile with `id`, or null. */
export function profileById(data: Pick<ProfilesData, 'list'>, id: string | null): Profile | null {
  return id === null ? null : (data.list.find((p) => p.id === id) ?? null);
}

/** The active profile; the list is never empty and the id is always in it. */
export function activeProfile(data: ProfilesData): Profile {
  return profileById(data, data.activeId) ?? data.list[0];
}

/** One profile, nothing else: what a first run on an empty browser starts with. */
export function initialProfiles(makeId: () => string = newProfileId): ProfilesData {
  const id = makeId();
  return { list: [{ id, name: 'Singer 1', colour: null }], activeId: id, secondId: null, legacyId: id };
}

/**
 * The first run on a browser that had the W5 settings: the first profile
 * takes singer A's name and colour if they were customised, and a customised
 * singer B (or a B that was on) becomes the second profile.
 */
export function migrateFromDuet(duet: DuetSettings, makeId: () => string = newProfileId): ProfilesData {
  const aId = makeId();
  const a: Profile = {
    id: aId,
    name: duet.names[0] === 'Singer A' ? 'Singer 1' : duet.names[0],
    colour: duet.colours[0],
  };
  const customB = duet.names[1] !== 'Singer B' || duet.colours[1] !== null;
  if (!customB && !duet.secondSinger) return { list: [a], activeId: aId, secondId: null, legacyId: aId };
  const bId = makeId();
  const b: Profile = {
    id: bId,
    name: duet.names[1] === 'Singer B' ? 'Singer 2' : duet.names[1],
    colour: duet.colours[1],
  };
  return { list: [a, b], activeId: aId, secondId: bId, legacyId: aId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps the profiles of a list that are usable: unique ids, clean names. */
export function sanitizeList(value: unknown): Profile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Profile[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '' || item.id === NO_SINGER) continue;
    if (seen.has(item.id)) continue;
    if (out.length >= MAX_PROFILES) break;
    seen.add(item.id);
    out.push({
      id: item.id,
      name: cleanName(item.name, `Singer ${out.length + 1}`),
      colour: cleanColour(item.colour),
    });
  }
  return out;
}

/** Turns anything (parsed JSON) into valid profiles, or null when it has none. */
export function sanitizeProfiles(value: unknown): ProfilesData | null {
  if (!isRecord(value)) return null;
  const list = sanitizeList(value.list);
  if (list.length === 0) return null;
  const has = (id: unknown): id is string => typeof id === 'string' && list.some((p) => p.id === id);
  const activeId = has(value.activeId) ? value.activeId : list[0].id;
  const secondId = has(value.secondId) && value.secondId !== activeId ? value.secondId : null;
  const legacyId = typeof value.legacyId === 'string' && value.legacyId !== '' ? value.legacyId : list[0].id;
  return { list, activeId, secondId, legacyId };
}

/** Writes the profiles; nothing else reads them but `loadProfiles`. */
export function saveProfiles(store: KeyValueStore, data: ProfilesData): void {
  store.set(PROFILES_KEY, JSON.stringify({ version: 1, ...data }));
}

/**
 * Reads the profiles. The first run (nothing stored, or nothing usable) makes
 * them from the duet settings and stores the result, so the migration runs
 * once; never throws.
 */
export function loadProfiles(
  store: KeyValueStore,
  duet: DuetSettings,
  makeId: () => string = newProfileId,
): ProfilesData {
  const text = store.get(PROFILES_KEY);
  if (text !== null) {
    try {
      const data = sanitizeProfiles(JSON.parse(text));
      if (data !== null) return data;
    } catch {
      // A corrupt blob must not lock the singer out; start again below.
    }
  }
  const data = migrateFromDuet(duet, makeId);
  try {
    saveProfiles(store, data);
  } catch {
    // The list still serves this session; the migration runs again next time.
  }
  return data;
}

// ---- Changes ----------------------------------------------------------------

function nameProblem(list: readonly Profile[], name: string, exceptId: string | null): string | null {
  if (name === '') return 'A singer needs a name.';
  const clash = list.find((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
  return clash ? `There is already a singer called ${clash.name}.` : null;
}

/** Adds a profile (with a name, or the next "Singer N"); does not choose it. */
export function addProfile(data: ProfilesData, name: string, makeId: () => string = newProfileId): Outcome {
  if (data.list.length >= MAX_PROFILES) {
    return { ok: false, note: `That is the most singers kept (${MAX_PROFILES}). Delete one first.` };
  }
  const wanted = cleanName(name, '');
  const clean = wanted === '' && name.trim() === '' ? defaultName(data.list) : wanted;
  const problem = nameProblem(data.list, clean, null);
  if (problem) return { ok: false, note: problem };
  const id = makeId();
  const profile: Profile = { id, name: clean, colour: defaultColour(data.list.length) };
  return { ok: true, id, data: { ...data, list: [...data.list, profile] } };
}

/** Renames a profile in place. */
export function renameProfile(data: ProfilesData, id: string, name: string): Outcome {
  if (profileById(data, id) === null) return { ok: false, note: 'That singer is gone.' };
  const clean = cleanName(name, '');
  const problem = nameProblem(data.list, clean, id);
  if (problem) return { ok: false, note: problem };
  return { ok: true, id, data: { ...data, list: data.list.map((p) => (p.id === id ? { ...p, name: clean } : p)) } };
}

/** Sets a profile's ribbon colour (`#rrggbb`), or null for the skin's. */
export function recolourProfile(data: ProfilesData, id: string, colour: string | null): ProfilesData {
  const clean = cleanColour(colour);
  return { ...data, list: data.list.map((p) => (p.id === id ? { ...p, colour: clean } : p)) };
}

/**
 * Removes a profile. The last one cannot go. Removing singer A hands the slot
 * to the next profile (not the one in B's slot); removing B's empties its slot.
 */
export function removeProfile(data: ProfilesData, id: string): Outcome {
  if (profileById(data, id) === null) return { ok: false, note: 'That singer is gone.' };
  if (data.list.length <= 1) {
    return { ok: false, note: 'The last singer cannot be deleted. Rename them instead.' };
  }
  const list = data.list.filter((p) => p.id !== id);
  const secondId = data.secondId === id ? null : data.secondId;
  let activeId = data.activeId;
  if (activeId === id) {
    const index = data.list.findIndex((p) => p.id === id);
    const after = [...data.list.slice(index + 1), ...data.list.slice(0, index)];
    activeId = (after.find((p) => p.id !== secondId) ?? after[0]).id;
  }
  return { ok: true, id, data: { ...data, list, activeId, secondId: secondId === activeId ? null : secondId } };
}

/** Makes `id` singer A; if B was that profile the two trade places. */
export function chooseActive(data: ProfilesData, id: string): ProfilesData {
  if (profileById(data, id) === null || id === data.activeId) return data;
  return { ...data, activeId: id, secondId: id === data.secondId ? data.activeId : data.secondId };
}

/**
 * Puts `id` in singer B's slot. The same profile as A swaps the two (refused,
 * with a note, when B has nobody to trade with).
 */
export function chooseSecond(data: ProfilesData, id: string | null): Outcome {
  if (id !== null && profileById(data, id) === null) return { ok: false, note: 'That singer is gone.' };
  if (id !== null && id === data.activeId) {
    if (data.secondId === null) {
      return { ok: false, note: 'Singer A is already that singer. Pick someone else for singer B.' };
    }
    return { ok: true, id, data: { ...data, activeId: data.secondId, secondId: id } };
  }
  return { ok: true, ...(id === null ? {} : { id }), data: { ...data, secondId: id } };
}

/**
 * Makes sure singer B's slot holds a profile other than A's: keeps a valid
 * one, else takes the first profile that is not A, else adds "Singer N".
 */
export function ensureSecond(data: ProfilesData, makeId: () => string = newProfileId): ProfilesData {
  if (data.secondId !== null && data.secondId !== data.activeId && profileById(data, data.secondId)) return data;
  const other = data.list.find((p) => p.id !== data.activeId);
  if (other) return { ...data, secondId: other.id };
  const added = addProfile(data, '', makeId);
  return added.ok ? { ...added.data, secondId: added.id ?? null } : data;
}

/**
 * Folds profiles from an imported settings file into the list: a known id
 * takes the file's name and colour, an unknown id is added (up to the limit).
 * Nobody is removed and the choice of A and B stays, so no take loses its owner.
 */
export function mergeProfiles(data: ProfilesData, incoming: readonly Profile[]): { data: ProfilesData; changed: number } {
  let list = [...data.list];
  let changed = 0;
  for (const p of incoming) {
    const at = list.findIndex((q) => q.id === p.id);
    if (at >= 0) {
      const taken = list.some((q) => q.id !== p.id && q.name.toLowerCase() === p.name.toLowerCase());
      const next: Profile = { id: p.id, name: taken ? list[at].name : p.name, colour: p.colour };
      if (next.name !== list[at].name || next.colour !== list[at].colour) changed++;
      list[at] = next;
    } else if (list.length < MAX_PROFILES) {
      let name = cleanName(p.name, `Singer ${list.length + 1}`);
      for (let n = list.length + 1; nameProblem(list, name, null) && n < list.length + 100; n++) {
        name = `${p.name.slice(0, 12)} ${n}`;
      }
      list = [...list, { ...p, name: cleanName(name, `Singer ${list.length + 1}`) }];
      changed++;
    }
  }
  return { data: { ...data, list }, changed };
}

// ---- Who sang a take --------------------------------------------------------

/** The fields of a stored take that say who sang it (a TakeSummary fits). */
export interface OwnedTake {
  kind?: 'song' | 'mic-check';
  profileId?: string;
  profileIdB?: string;
  voicedFramesB?: number;
  voicedFrames?: number;
  report?: TakeReport;
  duet?: { reportB: TakeReport };
}

/**
 * Singer A's profile on a take: the one recorded, else the oldest profile
 * (legacyId). A Mic check take is the mic's, not a person's, and has none.
 */
export function ownerOf(take: OwnedTake, legacyId: string): string | null {
  if (take.kind === 'mic-check' || take.profileId === NO_SINGER) return null;
  return take.profileId ?? legacyId;
}

/** True for a song take kept after its singer was deleted. */
export function hasNoSinger(take: OwnedTake): boolean {
  return take.kind !== 'mic-check' && take.profileId === NO_SINGER;
}

/**
 * The name the takes list shows for who sang `take` under "All singers": the
 * profile's name, "No singer" for a kept take, undefined for a Mic check take
 * or one whose profile is not in the list.
 */
export function ownerName(take: OwnedTake, data: ProfilesData): string | undefined {
  if (hasNoSinger(take)) return NO_SINGER_NAME;
  return profileById(data, ownerOf(take, data.legacyId))?.name;
}

/**
 * What to rewrite on a take when singer `id` is deleted, or null for none.
 * Singer A's take is marked NO_SINGER only when `keepOwn` (otherwise it is
 * deleted, so nothing is written); singer B's side of anyone's duet take is
 * always marked, so the kept take does not point at a profile that is gone.
 */
export function singersOnDelete(take: OwnedTake, id: string, legacyId: string, keepOwn: boolean): TakeSingers | null {
  if (ownsTake(take, id, legacyId)) return keepOwn ? { profileId: NO_SINGER } : null;
  if (take.kind !== 'mic-check' && take.profileIdB === id) return { profileIdB: NO_SINGER };
  return null;
}

/** True when `id` sang the take as singer A (what Delete takes away). */
export function ownsTake(take: OwnedTake, id: string, legacyId: string): boolean {
  return ownerOf(take, legacyId) === id;
}

/** True when `id` sang any part of the take, as A or as B. */
export function involvesProfile(take: OwnedTake, id: string, legacyId: string): boolean {
  return ownsTake(take, id, legacyId) || (take.kind !== 'mic-check' && take.profileIdB === id);
}

/**
 * The takes one person sang, each reading as theirs: singer A's takes as they
 * are, and the takes where they were singer B with B's report and B's voiced
 * frames, so what Progress, the streak and the stars read is that person's.
 * A take where a profile is both is not possible (A and B differ).
 */
export function takesOfProfile<T extends OwnedTake>(takes: readonly T[], id: string, legacyId: string): T[] {
  const out: T[] = [];
  if (id === NO_SINGER) return out;
  for (const take of takes) {
    if (ownsTake(take, id, legacyId)) out.push(take);
    else if (take.kind !== 'mic-check' && take.profileIdB === id) {
      out.push({ ...take, report: take.duet?.reportB, voicedFrames: take.voicedFramesB });
    }
  }
  return out;
}

/**
 * The takes a card's singer is measured among: the profile that sang that
 * part of `take`, or, for an old duet take with no record of who B was, every
 * duet take's B (the W5 reading).
 */
export function takesOfCardSinger<T extends OwnedTake>(
  takes: readonly T[],
  take: OwnedTake,
  singer: 0 | 1,
  legacyId: string,
): T[] {
  if (singer === 0) {
    const owner = ownerOf(take, legacyId);
    return owner === null ? [] : takesOfProfile(takes, owner, legacyId);
  }
  if (take.profileIdB === NO_SINGER) return [];
  if (take.profileIdB === undefined) {
    return takes.filter((t) => t.duet !== undefined).map((t) => ({ ...t, report: t.duet?.reportB }));
  }
  return takesOfProfile(takes, take.profileIdB, legacyId);
}
