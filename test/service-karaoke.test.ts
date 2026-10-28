/**
 * Tests for the service client's karaoke calls: the upload with its progress
 * and refusals (against a fake XMLHttpRequest, since fetch has no upload
 * progress), the stems with the gain they carry, the reference melody and the
 * check that turns away a body the lane could not draw, the song's key and its
 * shape check, and polling through a chosen step. The rules are pure and checked as tables; the network is stubbed
 * and time moves only when a test says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ServiceClient,
  ServiceError,
  isAbortError,
  settledThrough,
} from '../src/service/client';
import type { PollOutcome } from '../src/service/client';
import type { KeyMap, Reference, SongStatus, SongSteps, StepState, StepStatus } from '../src/service/types';
import { isKeyMap, isReference, parseStemGain } from '../src/service/wire';

const BASE = 'http://localhost:8765';
const ID = 'abc123';

function step(state: StepState = 'queued', progress = 0, extra: Partial<StepStatus> = {}): StepStatus {
  return { state, progress, error: null, detail: null, ...extra };
}

/** An uploaded song's status: the fetch is skipped for a file. */
function song(others: Partial<SongSteps> = {}): SongStatus {
  return {
    song_id: ID,
    title: 'Tune',
    duration_s: 200,
    source: 'file',
    steps: {
      fetch: step('skipped'),
      separation: step(),
      key: step('skipped'),
      reference: step(),
      lyrics: step(),
      ...others,
    },
  };
}

const REFERENCE: Reference = {
  contour: { hop_s: 0.01, t0_s: 0, f0_hz: [0, 220, 220], confidence: [0, 0.9, 0.9] },
  notes: [
    { onset_s: 0.01, offset_s: 0.03, midi: 57, cents_mean: 0, cents_std: 3, scoop_cents: 0 },
  ],
  range: { low_midi: 57, high_midi: 57 },
  unpitched_regions: [[1, 2]],
};

const KEY: KeyMap = {
  tuning_cents: -12.5,
  segments: [
    { start_s: 0, end_s: 40, tonic: 2, mode: 'major', confidence: 0.8 },
    { start_s: 40, end_s: 60, tonic: null, mode: null, confidence: 0.1 },
  ],
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch that answers every call through `handler` and records the URLs. */
function clientFor(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      Promise.resolve(handler(String(input))).then(resolve, reject);
    });
  }) as typeof fetch;
  return { client: new ServiceClient({ baseUrl: BASE, fetch: impl }), urls };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

