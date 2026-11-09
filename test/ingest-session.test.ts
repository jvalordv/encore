/**
 * Controller tests for songs dropped together (session/ingest.ts) on the
 * fake-parts harness and a stubbed service: the first file loads as the song
 * while the rest are analysed one at a time in the background, each lands in
 * the Library with the badge of what the service made, one combined line
 * counts them, a failure names its song and the others go on, files dropped
 * while it runs join the end, files that are not audio are skipped, and with
 * no service the songs are still added.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestView, isBusy } from '../src/app/ingest';
import { referenceBadge } from '../src/app/library-state';
import { hashBytes } from '../src/audio/player';
import { ServiceClient, ServiceError } from '../src/service/client';
import type { PollOutcome } from '../src/service/client';
import type { Reference, SongStatus, SongSteps, StepStatus } from '../src/service/types';
import { makeHarness } from './session-harness';
import type { Harness } from './session-harness';

function step(state: StepStatus['state']): StepStatus {
  return { state, progress: state === 'done' ? 1 : 0, error: null, detail: null };
}

/** The service names a song by the hash of its bytes, as the app does. */
const SONG_IDS: Record<string, string> = {};

beforeAll(async () => {
  for (const name of ['a.mp3', 'b.mp3', 'c.mp3', 'notes.txt', 'other.mp3']) {
    SONG_IDS[name] = await hashBytes(bytesOf(name));
  }
});

function bytesOf(name: string): Uint8Array {
  return new TextEncoder().encode(`bytes of ${name}`);
}

/** The status the service holds for a file called `name`. */
function statusFor(name: string, over: Partial<SongSteps> = {}): SongStatus {
  return {
    song_id: SONG_IDS[name],
    title: name,
    duration_s: 30,
    source: 'file',
    steps: {
      fetch: step('skipped'),
      separation: step('done'),
      key: step('skipped'),
      reference: step('done'),
      lyrics: step('skipped'),
      ...over,
    },
  };
}

const MELODY: Reference = {
  contour: { hop_s: 0.01, t0_s: 0, f0_hz: [0, 220], confidence: [0, 1] },
  notes: [{ onset_s: 0, offset_s: 1, midi: 57, cents_mean: 0, cents_std: 0, scoop_cents: 0 }],
  range: { low_midi: 57, high_midi: 57 },
  unpitched_regions: [],
};

/** A file whose bytes differ from every other's, so each hashes to its own song. */
function file(name: string, type = 'audio/mpeg'): File {
  return new File([`bytes of ${name}`], name, { type });
}

