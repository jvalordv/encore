/**
 * Tests for singer profiles in a real session core on fake parts: the first
 * run makes them from the W5 names, a take records who sang it (and, for a
 * duet, who sang B), choosing a singer moves the streak, the stars and the
 * range to that singer's takes, A and B never become one singer, the duet's
 * ribbons follow the profiles, deleting a singer removes only their takes
 * (old takes with no profileId only with the oldest singer), or keeps them
 * marked as no singer's, the last singer
 * cannot go, nothing changes while recording, and a settings export carries
 * the singers while a reset keeps them.
 */
import { describe, expect, it } from 'vitest';
import { NO_SINGER, PROFILES_KEY, loadProfiles, takesOfProfile } from '../src/app/profiles';
import { loadSettings } from '../src/app/settings';
import type { TakeSummary } from '../src/app/takes';
import { makeHarness, songInfo } from './session-harness';
import type { Harness } from './session-harness';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const DAY = 86_400_000;
const NOW = Date.now();

/** Saves a bare take of `hash`, `daysAgo` days back, as `extra` says. */
async function saveTake(h: Harness, daysAgo: number, extra: Partial<TakeSummary> = {}, hash = 'h1'): Promise<string> {
  return (await h.core.takesReady).save({
    songHash: hash,
    songName: hash,
    createdAt: NOW - daysAgo * DAY,
    durationS: 4,
    latencyS: 0,
    sampleRate: 48000,
    voicedFrames: 100,
    frames: [],
    wav: new Blob([]),
    ...extra,
  });
}

async function allTakes(h: Harness): Promise<TakeSummary[]> {
  return (await h.core.takesReady).list();
}

async function songTakeIds(h: Harness): Promise<string[]> {
  return (await (await h.core.takesReady).list()).map((t) => t.id).sort();
}

/** Records a short take of a steady tone on singer A's mic. */
async function record(h: Harness): Promise<void> {
  h.player.setSong(songInfo());
  await h.core.input.chooseInput('usb');
  await h.core.takes.toggleRecord();
  for (let i = 0; i < 100; i++) {
    h.engine.t = i * 0.01;
    h.player.positionS = i * 0.01;
    h.tracker.emit({ t: i * 0.01, f0: 440, clarity: 0.95, rms: 0.2 });
    h.trackerB.emit({ t: i * 0.01, f0: 330, clarity: 0.95, rms: 0.2 });
  }
  await h.core.takes.toggleRecord();
}

const profiles = (h: Harness) => h.store.state.profiles;
const names = (h: Harness): string[] => profiles(h).list.map((p) => p.name);

describe('the first run', () => {
  it('makes one singer, "Singer 1", and keeps it for the next start', () => {
    const h = makeHarness();
    expect(names(h)).toEqual(['Singer 1']);
    expect(profiles(h).activeId).toBe(profiles(h).legacyId);
    expect(loadProfiles(h.settingsStore, loadSettings(h.settingsStore).duet).list[0].id).toBe(profiles(h).activeId);
    expect(h.settingsStore.get(PROFILES_KEY)).not.toBeNull();
  });

  it('turns W5 names and colours into the first two singers', () => {
    const h = makeHarness({ duet: { secondSinger: true, names: ['Ann', 'Bo'], colours: ['#112233', null] } });
    expect(profiles(h).list.map((p) => [p.name, p.colour])).toEqual([
      ['Ann', '#112233'],
      ['Bo', null],
    ]);
    expect(profiles(h).secondId).toBe(profiles(h).list[1].id);
    expect(h.store.state.duet).toMatchObject({ names: ['Ann', 'Bo'], colours: ['#112233', null] });
  });
});

