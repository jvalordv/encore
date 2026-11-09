/**
 * Tests for singer profiles (src/app/profiles.ts): making and renaming and
 * deleting them (the last one cannot go), choosing who is singer A and B, the
 * first-run migration from the W5 names, the stored copy, which takes belong
 * to whom (an old take with no profileId is the first singer's, singer B reads
 * a duet take through B's report), and that Progress, the streak, the stars
 * and the personal best each read one person's takes only, and that a take
 * kept after its singer was deleted (NO_SINGER) belongs to nobody.
 */
import { describe, expect, it } from 'vitest';
import { takePoints } from '../src/analysis/progress';
import type { TakeReport } from '../src/analysis/score';
import { personalBest, songStarsBySong } from '../src/analysis/stars';
import { daysSung, fixedOffsetDay } from '../src/analysis/streak';
import { defaultDuet } from '../src/duet/settings';
import { deleteLabel, deleteWarning, keepLabel } from '../src/app/panels/profile-dialog';
import {
  addProfile,
  chooseActive,
  chooseSecond,
  defaultColour,
  defaultName,
  ensureSecond,
  hasNoSinger,
  initialProfiles,
  involvesProfile,
  loadProfiles,
  MAX_PROFILES,
  mergeProfiles,
  migrateFromDuet,
  NO_SINGER,
  ownerName,
  ownerOf,
  ownsTake,
  PROFILES_KEY,
  recolourProfile,
  removeProfile,
  renameProfile,
  sanitizeList,
  sanitizeProfiles,
  saveProfiles,
  singersOnDelete,
  takesOfCardSinger,
  takesOfProfile,
} from '../src/app/profiles';
import type { OwnedTake, ProfilesData } from '../src/app/profiles';
import { memoryStore } from '../src/app/storage';

/** Ids p1, p2, ... so a test reads the same each time. */
function ids(): () => string {
  let n = 0;
  return () => `p${++n}`;
}

function three(): ProfilesData {
  const make = ids();
  let data = initialProfiles(make);
  for (const name of ['Bo', 'Cy']) {
    const added = addProfile(data, name, make);
    if (!added.ok) throw new Error(added.note);
    data = added.data;
  }
  return data;
}