/** The service holding `statuses`, by file name, and what it was asked. */
function service(statuses: Record<string, SongStatus>, up = true) {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(up);
  const byId = (id: string): SongStatus | undefined => Object.values(statuses).find((s) => s.song_id === id);
  return {
    upload: vi.spyOn(ServiceClient.prototype, 'uploadSong').mockImplementation(async (f) => {
      const status = statuses[f.name];
      if (!status) throw new ServiceError('rejected', `The service refused ${f.name}.`, 415);
      return status;
    }),
    poll: vi.spyOn(ServiceClient.prototype, 'pollSong').mockImplementation(
      async (id) => ({ kind: 'settled', status: byId(id) }) as PollOutcome,
    ),
    stem: vi
      .spyOn(ServiceClient.prototype, 'fetchStem')
      .mockImplementation(async () => ({ bytes: new ArrayBuffer(8), gain: 0.8 })),
    reference: vi.spyOn(ServiceClient.prototype, 'fetchReference').mockResolvedValue(MELODY),
  };
}

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Waits for the queue to finish. */
async function finished(h: Harness): Promise<void> {
  await vi.waitFor(() => expect(h.store.state.ingest.items.length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(isBusy(h.store.state.ingest)).toBe(false));
}

const entryTitled = (h: Harness, title: string) => h.store.state.library.entries.find((e) => e.title === title);

describe('songs dropped together', () => {
  it('loads the first as the song at once and analyses the rest one after another', async () => {
    const answers = service({
      'a.mp3': statusFor('a.mp3'),
      'b.mp3': statusFor('b.mp3', { key: step('done') }),
      'c.mp3': statusFor('c.mp3', { reference: step('skipped') }),
    });
    vi.spyOn(ServiceClient.prototype, 'fetchKey').mockResolvedValue({ tuning_cents: 0, segments: [] });
    const h = makeHarness();
    const lines: string[] = [];
    h.store.subscribe((state, changed) => {
      if (changed.has('ingest')) lines.push(ingestView(state.ingest).line);
    });

    h.core.ingest.addFiles([file('a.mp3'), file('b.mp3'), file('c.mp3')]);
    // The first is the song as soon as it decodes, before any analysis is over.
    await vi.waitFor(() => expect(h.store.state.song?.name).toBe('a.mp3'));
    await finished(h);

    expect(h.player.load).toHaveBeenCalledTimes(1);
    expect(answers.upload.mock.calls.map(([f]) => f.name)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    expect(lines).toContain('Analysing 1 of 3: a.mp3');
    expect(lines.some((line) => line.startsWith('Analysing 2 of 3: b.mp3'))).toBe(true);
    expect(lines.some((line) => line.startsWith('Analysing 3 of 3: c.mp3'))).toBe(true);
    expect(ingestView(h.store.state.ingest).line).toBe('3 songs analysed.');

    await vi.waitFor(() => expect(h.store.state.library.entries).toHaveLength(3));
    // b: the melody and the key; c: the stems only, so only Backing.
    await vi.waitFor(() => expect(entryTitled(h, 'b')?.melody).toBe(true));
    expect(entryTitled(h, 'b')).toMatchObject({ source: 'file', fileName: 'b.mp3', stems: true, melody: true, key: true });
    expect(referenceBadge(entryTitled(h, 'b')!)?.label).toBe('Melody');
    expect(referenceBadge(entryTitled(h, 'c')!)?.label).toBe('Backing');
    expect(entryTitled(h, 'c')).toMatchObject({ melody: false, key: false, stems: true });
    // The song in use is still the first one.
    expect(h.store.state.song?.name).toBe('a.mp3');
  });

  it('names a song that fails, with its reason, and carries on with the rest', async () => {
    service({ 'a.mp3': statusFor('a.mp3'), 'c.mp3': statusFor('c.mp3') });
    const h = makeHarness();
    h.core.ingest.addFiles([file('a.mp3'), file('b.mp3'), file('c.mp3')]);
    await finished(h);
    const view = ingestView(h.store.state.ingest);
    expect(view.failures).toEqual(['b.mp3: The service refused b.mp3.']);
    expect(view.line).toBe('2 of 3 songs analysed.');
    expect(h.store.state.ingest.items.map((i) => i.phase)).toEqual(['done', 'failed', 'done']);
    await vi.waitFor(() => expect(entryTitled(h, 'c')?.melody).toBe(true));
  });

  it('fails a song whose separation failed, in the service\'s words', async () => {
    const broken = statusFor('b.mp3', {
      separation: { state: 'failed', progress: 0.2, error: 'Separation failed: out of memory.', detail: null },
      reference: step('queued'),
    });
    service({ 'a.mp3': statusFor('a.mp3'), 'b.mp3': broken });
    const h = makeHarness();
    h.core.ingest.addFiles([file('a.mp3'), file('b.mp3')]);
    await finished(h);
    expect(ingestView(h.store.state.ingest).failures).toEqual(['b.mp3: Separation failed: out of memory.']);
    expect(entryTitled(h, 'b')).toMatchObject({ stems: false, melody: false });
  });

  it('adds the songs, and says once that the analysis needs the service, when it is not running', async () => {
    const answers = service({}, false);
    const h = makeHarness();
    h.core.ingest.addFiles([file('a.mp3'), file('b.mp3'), file('c.mp3')]);
    await finished(h);
    expect(answers.upload).not.toHaveBeenCalled();
    expect(ingestView(h.store.state.ingest)).toMatchObject({
      line:
        '3 songs added. Analysing them needs the service, which is not running, ' +
        'so only the first can be played. Drop the others again once it runs.',
      failures: [],
    });
    await vi.waitFor(() => expect(h.store.state.library.entries).toHaveLength(3));
    expect(h.store.state.library.entries.every((e) => !e.stems && !e.melody && !e.key)).toBe(true);
    // The first still plays.
    expect(h.store.state.song?.name).toBe('a.mp3');
  });

  it('appends files dropped while the queue runs, without loading them as the song', async () => {
    const answers = service({
      'a.mp3': statusFor('a.mp3'),
      'b.mp3': statusFor('b.mp3'),
      'c.mp3': statusFor('c.mp3'),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // b's upload waits, so c is dropped while the queue is busy.
    answers.upload.mockImplementation(async (f) => {
      if (f.name === 'b.mp3') await gate;
      return statusFor(f.name);
    });
    const h = makeHarness();
    h.core.ingest.addFiles([file('a.mp3'), file('b.mp3')]);
    await vi.waitFor(() => expect(answers.upload.mock.calls.map(([f]) => f.name)).toContain('b.mp3'));
    h.core.ingest.addFiles([file('c.mp3')]);
    expect(h.store.state.ingest.items.map((i) => i.name)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    expect(ingestView(h.store.state.ingest).line).toMatch(/^Analysing 2 of 3: b\.mp3/);
    release();
    await vi.waitFor(() => expect(h.store.state.ingest.items.map((i) => i.phase)).toEqual(['done', 'done', 'done']));
    expect(h.player.load).toHaveBeenCalledTimes(1);
    expect(h.store.state.song?.name).toBe('a.mp3');
  });

  it('loads a lone file dropped while only the song in use is being analysed, and analyses the first aside', async () => {
    const answers = service({ 'a.mp3': statusFor('a.mp3'), 'b.mp3': statusFor('b.mp3') });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answers.upload.mockImplementation(async (f) => {
      if (f.name === 'a.mp3') await gate;
      return statusFor(f.name);
    });
    const h = makeHarness();
    h.core.ingest.addFiles([file('a.mp3')]);
    await vi.waitFor(() => expect(h.store.state.song?.name).toBe('a.mp3'));
    h.core.ingest.addFiles([file('b.mp3')]);
    // The choice shows at once, not after the first song's analysis.
    await vi.waitFor(() => expect(h.store.state.song?.name).toBe('b.mp3'));
    expect(h.player.load).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(() => expect(h.store.state.ingest.items.map((i) => i.phase)).toEqual(['done', 'done']));
    expect(h.store.state.song?.name).toBe('b.mp3');
  });

  it('counts the song as analysed once its melody has settled, not after the backing notes', async () => {
    const answers = service({
      'a.mp3': statusFor('a.mp3', { backing: step('running') }),
      'b.mp3': statusFor('b.mp3'),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answers.poll.mockImplementation(async (id, options) => {
      if (options?.through === 'backing') await gate;
      return { kind: 'settled', status: statusFor(id === SONG_IDS['a.mp3'] ? 'a.mp3' : 'b.mp3') } as PollOutcome;
    });
    const h = makeHarness();
    h.core.ingest.addFiles([file('a.mp3'), file('b.mp3')]);
    // The backing step of a.mp3 is still held, yet the queue has moved on to b.mp3.
    await vi.waitFor(() => expect(h.store.state.ingest.items.map((i) => i.phase)).toEqual(['done', 'done']));
    expect(answers.upload.mock.calls.map(([f]) => f.name)).toEqual(['a.mp3', 'b.mp3']);
    release();
  });

  it('skips a file that is not audio with a line, and analyses the audio beside it', async () => {
    service({ 'a.mp3': statusFor('a.mp3') });
    const h = makeHarness();
    h.core.ingest.addFiles([file('notes.txt', 'text/plain'), file('a.mp3')]);
    await finished(h);
    const view = ingestView(h.store.state.ingest);
    expect(view.skipped).toEqual(['notes.txt is not an audio file, so it was skipped.']);
    expect(h.store.state.ingest.items.map((i) => i.name)).toEqual(['a.mp3']);
    expect(h.player.load).toHaveBeenCalledTimes(1);
  });

  it('names a first file that would not decode, sends it nowhere and keeps it out of the Library', async () => {
    const answers = service({ 'a.mp3': statusFor('a.mp3'), 'b.mp3': statusFor('b.mp3') });
    const h = makeHarness();
    h.player.load.mockRejectedValueOnce(new Error('Unable to decode audio data'));
    h.core.ingest.addFiles([file('a.mp3'), file('b.mp3')]);
    await finished(h);
    expect(h.store.state.ingest.items.map((i) => i.phase)).toEqual(['failed', 'done']);
    expect(ingestView(h.store.state.ingest).failures).toEqual(['a.mp3: It could not be read as audio.']);
    expect(answers.upload.mock.calls.map(([f]) => f.name)).toEqual(['b.mp3']);
    expect(h.store.state.library.entries.some((e) => e.title === 'a')).toBe(false);
    await vi.waitFor(() => expect(entryTitled(h, 'b')?.melody).toBe(true));
  });

  it('shows only the skipped line when nothing dropped was audio', () => {
    const h = makeHarness();
    h.core.ingest.addFiles([file('notes.txt', 'text/plain')]);
    expect(h.store.state.ingest.items).toEqual([]);
    expect(ingestView(h.store.state.ingest)).toMatchObject({ visible: true, busy: false });
    expect(h.player.load).not.toHaveBeenCalled();
  });

  it('analyses a song aside when another song takes over before its analysis ends', async () => {
    const answers = service({ 'a.mp3': statusFor('a.mp3') });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answers.upload.mockImplementation(async (f) => {
      await gate;
      return statusFor(f.name);
    });
    const h = makeHarness();
    h.core.ingest.addFiles([file('a.mp3')]);
    await vi.waitFor(() => expect(h.store.state.song?.name).toBe('a.mp3'));
    // Another song takes the player while a.mp3 is still being sent.
    await h.core.songs.loadSong(file('other.mp3'));
    release();
    await finished(h);
    expect(h.store.state.ingest.items[0].phase).toBe('done');
    // The fake player files a song under its own key, so look at every entry for it.
    await vi.waitFor(() =>
      expect(h.store.state.library.entries.some((e) => e.title === 'a' && e.melody)).toBe(true),
    );
  });
});