describe('a take records who sang it', () => {
  it('stamps singer A\'s profile, and none of B\'s while B is off', async () => {
    const h = makeHarness();
    await record(h);
    const [take] = h.store.state.takes;
    expect(take.profileId).toBe(profiles(h).activeId);
    expect(take.profileIdB).toBeUndefined();
    expect(take.voicedFramesB).toBeUndefined();
  });

  it('follows the singer chosen when the take began', async () => {
    const h = makeHarness();
    expect(h.core.profiles.create('Bo')).toBeNull();
    await record(h);
    expect(h.store.state.takes[0].profileId).toBe(profiles(h).activeId);
    expect(names(h)[profiles(h).list.findIndex((p) => p.id === h.store.state.takes[0].profileId)]).toBe('Bo');
  });

  it('stamps both singers of a duet, with what each voiced, even in karaoke mode', async () => {
    const h = makeHarness({ duet: { secondSinger: true } });
    await h.core.duet.chooseSecondInput('usb-b');
    await record(h);
    const [take] = h.store.state.takes;
    expect(take.profileId).toBe(profiles(h).activeId);
    expect(take.profileIdB).toBe(profiles(h).secondId);
    expect(take.profileIdB).not.toBe(take.profileId);
    expect(take.voicedFramesB).toBeGreaterThan(10);
  });
});

describe('choosing singers', () => {
  it('turns B on with a singer in the slot, making one when there is nobody else', () => {
    const h = makeHarness();
    h.core.duet.setSecondSinger(true);
    expect(names(h)).toEqual(['Singer 1', 'Singer 2']);
    expect(profiles(h).secondId).toBe(profiles(h).list[1].id);
    expect(h.store.state.duet.names).toEqual(['Singer 1', 'Singer 2']);
  });

  it('puts a new singer in the active slot, or in B\'s when asked', () => {
    const h = makeHarness();
    h.core.profiles.create('Bo');
    expect(names(h)).toEqual(['Singer 1', 'Bo']);
    expect(profiles(h).list.find((p) => p.id === profiles(h).activeId)?.name).toBe('Bo');
    h.core.profiles.create('Cy', 1);
    expect(profiles(h).list.find((p) => p.id === profiles(h).secondId)?.name).toBe('Cy');
    expect(h.store.state.duet.names).toEqual(['Bo', 'Cy']);
  });

  it('never makes A and B the same singer: the pick trades places, or is refused', () => {
    const h = makeHarness();
    const [a] = profiles(h).list;
    expect(h.core.profiles.choose(1, a.id)).toContain('Pick someone else');
    expect(profiles(h).secondId).toBeNull();

    h.core.duet.setSecondSinger(true);
    const b = profiles(h).list[1];
    expect(h.core.profiles.choose(1, a.id)).toBeNull();
    expect(profiles(h)).toMatchObject({ activeId: b.id, secondId: a.id });
    expect(h.store.state.duet.names).toEqual(['Singer 2', 'Singer 1']);

    expect(h.core.profiles.choose(0, a.id)).toBeNull();
    expect(profiles(h)).toMatchObject({ activeId: a.id, secondId: b.id });
  });

  it('renames in place and the ribbons follow, refusing a taken name', () => {
    const h = makeHarness();
    const id = profiles(h).activeId;
    expect(h.core.profiles.rename(id, 'Ann')).toBeNull();
    expect(h.store.state.duet.names[0]).toBe('Ann');
    expect(loadProfiles(h.settingsStore, loadSettings(h.settingsStore).duet).list[0].name).toBe('Ann');
    h.core.profiles.create('Bo');
    expect(h.core.profiles.rename(id, 'bo')).toContain('already a singer');
    h.core.profiles.setColour(id, '#00ff00');
    expect(profiles(h).list[0].colour).toBe('#00ff00');
  });

  it('refuses every change while a take is being recorded', async () => {
    const h = makeHarness();
    h.core.profiles.create('Bo');
    h.player.setSong(songInfo());
    await h.core.input.chooseInput('usb');
    await h.core.takes.toggleRecord();
    const before = profiles(h);
    expect(h.core.profiles.choose(0, before.list[0].id)).toBe('Stop recording first.');
    expect(h.core.profiles.create('Cy')).toBe('Stop recording first.');
    expect((await h.core.profiles.remove(before.list[0].id)).ok).toBe(false);
    expect(profiles(h)).toBe(before);
    await h.core.takes.toggleRecord();
  });
});

