/**
 * Tests for scoring a karaoke track against its original: the wording of the
 * alignment (src/app/align.ts), the client's align call and its poll against
 * a stubbed `fetch` with fake timers, and the rule that a melody borrowed from
 * the original makes the track one to score (src/app/learning.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alignStateOf, describeAlign, describeKeyOffset, initialAlign } from '../src/app/align';
import { isKaraokeTrack } from '../src/app/learning';
import { initialReference } from '../src/app/reference';
import { ServiceClient, ServiceError } from '../src/service/client';
import type { AlignmentStatus, SongStatus } from '../src/service/types';

const BASE = 'http://localhost:8765';

describe('describeKeyOffset', () => {
  it('says same, higher and lower in plain words', () => {
    expect(describeKeyOffset(0)).toBe('in the same key as the original');
    expect(describeKeyOffset(2)).toBe('2 semitones higher than the original');
    expect(describeKeyOffset(-1)).toBe('1 semitone lower than the original');
  });
});

describe('describeAlign', () => {
  it('says nothing while idle', () => {
    expect(describeAlign(initialAlign())).toBe('');
  });

  it('shows progress while working, or what is being prepared', () => {
    const working = { ...initialAlign(), phase: 'working' as const };
    expect(describeAlign({ ...working, message: 'Preparing the original… 40%' })).toBe('Preparing the original… 40%');
    expect(describeAlign({ ...working, progress: 0.5 })).toBe('Matching this track to the original… 50%');
  });

  it('reports the key offset and the confidence when done', () => {
    const done = { phase: 'done' as const, progress: 1, keyOffset: 2, confidence: 0.87, message: '' };
    expect(describeAlign(done)).toBe(
      "Scoring against the original's melody, 2 semitones higher than the original (match 87%).",
    );
  });

  it('gives the service reason for a refusal, and a fallback without one', () => {
    const refused = { phase: 'refused' as const, progress: 0, keyOffset: null, confidence: 0.2, message: 'Too different.' };
    expect(describeAlign(refused)).toBe('Too different.');
    expect(describeAlign({ ...refused, message: '' })).toContain('differs too much');
  });
});

describe('alignStateOf', () => {
  it('maps queued and running to working and carries the result fields', () => {
    const base: AlignmentStatus = { state: 'queued', progress: 0, original_id: 'o' };
    expect(alignStateOf(base).phase).toBe('working');
    expect(alignStateOf({ ...base, state: 'running', progress: 0.3 })).toMatchObject({ phase: 'working', progress: 0.3 });
    expect(alignStateOf({ ...base, state: 'done', key_offset: -2, confidence: 0.9 })).toMatchObject({
      phase: 'done',
      keyOffset: -2,
      confidence: 0.9,
    });
    expect(alignStateOf({ ...base, state: 'refused', reason: ' no ' })).toMatchObject({ phase: 'refused', message: 'no' });
  });
});

describe('isKaraokeTrack with a borrowed melody', () => {
  const song = { hash: 'yt-abcdefghijk', name: 'x', durationS: 1, kind: 'youtube' } as never;
  const picked = { videoId: 'abcdefghijk', title: 't', channel: 'c', kind: 'karaoke' } as const;

  it('is true for a karaoke pick with no melody of its own', () => {
    expect(isKaraokeTrack({ song, pickedResult: picked, reference: initialReference() })).toBe(true);
  });

  it('is false once the melody came from the original', () => {
    const reference = { phase: 'ready' as const, notes: 12, message: '', alignedFrom: 'yt-original1' };
    expect(isKaraokeTrack({ song, pickedResult: picked, reference })).toBe(false);
  });
});

describe('ServiceClient alignment calls', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const status = (alignment: AlignmentStatus | null): SongStatus => ({
    song_id: 'k1',
    source: 'file',
    steps: {
      fetch: { state: 'skipped', progress: 0 },
      separation: { state: 'done', progress: 1 },
      key: { state: 'done', progress: 1 },
      reference: { state: 'skipped', progress: 0 },
      lyrics: { state: 'skipped', progress: 0 },
    },
    alignment,
  });
  const reply = (body: unknown, code = 200): Response =>
    new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });

  it('posts the original id to the karaoke song and returns its status', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return reply(status({ state: 'queued', progress: 0, original_id: 'o1' }));
    }) as typeof fetch;
    const client = new ServiceClient({ baseUrl: BASE, fetch: impl });

    const result = await client.alignSong('k1', 'o1');

    expect(calls[0].url).toBe(`${BASE}/songs/k1/align`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ original_id: 'o1' });
    expect(result.alignment?.state).toBe('queued');
  });

  it('turns a 422 into a rejection with the plain reason', async () => {
    const impl = (async () => reply({ detail: 'The original has no melody to follow yet.' }, 422)) as typeof fetch;
    const client = new ServiceClient({ baseUrl: BASE, fetch: impl });
    const failure = await client.alignSong('k1', 'o1').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ServiceError);
    expect((failure as ServiceError).kind).toBe('rejected');
    expect((failure as ServiceError).message).toBe('The original has no melody to follow yet.');
  });

  it('polls until the alignment ends and reports each update', async () => {
    const answers = [
      status({ state: 'running', progress: 0.3, original_id: 'o1' }),
      status({ state: 'done', progress: 1, original_id: 'o1', key_offset: 2, confidence: 0.9 }),
    ];
    const impl = (async () => reply(answers.shift())) as typeof fetch;
    const client = new ServiceClient({ baseUrl: BASE, fetch: impl });
    const seen: string[] = [];

    const pending = client.pollAlignment('k1', { onUpdate: (a) => seen.push(a.state) });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ state: 'done', key_offset: 2 });
    expect(seen).toEqual(['running', 'done']);
  });

  it('stops with null when the song has no alignment, and when aborted', async () => {
    const none = (async () => reply(status(null))) as typeof fetch;
    const client = new ServiceClient({ baseUrl: BASE, fetch: none });
    const pending = client.pollAlignment('k1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBeNull();

    const controller = new AbortController();
    const waiting = client.pollAlignment('k1', { signal: controller.signal });
    controller.abort();
    expect(await waiting).toBeNull();
  });
});