describe('a fresh start', () => {
  it('has one singer, "Singer 1", who is also the owner of old takes', () => {
    const data = initialProfiles(ids());
    expect(data.list).toEqual([{ id: 'p1', name: 'Singer 1', colour: null }]);
    expect(data).toMatchObject({ activeId: 'p1', secondId: null, legacyId: 'p1' });
  });

  it('names the next singer by the lowest free number', () => {
    expect(defaultName([])).toBe('Singer 1');
    expect(defaultName([{ id: 'a', name: 'Singer 1', colour: null }])).toBe('Singer 2');
    expect(defaultName([{ id: 'a', name: 'singer 1', colour: null }, { id: 'b', name: 'Singer 3', colour: null }])).toBe(
      'Singer 2',
    );
  });

  it('gives the first two singers the skin colours and later ones a palette colour', () => {
    expect(defaultColour(0)).toBeNull();
    expect(defaultColour(1)).toBeNull();
    expect(defaultColour(2)).toMatch(/^#[0-9a-f]{6}$/);
    expect(defaultColour(2)).not.toBe(defaultColour(3));
  });
});

describe('the first run on a browser that had the W5 settings', () => {
  it('makes one singer from the defaults', () => {
    const data = migrateFromDuet(defaultDuet(), ids());
    expect(data.list.map((p) => p.name)).toEqual(['Singer 1']);
  });

  it('keeps customised names and colours, and singer B as the second singer', () => {
    const duet = { ...defaultDuet(), names: ['Ann', 'Bo'] as [string, string], colours: ['#112233', null] as [string, null] };
    const data = migrateFromDuet(duet, ids());
    expect(data.list).toEqual([
      { id: 'p1', name: 'Ann', colour: '#112233' },
      { id: 'p2', name: 'Bo', colour: null },
    ]);
    expect(data).toMatchObject({ activeId: 'p1', secondId: 'p2', legacyId: 'p1' });
  });

  it('makes a second singer when B was on, even with the default name', () => {
    const data = migrateFromDuet({ ...defaultDuet(), secondSinger: true }, ids());
    expect(data.list.map((p) => p.name)).toEqual(['Singer 1', 'Singer 2']);
    expect(data.secondId).toBe('p2');
  });

  it('runs once: the stored list is read the next time', () => {
    const store = memoryStore();
    const first = loadProfiles(store, { ...defaultDuet(), names: ['Ann', 'Singer B'] }, ids());
    expect(store.get(PROFILES_KEY)).not.toBeNull();
    const again = loadProfiles(store, { ...defaultDuet(), names: ['Other', 'Singer B'] }, () => 'zzz');
    expect(again).toEqual(first);
    expect(again.list[0].name).toBe('Ann');
  });

  it('starts again from a corrupt or empty stored blob', () => {
    const store = memoryStore();
    store.set(PROFILES_KEY, '{not json');
    expect(loadProfiles(store, defaultDuet(), ids()).list).toHaveLength(1);
    store.set(PROFILES_KEY, JSON.stringify({ list: [] }));
    expect(loadProfiles(store, defaultDuet(), ids()).list).toHaveLength(1);
  });
});

describe('the stored copy', () => {
  it('round-trips and repairs what it reads', () => {
    const data = three();
    const store = memoryStore();
    saveProfiles(store, { ...data, secondId: 'p2' });
    expect(loadProfiles(store, defaultDuet())).toEqual({ ...data, secondId: 'p2' });
  });

  it('drops bad entries, repeated ids and a choice that points nowhere', () => {
    const data = sanitizeProfiles({
      list: [{ id: 'a', name: '  Ann  ', colour: '#ABCDEF' }, { id: 'a', name: 'dup' }, { name: 'no id' }, 7, { id: 'b', name: '', colour: 'red' }],
      activeId: 'gone',
      secondId: 'gone',
      legacyId: 'old',
    });
    expect(data?.list).toEqual([
      { id: 'a', name: 'Ann', colour: '#abcdef' },
      { id: 'b', name: 'Singer 2', colour: null },
    ]);
    expect(data).toMatchObject({ activeId: 'a', secondId: null, legacyId: 'old' });
  });

  it('never makes A and B the same singer', () => {
    const data = sanitizeProfiles({ list: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], activeId: 'a', secondId: 'a' });
    expect(data?.secondId).toBeNull();
  });
});

describe('adding and renaming', () => {
  it('adds a singer with a name, or the next "Singer N"', () => {
    const data = initialProfiles(ids());
    const named = addProfile(data, '  Sam  ', ids());
    expect(named.ok && named.data.list.map((p) => p.name)).toEqual(['Singer 1', 'Sam']);
    const blank = addProfile(data, '   ', ids());
    expect(blank.ok && blank.data.list.map((p) => p.name)).toEqual(['Singer 1', 'Singer 2']);
  });

  it('refuses a name already taken (any case) and the seventeenth letter is cut', () => {
    const data = initialProfiles(ids());
    const clash = addProfile(data, 'SINGER 1', ids());
    expect(clash).toEqual({ ok: false, note: 'There is already a singer called Singer 1.' });
    const long = addProfile(data, 'abcdefghijklmnopq', ids());
    expect(long.ok && long.data.list[1].name).toBe('abcdefghijklmnop');
  });

  it('stops at the limit', () => {
    let data = initialProfiles(ids());
    const make = ids();
    for (let i = 1; i < MAX_PROFILES; i++) {
      const added = addProfile(data, `S${i}`, make);
      if (added.ok) data = added.data;
    }
    expect(data.list).toHaveLength(MAX_PROFILES);
    expect(addProfile(data, 'One more', make).ok).toBe(false);
  });

  it('does not choose the new singer; that is a separate step', () => {
    const data = initialProfiles(ids());
    const added = addProfile(data, 'Bo', () => 'new');
    expect(added.ok && added.data.activeId).toBe('p1');
  });

  it('renames in place, keeping the id, and refuses empty and taken names', () => {
    const data = three();
    const ok = renameProfile(data, 'p2', ' Robert ');
    expect(ok.ok && ok.data.list[1]).toEqual({ id: 'p2', name: 'Robert', colour: null });
    expect(renameProfile(data, 'p2', '   ')).toEqual({ ok: false, note: 'A singer needs a name.' });
    expect(renameProfile(data, 'p2', 'cy').ok).toBe(false);
    // Keeping one's own name is not a clash.
    expect(renameProfile(data, 'p2', 'BO').ok).toBe(true);
    expect(renameProfile(data, 'nobody', 'X').ok).toBe(false);
  });

  it('recolours one singer, or gives the skin colour back', () => {
    const data = recolourProfile(three(), 'p2', '#ABCDEF');
    expect(data.list[1].colour).toBe('#abcdef');
    expect(recolourProfile(data, 'p2', null).list[1].colour).toBeNull();
    expect(recolourProfile(data, 'p2', 'not a colour').list[1].colour).toBeNull();
  });
});