describe('each singer\'s own numbers', () => {
  it('keeps the streak and the stars with the singer who sang', async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo');
    const bo = profiles(h).activeId;
    // Ann (the oldest singer, so her takes carry no profileId) sang yesterday and today; Bo, three days ago.
    await saveTake(h, 0);
    await saveTake(h, 1);
    await saveTake(h, 3, { profileId: bo });
    h.core.profiles.choose(0, ann);
    await settle();
    expect(h.store.state.library.daysSung).toHaveLength(2);
    h.core.profiles.choose(0, bo);
    await settle();
    expect(h.store.state.library.daysSung).toHaveLength(1);
  });

  it('counts a duet take for B from B\'s part only', async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo', 1);
    const bo = profiles(h).secondId as string;
    // Ann sang nothing in this duet take; Bo sang plenty.
    await saveTake(h, 0, { profileId: ann, profileIdB: bo, voicedFrames: 0, voicedFramesB: 90 });
    h.core.profiles.choose(0, ann);
    await settle();
    expect(h.store.state.library.daysSung).toEqual([]);
    h.core.profiles.choose(0, bo);
    await settle();
    expect(h.store.state.library.daysSung).toHaveLength(1);
  });
});

describe('the range estimate', () => {
  /** A take whose voice spanned `low` to `high` (MIDI). */
  const spanning = (low: number, high: number): Partial<TakeSummary> => ({
    report: { voice: { summary: { range: { lowMidi: low, highMidi: high } } } } as unknown as TakeSummary['report'],
  });

  it("is the active singer's own: another singer's takes do not set it", async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo');
    const bo = profiles(h).activeId;
    // Ann (old takes, no profileId) sings low; Bo sings high.
    for (let i = 0; i < 4; i++) await saveTake(h, i, spanning(48, 60));
    for (let i = 0; i < 4; i++) await saveTake(h, i, { ...spanning(64, 76), profileId: bo });

    await h.core.keys.refreshRange();
    expect(h.store.state.keyShift.band).toMatchObject({ lowMidi: 64, highMidi: 76 });
    h.core.profiles.choose(0, ann);
    await settle();
    expect(h.store.state.keyShift.band).toMatchObject({ lowMidi: 48, highMidi: 60 });
    // A singer with no takes has no range yet.
    h.core.profiles.create('Cy');
    await settle();
    expect(h.store.state.keyShift.band).toBeNull();
  });
});