/** The part of XMLHttpRequest the upload uses, driven by the test. */
class FakeXhr {
  status = 0;
  responseText = '';
  timeout = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readonly upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  opened: { method: string; url: string } | null = null;
  sent: FormData | null = null;
  aborted = false;
  open(method: string, url: string): void {
    this.opened = { method, url };
  }
  send(body: FormData): void {
    this.sent = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }
  answer(status: number, body: unknown): void {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

function uploader() {
  const xhr = new FakeXhr();
  const client = new ServiceClient({ baseUrl: `${BASE}/`, xhr: () => xhr as unknown as XMLHttpRequest });
  return { xhr, client };
}

const FILE = new File([new Uint8Array([1, 2, 3, 4])], 'tune.mp3', { type: 'audio/mpeg' });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('settledThrough', () => {
  it('waits while a step up to the one asked for is queued or running', () => {
    expect(settledThrough(song(), 'separation')).toBe(false);
    expect(settledThrough(song({ separation: step('running', 0.4) }), 'separation')).toBe(false);
    expect(settledThrough(song({ separation: step('done', 1) }), 'reference')).toBe(false);
    expect(
      settledThrough(song({ separation: step('done', 1), reference: step('running', 0.5) }), 'reference'),
    ).toBe(false);
  });

  it('is settled once every step up to it is done or skipped, whatever comes after', () => {
    expect(settledThrough(song({ separation: step('done', 1) }), 'separation')).toBe(true);
    expect(settledThrough(song({ separation: step('skipped', 0, { detail: 'No extra' }) }), 'separation')).toBe(true);
    expect(settledThrough(song({ separation: step('done', 1), reference: step('done', 1) }), 'reference')).toBe(true);
  });

  it('is settled by a failure, since the steps after it stay queued', () => {
    const failed = step('failed', 0.2, { error: 'Interrupted' });
    expect(settledThrough(song({ separation: failed }), 'separation')).toBe(true);
    expect(settledThrough(song({ separation: failed }), 'reference')).toBe(true);
    expect(settledThrough(song({ separation: step('done', 1), reference: failed }), 'reference')).toBe(true);
  });

  it('does not end the wait at a failed key: the service goes on to the melody without it', () => {
    const failedKey = step('failed', 0.2, { error: 'No chroma' });
    expect(settledThrough(song({ separation: step('done', 1), key: failedKey }), 'reference')).toBe(false);
    expect(
      settledThrough(song({ separation: step('done', 1), key: failedKey, reference: step('running', 0.3) }), 'reference'),
    ).toBe(false);
    expect(
      settledThrough(song({ separation: step('done', 1), key: failedKey, reference: step('done', 1) }), 'reference'),
    ).toBe(true);
    expect(settledThrough(song({ separation: step('done', 1), key: failedKey }), 'key')).toBe(true);
  });

  it('can wait for the key alone: separation, then the key, whatever the melody does', () => {
    expect(settledThrough(song({ separation: step('done', 1), key: step('running', 0.5) }), 'key')).toBe(false);
    expect(settledThrough(song({ separation: step('done', 1), key: step('done', 1) }), 'key')).toBe(true);
    expect(settledThrough(song({ separation: step('done', 1), key: step('skipped') }), 'key')).toBe(true);
  });

  it('does not wait for a step after the one asked for', () => {
    expect(settledThrough(song({ separation: step('done', 1), reference: step('queued') }), 'separation')).toBe(true);
    const later = song({ separation: step('done', 1), reference: step('done', 1), lyrics: step('running') });
    expect(settledThrough(later, 'reference')).toBe(true);
  });
});

describe('parseStemGain', () => {
  it('reads the header as a number and falls back to 1 for what is unusable', () => {
    expect(parseStemGain('0.8')).toBe(0.8);
    expect(parseStemGain('1.0')).toBe(1);
    for (const bad of [null, '', 'abc', '0', '-0.5', 'Infinity', 'NaN']) {
      expect(parseStemGain(bad), String(bad)).toBe(1);
    }
  });
});

describe('isReference', () => {
  it('accepts what the service sends', () => {
    expect(isReference(REFERENCE)).toBe(true);
    expect(isReference({ ...REFERENCE, notes: [], unpitched_regions: [] })).toBe(true);
  });

  it('turns away a body the lane could not draw', () => {
    const broken: unknown[] = [
      null,
      [],
      {},
      { ...REFERENCE, contour: { ...REFERENCE.contour, hop_s: 0 } },
      { ...REFERENCE, contour: { ...REFERENCE.contour, f0_hz: 'no' } },
      { ...REFERENCE, contour: { ...REFERENCE.contour, f0_hz: [1, NaN] } },
      { ...REFERENCE, range: { low_midi: 'a', high_midi: 3 } },
      { ...REFERENCE, notes: [{ onset_s: 0, offset_s: 1 }] },
      { ...REFERENCE, notes: 'x' },
      { ...REFERENCE, unpitched_regions: [[1]] },
      { ...REFERENCE, unpitched_regions: [[1, 2, 3]] },
    ];
    for (const body of broken) expect(isReference(body), JSON.stringify(body)).toBe(false);
  });
});

describe('ServiceClient.uploadSong', () => {
  it('posts the file as the form field "file" to /songs and answers with the status', async () => {
    const { xhr, client } = uploader();
    const result = client.uploadSong(FILE);
    expect(xhr.opened).toEqual({ method: 'POST', url: `${BASE}/songs` });
    const sent = xhr.sent?.get('file');
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('tune.mp3');
    const status = song();
    xhr.answer(200, status);
    expect(await result).toEqual(status);
  });

  it('reports the share sent, and ignores a size the browser cannot tell', async () => {
    const { xhr, client } = uploader();
    const seen: number[] = [];
    const result = client.uploadSong(FILE, { onProgress: (f) => seen.push(f) });
    xhr.progress(1, 4);
    xhr.progress(2, 4);
    xhr.progress(3, 0, false);
    xhr.progress(4, 4);
    xhr.answer(200, song());
    await result;
    expect(seen).toEqual([0.25, 0.5, 1]);
  });

  it('carries the service\'s own reason when it says no to a file', async () => {
    for (const [status, detail] of [
      [415, 'Unsupported audio file. Accepted: .mp3, .wav.'],
      [413, 'The file is over the 200 MiB limit.'],
      [400, 'The uploaded file is empty.'],
    ] as const) {
      const { xhr, client } = uploader();
      const result = failureOf(client.uploadSong(FILE));
      xhr.answer(status, { detail });
      const error = (await result) as ServiceError;
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.kind).toBe('rejected');
      expect(error.message).toBe(detail);
      expect(error.status).toBe(status);
    }
  });

  it('maps other failures like any call: a server error, a body it cannot read', async () => {
    const a = uploader();
    const server = failureOf(a.client.uploadSong(FILE));
    a.xhr.answer(500, 'oops');
    expect(await server).toMatchObject({ kind: 'unexpected', status: 500 });

    const b = uploader();
    const garbage = failureOf(b.client.uploadSong(FILE));
    b.xhr.answer(200, 'not json');
    expect(await garbage).toMatchObject({ kind: 'unexpected' });

    const c = uploader();
    const wrong = failureOf(c.client.uploadSong(FILE));
    c.xhr.answer(200, { hello: 'there' });
    expect(await wrong).toMatchObject({ kind: 'unexpected' });
  });

  it('says the service did not answer on a network error or a timeout', async () => {
    const a = uploader();
    const refused = failureOf(a.client.uploadSong(FILE));
    a.xhr.onerror?.();
    expect(await refused).toMatchObject({ kind: 'unreachable' });

    const b = uploader();
    const slow = failureOf(b.client.uploadSong(FILE));
    b.xhr.ontimeout?.();
    expect(await slow).toMatchObject({ kind: 'unreachable' });
  });

  it('stops when the caller aborts, and never starts if it already had', async () => {
    const { xhr, client } = uploader();
    const controller = new AbortController();
    const result = failureOf(client.uploadSong(FILE, { signal: controller.signal }));
    controller.abort();
    expect(xhr.aborted).toBe(true);
    expect(isAbortError(await result)).toBe(true);

    const second = uploader();
    const early = new AbortController();
    early.abort();
    const error = await failureOf(second.client.uploadSong(FILE, { signal: early.signal }));
    expect(isAbortError(error)).toBe(true);
    expect(second.xhr.sent).toBeNull();
  });
});

describe('ServiceClient.fetchStem', () => {
  it('returns the bytes with the gain from the X-Stem-Gain header', async () => {
    const { client, urls } = clientFor(
      () => new Response(new Uint8Array([7, 8, 9]), { headers: { 'X-Stem-Gain': '0.75' } }),
    );
    const stem = await client.fetchStem('yt-abc', 'no_vocals');
    expect(urls).toEqual([`${BASE}/songs/yt-abc/stems/no_vocals`]);
    expect([...new Uint8Array(stem.bytes)]).toEqual([7, 8, 9]);
    expect(stem.gain).toBe(0.75);
  });

  it('reads a missing or unusable header as no scaling', async () => {
    const { client } = clientFor(() => new Response(new Uint8Array([1])));
    expect((await client.fetchStem(ID, 'vocals')).gain).toBe(1);
  });

  it('answers a 409 as not fetched: the song has not been separated yet', async () => {
    const { client } = clientFor(() => jsonResponse({ detail: 'Song not separated yet.' }, 409));
    expect(await failureOf(client.fetchStem(ID, 'vocals'))).toMatchObject({ kind: 'not-fetched', status: 409 });
  });

  it('is stopped by the caller\'s signal', async () => {
    const { client } = clientFor(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const result = failureOf(client.fetchStem(ID, 'vocals', controller.signal));
    controller.abort();
    expect(isAbortError(await result)).toBe(true);
  });
});

describe('ServiceClient.fetchReference', () => {
  it('returns the melody the service sends', async () => {
    const { client, urls } = clientFor(() => jsonResponse(REFERENCE));
    expect(await client.fetchReference(ID)).toEqual(REFERENCE);
    expect(urls).toEqual([`${BASE}/songs/${ID}/reference`]);
  });

  it('answers a 409 as not fetched: there is no melody', async () => {
    const { client } = clientFor(() => jsonResponse({ detail: 'Song has no reference melody.' }, 409));
    expect(await failureOf(client.fetchReference(ID))).toMatchObject({ kind: 'not-fetched' });
  });

  it('refuses a body that is not a melody', async () => {
    const { client } = clientFor(() => jsonResponse({ contour: {} }));
    expect(await failureOf(client.fetchReference(ID))).toMatchObject({ kind: 'unexpected' });
  });
});

describe('isKeyMap', () => {
  it('accepts a key map with clear and unclear stretches', () => {
    expect(isKeyMap(KEY)).toBe(true);
    expect(isKeyMap({ tuning_cents: 0, segments: [] })).toBe(true);
  });

  it('turns away a body the key fit could not use', () => {
    const seg = KEY.segments[0];
    const broken: unknown[] = [
      null,
      [],
      {},
      { segments: KEY.segments },
      { tuning_cents: 'flat', segments: [] },
      { tuning_cents: Number.NaN, segments: [] },
      { tuning_cents: 0, segments: 'none' },
      { tuning_cents: 0, segments: [{ ...seg, start_s: 'zero' }] },
      { tuning_cents: 0, segments: [{ ...seg, tonic: 12 }] },
      { tuning_cents: 0, segments: [{ ...seg, tonic: 2.5 }] },
      { tuning_cents: 0, segments: [{ ...seg, mode: 'dorian' }] },
      { tuning_cents: 0, segments: [{ ...seg, mode: null }] },
      { tuning_cents: 0, segments: [{ ...seg, tonic: null, mode: 'major' }] },
      { tuning_cents: 0, segments: [{ ...seg, confidence: undefined }] },
    ];
    for (const value of broken) expect(isKeyMap(value), JSON.stringify(value)).toBe(false);
  });
});

describe('ServiceClient.fetchKey', () => {
  it('returns the key the service sends', async () => {
    const { client, urls } = clientFor(() => jsonResponse(KEY));
    expect(await client.fetchKey(ID)).toEqual(KEY);
    expect(urls).toEqual([`${BASE}/songs/${ID}/key`]);
  });

  it('answers a 409 as not fetched: there is no key, and a 404 as not found', async () => {
    const none = clientFor(() => jsonResponse({ detail: 'Song has no key yet.' }, 409));
    expect(await failureOf(none.client.fetchKey(ID))).toMatchObject({ kind: 'not-fetched' });
    const gone = clientFor(() => jsonResponse({ detail: 'No such song.' }, 404));
    expect(await failureOf(gone.client.fetchKey(ID))).toMatchObject({ kind: 'not-found' });
  });

  it('refuses a body that is not a key map', async () => {
    const { client } = clientFor(() => jsonResponse({ tuning_cents: 0, segments: [{ tonic: 3 }] }));
    expect(await failureOf(client.fetchKey(ID))).toMatchObject({ kind: 'unexpected' });
  });
});

describe('ServiceClient.pollSong through a step', () => {
  function scripted(statuses: SongStatus[]) {
    let next = 0;
    return clientFor(() => jsonResponse(statuses[Math.min(next++, statuses.length - 1)]));
  }

  it('keeps polling past the fetch until the step asked for has settled', async () => {
    const { client, urls } = scripted([
      song({ separation: step('queued') }),
      song({ separation: step('running', 0.5) }),
      song({ separation: step('done', 1), reference: step('running', 0.2) }),
    ]);
    const seen: number[] = [];
    let outcome: PollOutcome | undefined;
    void client
      .pollSong(ID, { through: 'separation', onUpdate: (s) => seen.push(s.steps.separation.progress) })
      .then((o) => {
        outcome = o;
      });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(urls).toHaveLength(3);
    expect(seen).toEqual([0, 0.5, 1]);
    expect(outcome).toMatchObject({ kind: 'settled' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles on a failure of a step it was waiting through, with the status to read it from', async () => {
    const failed = song({ separation: step('failed', 0.3, { error: 'Separating the vocal failed: out of memory' }) });
    const { client } = scripted([failed]);
    let outcome: PollOutcome | undefined;
    void client.pollSong(ID, { through: 'reference' }).then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(outcome).toEqual({ kind: 'settled', status: failed });
  });

  it('is stopped by the signal like any poll', async () => {
    const { client } = scripted([song()]);
    const controller = new AbortController();
    let outcome: PollOutcome | undefined;
    void client.pollSong(ID, { through: 'separation', signal: controller.signal }).then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(1200);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toEqual({ kind: 'aborted' });
  });
});