describe('deleting', () => {
  it('removes the singer', () => {
    const out = removeProfile(three(), 'p3');
    expect(out.ok && out.data.list.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('cannot remove the last singer', () => {
    const out = removeProfile(initialProfiles(ids()), 'p1');
    expect(out).toEqual({ ok: false, note: 'The last singer cannot be deleted. Rename them instead.' });
  });

  it('hands singer A to the next singer when A goes, skipping B', () => {
    const data: ProfilesData = { ...three(), activeId: 'p1', secondId: 'p2' };
    const out = removeProfile(data, 'p1');
    expect(out.ok && out.data).toMatchObject({ activeId: 'p3', secondId: 'p2' });
  });

  it('empties B\'s slot when B goes, and leaves A alone', () => {
    const data: ProfilesData = { ...three(), activeId: 'p1', secondId: 'p2' };
    const out = removeProfile(data, 'p2');
    expect(out.ok && out.data).toMatchObject({ activeId: 'p1', secondId: null });
  });

  it('keeps the owner of old takes named even after that singer is gone', () => {
    const out = removeProfile(three(), 'p1');
    expect(out.ok && out.data.legacyId).toBe('p1');
    expect(out.ok && out.data.list.some((p) => p.id === 'p1')).toBe(false);
  });

  it('says so for a singer who is not there', () => {
    expect(removeProfile(three(), 'nobody').ok).toBe(false);
  });
});

describe('choosing singers', () => {
  it('makes a singer A, and trades places when they were B', () => {
    const data: ProfilesData = { ...three(), secondId: 'p2' };
    expect(chooseActive(data, 'p3')).toMatchObject({ activeId: 'p3', secondId: 'p2' });
    expect(chooseActive(data, 'p2')).toMatchObject({ activeId: 'p2', secondId: 'p1' });
    expect(chooseActive(data, 'p1')).toBe(data);
    expect(chooseActive(data, 'nobody')).toBe(data);
  });

  it("puts a singer in B's slot", () => {
    const set = chooseSecond(three(), 'p3');
    expect(set.ok && set.data).toMatchObject({ activeId: 'p1', secondId: 'p3' });
  });

  it('trades places when the singer picked for B is A', () => {
    const data: ProfilesData = { ...three(), activeId: 'p1', secondId: 'p2' };
    const out = chooseSecond(data, 'p1');
    expect(out.ok && out.data).toMatchObject({ activeId: 'p2', secondId: 'p1' });
  });

  it('refuses A and B being the same singer when B has nobody to trade with', () => {
    const out = chooseSecond(three(), 'p1');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.note).toContain('Pick someone else');
  });


  it('clears B\'s slot', () => {
    const out = chooseSecond({ ...three(), secondId: 'p2' }, null);
    expect(out.ok && out.data.secondId).toBeNull();
  });

  it('gives B a singer when B is turned on: another one, or a new one', () => {
    const picked = ensureSecond(three(), ids());
    expect(picked.secondId).toBe('p2');
    const solo = ensureSecond(initialProfiles(ids()), () => 'fresh');
    expect(solo.list.map((p) => p.name)).toEqual(['Singer 1', 'Singer 2']);
    expect(solo.secondId).toBe('fresh');
    const kept = { ...three(), secondId: 'p3' };
    expect(ensureSecond(kept)).toBe(kept);
  });
});

describe('importing singers', () => {
  it('updates a known id, adds a new one, removes nobody', () => {
    const data = three();
    const { data: merged, changed } = mergeProfiles(data, [
      { id: 'p2', name: 'Robert', colour: '#123456' },
      { id: 'p9', name: 'Di', colour: null },
    ]);
    expect(changed).toBe(2);
    expect(merged.list.map((p) => p.name)).toEqual(['Singer 1', 'Robert', 'Cy', 'Di']);
    expect(merged.activeId).toBe(data.activeId);
    expect(mergeProfiles(merged, [{ id: 'p2', name: 'Robert', colour: '#123456' }]).changed).toBe(0);
  });

  it('does not let a name collide with another singer', () => {
    const { data } = mergeProfiles(three(), [{ id: 'p9', name: 'Bo', colour: null }]);
    expect(new Set(data.list.map((p) => p.name.toLowerCase())).size).toBe(data.list.length);
  });

  it('keeps names unique when the first suffixed name is taken too', () => {
    const { data: first } = mergeProfiles(three(), [{ id: 'p8', name: 'Bo 4', colour: null }]);
    const { data } = mergeProfiles(first, [{ id: 'p9', name: 'Bo', colour: null }]);
    expect(data.list).toHaveLength(first.list.length + 1);
    expect(new Set(data.list.map((p) => p.name.toLowerCase())).size).toBe(data.list.length);
  });
});

// ---- Who sang a take --------------------------------------------------------

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 12);
const utc = fixedOffsetDay(0);

function report(rate: number): TakeReport {
  return {
    notesCovered: 1,
    notesSung: 1,
    inTuneRate: rate,
    frames: { hit: 0, okay: 0, miss: 0 },
    timingBiasS: null,
    notes: [],
    worstPhrases: [],
    songRange: { lowMidi: 60, highMidi: 72, highAtS: 0 },
    sungRange: { lowMidi: 57, highMidi: 69 },
    voice: { reference: 'chromatic', summary: { biasCents: 3, within25: rate / 2, within50: rate } },
  } as unknown as TakeReport;
}

interface Take extends OwnedTake {
  id: string;
  songHash: string;
  songName: string;
  createdAt: number;
  report?: TakeReport;
  voicedFrames?: number;
}

function take(id: string, day: number, extra: Partial<Take> = {}): Take {
  return { id, songHash: 'h1', songName: 'One', createdAt: T0 + day * DAY, report: report(0.5), voicedFrames: 100, ...extra };
}

describe('who sang a take', () => {
  it('reads a take with no profileId as the oldest singer\'s', () => {
    expect(ownerOf(take('a', 0), 'p1')).toBe('p1');
    expect(ownerOf(take('a', 0, { profileId: 'p2' }), 'p1')).toBe('p2');
    expect(ownsTake(take('a', 0), 'p1', 'p1')).toBe(true);
    expect(ownsTake(take('a', 0), 'p2', 'p1')).toBe(false);
  });

  it('gives a Mic check take to nobody', () => {
    const check = take('m', 0, { kind: 'mic-check', profileId: 'p2' });
    expect(ownerOf(check, 'p1')).toBeNull();
    expect(ownsTake(check, 'p2', 'p1')).toBe(false);
    expect(involvesProfile(check, 'p2', 'p1')).toBe(false);
    expect(takesOfProfile([check], 'p2', 'p1')).toEqual([]);
  });

  it('counts a duet take for A as A\'s and for B through B\'s part', () => {
    const duet = take('d', 0, { profileId: 'p1', profileIdB: 'p2', voicedFramesB: 40, duet: { reportB: report(0.9) } });
    expect(involvesProfile(duet, 'p1', 'p1')).toBe(true);
    expect(involvesProfile(duet, 'p2', 'p1')).toBe(true);
    expect(involvesProfile(duet, 'p3', 'p1')).toBe(false);
    const forA = takesOfProfile([duet], 'p1', 'p1');
    expect(forA[0].report?.inTuneRate).toBe(0.5);
    expect(forA[0].voicedFrames).toBe(100);
    const forB = takesOfProfile([duet], 'p2', 'p1');
    expect(forB[0].report?.inTuneRate).toBe(0.9);
    expect(forB[0].voicedFrames).toBe(40);
  });
});

describe('each singer reads their own takes', () => {
  const mine = take('a', 0);
  const old = take('b', 1);
  const bos = take('c', 2, { profileId: 'p2', report: report(0.8) });
  const duet = take('d', 3, { profileId: 'p1', profileIdB: 'p2', voicedFramesB: 40, duet: { reportB: report(0.95) } });
  const all = [mine, old, bos, duet];

  it('filters the takes, old ones going to the oldest singer', () => {
    expect(takesOfProfile(all, 'p1', 'p1').map((t) => t.id)).toEqual(['a', 'b', 'd']);
    expect(takesOfProfile(all, 'p2', 'p1').map((t) => t.id)).toEqual(['c', 'd']);
    expect(takesOfProfile(all, 'p3', 'p1')).toEqual([]);
  });

  it('feeds Progress only that singer\'s points', () => {
    expect(takePoints(takesOfProfile(all, 'p1', 'p1')).map((p) => p.id)).toEqual(['a', 'b', 'd']);
    const bo = takePoints(takesOfProfile(all, 'p2', 'p1'));
    expect(bo.map((p) => p.id)).toEqual(['c', 'd']);
    // B's point for the duet take is B's report, not A's.
    expect(bo[1].values.inTune).toBe(0.95);
    expect(takePoints(takesOfProfile(all, 'p3', 'p1'))).toEqual([]);
  });

  it('keeps one singer\'s days out of the other\'s streak', () => {
    const takes = [take('a', 0), take('b', 1, { profileId: 'p2' }), take('c', 2, { profileId: 'p2' })];
    const days = (id: string) => daysSung(takesOfProfile(takes, id, 'p1'), utc);
    expect(days('p1')).toEqual([utc(T0)]);
    expect(days('p2')).toEqual([utc(T0 + DAY), utc(T0 + 2 * DAY)]);
  });

  it('does not feed B\'s duet take into A\'s streak, nor A\'s into B\'s', () => {
    // A sang nothing in the duet (a quiet turn); B sang plenty.
    const quietA = take('d', 4, { profileId: 'p1', profileIdB: 'p2', voicedFrames: 0, voicedFramesB: 80, duet: { reportB: report(0.9) } });
    expect(daysSung(takesOfProfile([quietA], 'p1', 'p1'), utc)).toEqual([]);
    expect(daysSung(takesOfProfile([quietA], 'p2', 'p1'), utc)).toEqual([utc(T0 + 4 * DAY)]);
    // And the reverse: B was silent.
    const quietB = { ...quietA, voicedFrames: 80, voicedFramesB: 0 };
    expect(daysSung(takesOfProfile([quietB], 'p1', 'p1'), utc)).toEqual([utc(T0 + 4 * DAY)]);
    expect(daysSung(takesOfProfile([quietB], 'p2', 'p1'), utc)).toEqual([]);
  });

  it('gives each singer their own stars for a song', () => {
    const stars = (id: string) => songStarsBySong(takesOfProfile(all, id, 'p1'))['h1']?.stars;
    // Ann's best is 50 percent (a, b) or the duet's own part; Bo's best is 95.
    expect(stars('p2')).toBeGreaterThan(stars('p1') ?? 0);
  });

  it('measures a personal best among that singer\'s takes only', () => {
    const better = take('z', 9, { profileId: 'p2', report: report(0.9) });
    const among = (id: string) => takesOfProfile([mine, old, bos, better], id, 'p1');
    // Bo beat Bo's own earlier 80 percent.
    expect(personalBest(better, among('p2'))).toMatchObject({ nowPercent: 90, wasPercent: 80 });
    // Measured among everyone it would only beat 80 too; among Ann alone it has nothing to beat.
    expect(personalBest(better, among('p1'))).toMatchObject({ wasPercent: 50 });
  });

  it('reads a card\'s singer through the profile that sang that part', () => {
    expect(takesOfCardSinger(all, duet, 0, 'p1').map((t) => t.id)).toEqual(['a', 'b', 'd']);
    expect(takesOfCardSinger(all, duet, 1, 'p1').map((t) => t.id)).toEqual(['c', 'd']);
    // An old duet take has no record of who B was: every duet take's B, as before.
    const older = take('o', 0, { duet: { reportB: report(0.7) } });
    expect(takesOfCardSinger([older, mine], older, 1, 'p1').map((t) => t.id)).toEqual(['o']);
  });
});

describe('the delete dialog\'s words', () => {
  it('names what goes and puts the count on the button', () => {
    expect(deleteLabel('Sam', 12)).toBe('Delete Sam and 12 takes');
    expect(deleteLabel('Sam', 1)).toBe('Delete Sam and 1 take');
    expect(deleteLabel('Sam', 0)).toBe('Delete Sam');
    expect(keepLabel('Sam', 12)).toBe('Delete Sam, keep 12 takes');
    expect(keepLabel('Sam', 1)).toBe('Delete Sam, keep 1 take');
    const text = deleteWarning('Sam', 12);
    for (const word of ['Sam', '12 takes', 'recordings', 'progress', 'streak', 'personal bests', 'range', 'cannot be undone']) {
      expect(text).toContain(word);
    }
  });

  it('says what each of the two choices does, and has one choice for a singer with no takes', () => {
    const text = deleteWarning('Sam', 12);
    expect(text).toContain('"Delete Sam and 12 takes" also deletes');
    expect(text).toContain('"Delete Sam, keep 12 takes" deletes only Sam');
    expect(text).toContain('No singer');
    expect(deleteWarning('Sam', 1)).toContain('take stays');
    expect(deleteWarning('Sam', 0)).not.toContain('keep');
  });
});

describe('takes kept when their singer is deleted', () => {
  const kept = take('k', 0, { profileId: NO_SINGER });
  const duetKept = take('dk', 1, { profileId: 'p1', profileIdB: NO_SINGER, voicedFramesB: 40, duet: { reportB: report(0.9) } });

  it('belongs to no profile, unlike a take with no profileId', () => {
    expect(ownerOf(kept, 'p1')).toBeNull();
    expect(hasNoSinger(kept)).toBe(true);
    expect(hasNoSinger(take('a', 0))).toBe(false);
    expect(ownerOf(take('a', 0), 'p1')).toBe('p1');
    for (const id of ['p1', 'p2']) {
      expect(ownsTake(kept, id, 'p1')).toBe(false);
      expect(involvesProfile(kept, id, 'p1')).toBe(false);
    }
  });

  it("counts for nobody's progress, streak, stars, bests or range", () => {
    const all = [kept, duetKept, take('a', 2), take('b', 3, { profileId: 'p2' })];
    expect(takesOfProfile(all, 'p1', 'p1').map((t) => t.id)).toEqual(['dk', 'a']);
    expect(takesOfProfile(all, 'p2', 'p1').map((t) => t.id)).toEqual(['b']);
    expect(takesOfProfile(all, NO_SINGER, 'p1').map((t) => t.id)).toEqual([]);
    expect(takesOfCardSinger(all, kept, 0, 'p1')).toEqual([]);
    expect(takesOfCardSinger(all, duetKept, 1, 'p1')).toEqual([]);
  });

  it('is named "No singer" in the takes list, and a legacy take by the oldest singer', () => {
    const data: ProfilesData = { list: [{ id: 'p1', name: 'Ann', colour: null }], activeId: 'p1', secondId: null, legacyId: 'p1' };
    expect(ownerName(kept, data)).toBe('No singer');
    expect(ownerName(take('a', 0), data)).toBe('Ann');
    expect(ownerName(take('m', 0, { kind: 'mic-check' }), data)).toBeUndefined();
  });

  it('is marked by singersOnDelete only as the delete mode says', () => {
    const own = take('o', 0, { profileId: 'p2' });
    const legacy = take('l', 0);
    const asB = take('b', 0, { profileId: 'p1', profileIdB: 'p2' });
    expect(singersOnDelete(own, 'p2', 'p1', true)).toEqual({ profileId: NO_SINGER });
    expect(singersOnDelete(own, 'p2', 'p1', false)).toBeNull();
    expect(singersOnDelete(legacy, 'p1', 'p1', true)).toEqual({ profileId: NO_SINGER });
    expect(singersOnDelete(legacy, 'p2', 'p1', true)).toBeNull();
    // B's side of someone else's duet take is marked in both modes.
    expect(singersOnDelete(asB, 'p2', 'p1', true)).toEqual({ profileIdB: NO_SINGER });
    expect(singersOnDelete(asB, 'p2', 'p1', false)).toEqual({ profileIdB: NO_SINGER });
    expect(singersOnDelete(take('m', 0, { kind: 'mic-check', profileId: 'p2' }), 'p2', 'p1', true)).toBeNull();
  });

  it('cannot be an imported profile id', () => {
    expect(sanitizeList([{ id: NO_SINGER, name: 'X' }, { id: 'p9', name: 'Y' }]).map((p) => p.id)).toEqual(['p9']);
  });
});