describe('deleting a singer', () => {
  it('counts and removes only the takes that singer sang', async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo');
    const bo = profiles(h).activeId;
    const bos = [await saveTake(h, 0, { profileId: bo }), await saveTake(h, 1, { profileId: bo })];
    const legacy = await saveTake(h, 2);
    const anns = await saveTake(h, 3, { profileId: ann });
    // Ann's duet take with Bo as B stays: it is Ann's take.
    const duet = await saveTake(h, 4, { profileId: ann, profileIdB: bo, voicedFramesB: 50 });
    const check = await saveTake(h, 5, { kind: 'mic-check', profileId: bo });

    expect(await h.core.profiles.countTakes(bo)).toBe(2);
    const out = await h.core.profiles.remove(bo);
    expect(out).toEqual({ ok: true, removedTakes: 2, keptTakes: 0 });
    expect(names(h)).toEqual(['Singer 1']);
    expect(profiles(h).activeId).toBe(ann);
    expect(await songTakeIds(h)).toEqual([legacy, anns, duet, check].sort());
    expect(bos.every((id) => !h.store.state.takes.some((t) => t.id === id))).toBe(true);
  });

  it("keeps the takes, marked as nobody's, when asked, and they count for nobody", async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo');
    const bo = profiles(h).activeId;
    const bos = [await saveTake(h, 0, { profileId: bo }), await saveTake(h, 1, { profileId: bo })];
    const anns = await saveTake(h, 3, { profileId: ann });
    const legacy = await saveTake(h, 4);
    // Bo was B in Ann's duet take: Bo's side is marked, the take stays Ann's.
    const duet = await saveTake(h, 5, { profileId: ann, profileIdB: bo, voicedFramesB: 50 });

    const out = await h.core.profiles.remove(bo, true);
    expect(out).toEqual({ ok: true, removedTakes: 0, keptTakes: 2 });
    expect(names(h)).toEqual(['Singer 1']);
    expect(await songTakeIds(h)).toEqual([...bos, anns, legacy, duet].sort());
    const stored = await allTakes(h);
    const byId = (id: string) => stored.find((t) => t.id === id) as TakeSummary;
    for (const id of bos) expect(byId(id).profileId).toBe(NO_SINGER);
    expect(byId(duet).profileId).toBe(ann);
    expect(byId(duet).profileIdB).toBe(NO_SINGER);
    expect(byId(anns).profileId).toBe(ann);
    // Legacy takes still belong to the oldest singer, not to nobody.
    expect(byId(legacy).profileId).toBeUndefined();
    const mine = takesOfProfile(stored, ann, profiles(h).legacyId).map((t) => t.id);
    expect(mine.sort()).toEqual([anns, legacy, duet].sort());
    expect(await h.core.profiles.countTakes(ann)).toBe(3);
  });

  it("keeps the oldest singer's old takes as nobody's when she goes and they are kept", async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo');
    const old = await saveTake(h, 1);
    const out = await h.core.profiles.remove(ann, true);
    expect(out).toEqual({ ok: true, removedTakes: 0, keptTakes: 1 });
    const stored = await allTakes(h);
    expect(stored.find((t) => t.id === old)?.profileId).toBe(NO_SINGER);
    expect(takesOfProfile(stored, profiles(h).activeId, profiles(h).legacyId)).toEqual([]);
  });

  it('removes old takes (no profileId) only with the singer they belong to', async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo');
    const old = await saveTake(h, 1);
    const bos = await saveTake(h, 2, { profileId: profiles(h).activeId });

    // Deleting Bo leaves the old takes, which are Ann's.
    expect((await h.core.profiles.remove(profiles(h).activeId)).ok).toBe(true);
    expect(await songTakeIds(h)).toEqual([old]);
    expect(bos).not.toBe(old);

    // Deleting Ann (the oldest singer) takes the old takes with her.
    h.core.profiles.create('Cy');
    const cys = await saveTake(h, 0, { profileId: profiles(h).activeId });
    expect(await h.core.profiles.countTakes(ann)).toBe(1);
    expect(await h.core.profiles.remove(ann)).toEqual({ ok: true, removedTakes: 1, keptTakes: 0 });
    expect(await songTakeIds(h)).toEqual([cys]);
  });

  it('cannot delete the last singer, and loses nothing trying', async () => {
    const h = makeHarness();
    const take = await saveTake(h, 0);
    const out = await h.core.profiles.remove(profiles(h).activeId);
    expect(out).toEqual({ ok: false, note: 'The last singer cannot be deleted. Rename them instead.' });
    expect(names(h)).toEqual(['Singer 1']);
    expect(await songTakeIds(h)).toEqual([take]);
  });

  it('switches to another singer when the active one goes, and empties B\'s slot when B goes', async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo', 1);
    const bo = profiles(h).secondId as string;
    expect((await h.core.profiles.remove(bo)).ok).toBe(true);
    expect(profiles(h)).toMatchObject({ activeId: ann, secondId: null });
    h.core.profiles.create('Cy');
    expect((await h.core.profiles.remove(profiles(h).activeId)).ok).toBe(true);
    expect(profiles(h).activeId).toBe(ann);
  });
});

describe('deleting a singer while B is on', () => {
  it('keeps a different singer in the second slot when B goes, so a duet take names B', async () => {
    const h = makeHarness({ duet: { secondSinger: true } });
    await h.core.duet.chooseSecondInput('usb-b');
    h.core.profiles.create('Cy');
    const bo = profiles(h).secondId as string;
    expect((await h.core.profiles.remove(bo)).ok).toBe(true);
    const after = profiles(h);
    expect(after.secondId).not.toBeNull();
    expect(after.secondId).not.toBe(after.activeId);
    expect(after.list.some((p) => p.id === after.secondId)).toBe(true);
    await record(h);
    const [take] = h.store.state.takes;
    expect(take.profileIdB).toBe(after.secondId);
  });

  it('fills the second slot again when A goes and B was the only other singer', async () => {
    const h = makeHarness({ duet: { secondSinger: true } });
    const ann = profiles(h).activeId;
    expect((await h.core.profiles.remove(ann)).ok).toBe(true);
    const after = profiles(h);
    expect(after.list.some((p) => p.id === after.activeId)).toBe(true);
    expect(after.secondId).not.toBeNull();
    expect(after.secondId).not.toBe(after.activeId);
  });

  it('keeps the singer when a take starts while the delete is running', async () => {
    const h = makeHarness();
    const ann = profiles(h).activeId;
    h.core.profiles.create('Bo');
    await saveTake(h, 0, { profileId: profiles(h).activeId });
    // The entry check passes synchronously; the take starts during the awaits.
    const pending = h.core.profiles.remove(profiles(h).activeId);
    h.store.patch({ recording: true });
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(names(h)).toEqual(['Singer 1', 'Bo']);
    expect(profiles(h).list.some((p) => p.id === ann)).toBe(true);
  });

  it('gives the takes back when a take starts part way through keeping them', async () => {
    const h = makeHarness();
    h.core.profiles.create('Bo');
    const bo = profiles(h).activeId;
    const first = await saveTake(h, 1, { profileId: bo });
    const second = await saveTake(h, 0, { profileId: bo });
    const takes = await h.core.takesReady;
    const write = takes.setSingers.bind(takes);
    let calls = 0;
    takes.setSingers = async (id, singers) => {
      await write(id, singers);
      // The take starts right after the first take is marked.
      if (calls++ === 0) h.store.patch({ recording: true });
    };
    const out = await h.core.profiles.remove(bo, true);
    expect(out.ok).toBe(false);
    expect(profiles(h).list.some((p) => p.id === bo)).toBe(true);
    const owners = new Map((await allTakes(h)).map((t) => [t.id, t.profileId]));
    expect(owners.get(first)).toBe(bo);
    expect(owners.get(second)).toBe(bo);
  });
});

describe('the settings file', () => {
  it('carries the singers, and an import adds and renames without removing anyone', () => {
    const h = makeHarness();
    h.core.profiles.rename(profiles(h).activeId, 'Ann');
    const text = h.core.settings.exportText('studio', false);
    const file = JSON.parse(text) as { profiles: Array<{ id: string; name: string }> };
    expect(file.profiles.map((p) => p.name)).toEqual(['Ann']);

    const other = makeHarness();
    other.core.profiles.create('Bo');
    const bo = profiles(other).activeId;
    const out = other.core.settings.importText(text, ['studio'], 'studio');
    expect(out.applied).toBe(true);
    expect(out.message).toContain('Singers');
    // Ann joined; Bo (not in the file) stayed, and is still singer A.
    expect(profiles(other).list.map((p) => p.name)).toContain('Ann');
    expect(profiles(other).list.map((p) => p.name)).toContain('Bo');
    expect(profiles(other).activeId).toBe(bo);
  });

  it('does not rename the singers from the duet part of an old file', () => {
    const h = makeHarness();
    const file = { app: 'encore-settings', version: 1, settings: { duet: { secondSinger: false, names: ['X', 'Y'] } } };
    h.core.settings.importText(JSON.stringify(file), ['studio'], 'studio');
    expect(names(h)).toEqual(['Singer 1']);
    expect(h.store.state.duet.names[0]).toBe('Singer 1');
  });

  it('is kept by Reset all', () => {
    const h = makeHarnessWithSingers();
    expect(h.core.settings.resetAll()).toBe(true);
    expect(names(h)).toEqual(['Ann', 'Bo']);
    expect(h.store.state.duet.names).toEqual(['Ann', 'Bo']);
  });
});

function makeHarnessWithSingers(): Harness {
  return makeHarness({ duet: { secondSinger: true, names: ['Ann', 'Bo'], colours: [null, null] } });
}
