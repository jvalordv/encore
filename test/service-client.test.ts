/**
 * Tests for the service client against a stubbed `fetch` and fake timers, so
 * no request leaves the process and time moves only when a test says so. They
 * cover the five calls (health with its short timeout, adding a link with its
 * 422 and 502 refusals, one status, the audio with its 409), the typed
 * failures and what each is made from, the abort a caller can send, and the
 * polling rules: the backoff schedule, when a status settles the wait, one
 * dropped poll not losing a download, and a newer load stopping the poll at
 * once. The rules themselves are pure functions and are checked as tables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  POLL_MAX_UNANSWERED,
  REQUEST_TIMEOUT_MS,
  ServiceClient,
  ServiceError,
  failedStep,
  isAbortError,
  isSongStatus,
  kindOfStatus,
  plainDetail,
  pollDelayMs,
  settledAs,
} from '../src/service/client';
import type { PollOutcome } from '../src/service/client';
import type { SongStatus, SongSteps, StepState, StepStatus } from '../src/service/types';

const BASE = 'http://localhost:8765';
const ID = 'yt-dQw4w9WgXcQ';

function step(state: StepState = 'queued', progress = 0, extra: Partial<StepStatus> = {}): StepStatus {
  return { state, progress, error: null, detail: null, ...extra };
}

/** A link song's status as the service sends it, with the given steps. */
function song(fetchStep: StepStatus, others: Partial<SongSteps> = {}): SongStatus {
  return {
    song_id: ID,
    title: 'Some Video',
    duration_s: 213,
    source: 'youtube',
    steps: { fetch: fetchStep, separation: step(), key: step('skipped'), reference: step(), lyrics: step(), ...others },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Rejects the way fetch does when its signal aborts before the answer. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject);
  });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A fetch that records its calls and answers them through `handler`. */
function stub(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = init ?? {};
    calls.push({ url: String(input), init: request });
    return abortable(
      Promise.resolve().then(() => handler(String(input), request)),
      request.signal,
    );
  }) as typeof fetch;
  return { impl, calls };
}

/** A handler that never answers, for the timeouts. */
const silence: Handler = () => new Promise<Response>(() => undefined);

function clientFor(handler: Handler, options: { baseUrl?: string } = {}) {
  const fetchStub = stub(handler);
  const client = new ServiceClient({ baseUrl: options.baseUrl ?? BASE, fetch: fetchStub.impl });
  return { client, calls: fetchStub.calls };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pollDelayMs', () => {
  it('starts at 500 ms and grows to a 2 s cap', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(pollDelayMs)).toEqual([500, 750, 1125, 1688, 2000, 2000, 2000, 2000]);
  });

  it('reads a negative or unusable attempt count as the first', () => {
    for (const bad of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) expect(pollDelayMs(bad)).toBe(500);
    expect(pollDelayMs(Number.POSITIVE_INFINITY)).toBe(500);
    expect(pollDelayMs(1.9)).toBe(750);
  });
});

describe('settledAs', () => {
  const failing = step('failed', 0.3, { error: 'Download failed: HTTP Error 403' });

  it('keeps waiting while the fetch is queued or running and nothing has failed', () => {
    expect(settledAs(song(step('queued')))).toBeNull();
    expect(settledAs(song(step('running', 0.45)))).toBeNull();
    expect(settledAs(song(step('running', 0.9), { separation: step('running', 0.1) }))).toBeNull();
  });

  it('settles as fetched once the fetch is done, whatever the later steps say', () => {
    expect(settledAs(song(step('done', 1)))).toBe('fetched');
    expect(settledAs(song(step('done', 1), { separation: step('skipped', 0, { detail: 'Not built yet' }) }))).toBe(
      'fetched',
    );
    // The audio is what the app is after: a later step failing is no stop.
    expect(settledAs(song(step('done', 1), { reference: failing }))).toBe('fetched');
  });

  it('reads a skipped fetch as having nothing to wait for', () => {
    expect(settledAs(song(step('skipped')))).toBe('fetched');
  });

  it('settles as failed when the fetch has failed, later steps still queued after a restart', () => {
    expect(settledAs(song(failing))).toBe('failed');
  });

  it('settles as failed when any step has failed before the fetch is done', () => {
    for (const name of ['separation', 'reference', 'lyrics'] as const) {
      expect(settledAs(song(step('running', 0.5), { [name]: failing })), name).toBe('failed');
    }
  });
});

describe('failedStep', () => {
  it('names the first failed step in run order, or none', () => {
    const failing = step('failed', 0, { error: 'x' });
    expect(failedStep(song(step('done', 1)))).toBeNull();
    expect(failedStep(song(failing))).toBe('fetch');
    expect(failedStep(song(step('done', 1), { lyrics: failing, reference: failing }))).toBe('reference');
  });
});

describe('kindOfStatus and plainDetail', () => {
  it('maps the documented statuses to the typed failures', () => {
    expect(kindOfStatus(404)).toBe('not-found');
    expect(kindOfStatus(409)).toBe('not-fetched');
    expect(kindOfStatus(422)).toBe('rejected');
    expect(kindOfStatus(502)).toBe('rejected');
    for (const other of [400, 401, 413, 415, 500, 503]) expect(kindOfStatus(other), String(other)).toBe('unexpected');
  });

  it('reads the service\'s plain detail, a framework list of problems, or the fallback', () => {
    expect(plainDetail({ detail: ' This video is 20 min long. ' }, 'x')).toBe('This video is 20 min long.');
    expect(plainDetail({ detail: [{ msg: 'Field required' }, { msg: 'Bad value' }, { loc: [] }] }, 'x')).toBe(
      'Field required; Bad value',
    );
    for (const odd of [null, undefined, 4, 'text', {}, { detail: '' }, { detail: '  ' }, { detail: [] }, { detail: 7 }]) {
      expect(plainDetail(odd, 'fallback'), String(odd)).toBe('fallback');
    }
  });
});

describe('isSongStatus', () => {
  it('accepts a status as the service sends it, nulls included', () => {
    expect(isSongStatus(song(step('running', 0.4)))).toBe(true);
    expect(isSongStatus({ ...song(step()), title: null, duration_s: null, source: 'file' })).toBe(true);
  });

  it('rejects anything the app could not use', () => {
    const good = song(step());
    const broken: unknown[] = [
      null,
      'text',
      [],
      {},
      { ...good, song_id: '' },
      { ...good, song_id: 4 },
      { ...good, source: 'dropbox' },
      { ...good, steps: null },
      { ...good, steps: { ...good.steps, fetch: undefined } },
      { ...good, steps: { ...good.steps, key: undefined } },
      { ...good, steps: { ...good.steps, key: { state: 'sleeping', progress: 0 } } },
      { ...good, steps: { ...good.steps, lyrics: { state: 'sleeping', progress: 0 } } },
      { ...good, steps: { ...good.steps, reference: { state: 'done', progress: 'all' } } },
      { ...good, steps: { ...good.steps, reference: { state: 'done', progress: Number.NaN } } },
    ];
    for (const value of broken) expect(isSongStatus(value), JSON.stringify(value)).toBe(false);
  });
});

describe('ServiceClient.health', () => {
  it('is true when the service answers ok, and asks /health with a GET', async () => {
    const { client, calls } = clientFor(() => json({ status: 'ok', version: '0.1.0' }));
    expect(await client.health()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/health`);
    expect(calls[0].init.method).toBe('GET');
  });

  it('drops a trailing slash from the address', async () => {
    const { client, calls } = clientFor(() => json({ status: 'ok' }), { baseUrl: `${BASE}///` });
    await client.health();
    expect(calls[0].url).toBe(`${BASE}/health`);
  });

  it('is false for another server, an error status, a refused connection, or junk', async () => {
    expect(await clientFor(() => json({ status: 'starting' })).client.health()).toBe(false);
    expect(await clientFor(() => json({})).client.health()).toBe(false);
    expect(await clientFor(() => json({ detail: 'Not Found' }, 404)).client.health()).toBe(false);
    expect(await clientFor(() => new Response('<html>', { status: 200 })).client.health()).toBe(false);
    const refused = clientFor(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await refused.client.health()).toBe(false);
  });

  it('is false, and does not wait for ever, when the service does not answer within 1.5 s', async () => {
    expect(HEALTH_TIMEOUT_MS).toBe(1500);
    const { client } = clientFor(silence);
    let result: boolean | undefined;
    void client.health().then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is false, and sends nothing, for a signal that is already aborted', async () => {
    const { client, calls } = clientFor(() => json({ status: 'ok' }));
    const controller = new AbortController();
    controller.abort();
    expect(await client.health(controller.signal)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('is false when the caller aborts the check, and leaves no timer behind', async () => {
    const { client } = clientFor(silence);
    const controller = new AbortController();
    const pending = client.health(controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ServiceClient.createSongFromUrl', () => {
  const LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  it('posts the link as JSON and answers with the status', async () => {
    const status = song(step('queued'));
    const { client, calls } = clientFor(() => json(status));
    expect(await client.createSongFromUrl(LINK)).toEqual(status);
    expect(calls[0].url).toBe(`${BASE}/songs/url`);
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: LINK });
  });

  it('reads a cache hit as the status it is, fetch done and all', async () => {
    const status = song(step('done', 1));
    const { client } = clientFor(() => json(status));
    expect((await client.createSongFromUrl(LINK)).steps.fetch.state).toBe('done');
  });

  it('turns a 422 into a rejection that carries the service\'s plain reason', async () => {
    const detail = 'This video is 20 min long; the limit is 15 min (ENCORE_MAX_SONG_S).';
    const { client } = clientFor(() => json({ detail }, 422));
    const error = await failureOf(client.createSongFromUrl(LINK));
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ kind: 'rejected', status: 422, message: detail });
  });

  it('turns a 502 into a rejection that carries yt-dlp\'s text and the update hint', async () => {
    const detail = 'YouTube lookup failed: ERROR: Video unavailable. Update yt-dlp: uv lock --upgrade-package yt-dlp';
    const { client } = clientFor(() => json({ detail }, 502));
    expect(await failureOf(client.createSongFromUrl(LINK))).toMatchObject({
      kind: 'rejected',
      status: 502,
      message: detail,
    });
  });

  it('says something when a refusal has no readable reason', async () => {
    const { client } = clientFor(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await failureOf(client.createSongFromUrl(LINK))).toMatchObject({
      kind: 'rejected',
      message: 'The service refused the request (HTTP 502).',
    });
  });

  it('is unreachable when there is no answer, and when the answer takes over 30 s', async () => {
    const refused = clientFor(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await failureOf(refused.client.createSongFromUrl(LINK));
    expect(error).toMatchObject({ kind: 'unreachable', status: null });
    expect((error as ServiceError).cause).toBeInstanceOf(TypeError);

    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    const slow = clientFor(silence);
    const pending = failureOf(slow.client.createSongFromUrl(LINK));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await pending).toMatchObject({ kind: 'unreachable' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is unexpected for a server error, for a body that is not JSON, and for a status it cannot use', async () => {
    expect(await failureOf(clientFor(() => json({ detail: 'boom' }, 500)).client.createSongFromUrl(LINK))).toMatchObject(
      { kind: 'unexpected', status: 500, message: 'The service answered with an error (HTTP 500).' },
    );
    expect(await failureOf(clientFor(() => new Response('oops')).client.createSongFromUrl(LINK))).toMatchObject({
      kind: 'unexpected',
    });
    expect(await failureOf(clientFor(() => json({ song_id: ID })).client.createSongFromUrl(LINK))).toMatchObject({
      kind: 'unexpected',
    });
  });

  it('throws an AbortError, not a ServiceError, when the caller aborts', async () => {
    const { client } = clientFor(silence);
    const controller = new AbortController();
    const pending = failureOf(client.createSongFromUrl(LINK, controller.signal));
    controller.abort();
    const error = await pending;
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ServiceError);
  });
});

describe('ServiceClient.getSong', () => {
  it('reads one status, with the id escaped into the path', async () => {
    const status = song(step('running', 0.45));
    const { client, calls } = clientFor(() => json(status));
    expect(await client.getSong('yt-a/b?c')).toEqual(status);
    expect(calls[0].url).toBe(`${BASE}/songs/yt-a%2Fb%3Fc`);
    expect(calls[0].init.method).toBe('GET');
  });

  it('is not-found for a song the service does not know', async () => {
    const { client } = clientFor(() => json({ detail: 'No such song.' }, 404));
    expect(await failureOf(client.getSong(ID))).toMatchObject({ kind: 'not-found', status: 404 });
  });
});

describe('ServiceClient.fetchSongAudio', () => {
  it('returns the bytes of the stored file', async () => {
    const bytes = new Uint8Array([102, 76, 97, 67, 0, 1, 2, 3, 255]);
    const { client, calls } = clientFor(() => new Response(bytes, { headers: { 'content-type': 'audio/flac' } }));
    const buffer = await client.fetchSongAudio(ID);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buffer)]).toEqual([...bytes]);
    expect(calls[0].url).toBe(`${BASE}/songs/${ID}/audio`);
  });

  it('is not-fetched for a 409, the sign that the audio is gone and the link must be added again', async () => {
    const { client } = clientFor(() => json({ detail: 'Song not fetched yet.' }, 409));
    expect(await failureOf(client.fetchSongAudio(ID))).toMatchObject({ kind: 'not-fetched', status: 409 });
  });

  it('is not-found for a 404', async () => {
    const { client } = clientFor(() => json({ detail: 'No such song.' }, 404));
    expect(await failureOf(client.fetchSongAudio(ID))).toMatchObject({ kind: 'not-found' });
  });

  it('is unreachable when the connection drops while the body arrives', async () => {
    const dropping = {
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.reject(new TypeError('network error')),
    } as unknown as Response;
    const { client } = clientFor(() => dropping);
    expect(await failureOf(client.fetchSongAudio(ID))).toMatchObject({ kind: 'unreachable' });
  });

  it('gives a download two minutes', async () => {
    expect(AUDIO_TIMEOUT_MS).toBe(120_000);
    const { client } = clientFor(silence);
    const pending = failureOf(client.fetchSongAudio(ID));
    await vi.advanceTimersByTimeAsync(AUDIO_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ kind: 'unreachable' });
  });
});

describe('ServiceClient.pollSong', () => {
  /** A service that answers each status request with the next of `statuses`. */
  function scripted(statuses: Array<SongStatus | Error>) {
    const times: number[] = [];
    const start = Date.now();
    let next = 0;
    const handler: Handler = () => {
      times.push(Date.now() - start);
      const item = statuses[Math.min(next++, statuses.length - 1)];
      return item instanceof Error ? Promise.reject(item) : json(item);
    };
    return { ...clientFor(handler), times };
  }

  /** Polls and returns a getter for the outcome once it is in. */
  function polling(client: ServiceClient, options: Parameters<ServiceClient['pollSong']>[1] = {}) {
    const result: { outcome?: PollOutcome; error?: unknown } = {};
    void client.pollSong(ID, options).then(
      (outcome) => {
        result.outcome = outcome;
      },
      (error) => {
        result.error = error;
      },
    );
    return result;
  }

  it('asks at 500 ms, then 750 later, 1125 after that, and so on, until the fetch is done', async () => {
    const { client, times } = scripted([
      song(step('queued')),
      song(step('running', 0.2)),
      song(step('running', 0.45)),
      song(step('done', 1)),
    ]);
    const seen: number[] = [];
    const result = polling(client, { onUpdate: (status) => seen.push(status.steps.fetch.progress) });
    await vi.advanceTimersByTimeAsync(499);
    expect(times).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([500]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(times).toEqual([500, 1250, 2375, 4063]);
    expect(result.outcome).toMatchObject({ kind: 'fetched' });
    expect(seen).toEqual([0, 0.2, 0.45, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles with the status that ended it', async () => {
    const done = song(step('done', 1), { separation: step('skipped', 0, { detail: 'Not built yet' }) });
    const { client } = scripted([done]);
    const result = polling(client);
    await vi.advanceTimersByTimeAsync(500);
    expect(result.outcome).toEqual({ kind: 'fetched', status: done });
  });

  it('keeps the wait at its 2 s cap once it gets there', async () => {
    const { client, times } = scripted([song(step('running', 0.1))]);
    polling(client);
    await vi.advanceTimersByTimeAsync(500 + 750 + 1125 + 1688 + 2000 * 3);
    expect(times).toEqual([500, 1250, 2375, 4063, 6063, 8063, 10_063]);
  });

  it('settles at once when a step has failed, though the later steps are still queued', async () => {
    const failed = song(step('failed', 0.3, { error: 'Interrupted by a restart. Add the song again to retry.' }));
    const { client, times } = scripted([failed]);
    const result = polling(client);
    await vi.advanceTimersByTimeAsync(500);
    expect(result.outcome).toEqual({ kind: 'failed', status: failed, step: 'fetch' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(times).toEqual([500]);
  });

  it('settles as failed for a later step failing before the fetch is done', async () => {
    const failed = song(step('running', 0.9), { lyrics: step('failed', 0, { error: 'No words found' }) });
    const { client } = scripted([failed]);
    const result = polling(client);
    await vi.advanceTimersByTimeAsync(500);
    expect(result.outcome).toMatchObject({ kind: 'failed', step: 'lyrics' });
  });

  it('stops at once, with no further request, when the signal aborts during a wait', async () => {
    const { client, times } = scripted([song(step('running', 0.1))]);
    const controller = new AbortController();
    const result = polling(client, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1000);
    expect(times).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toEqual({ kind: 'aborted' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(times).toHaveLength(1);
  });

  it('stops when the signal aborts with a request in flight, and does not report its answer', async () => {
    const updates: SongStatus[] = [];
    const { client, calls } = clientFor(silence);
    const controller = new AbortController();
    const result = polling(client, { signal: controller.signal, onUpdate: (s) => updates.push(s) });
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toEqual({ kind: 'aborted' });
    expect(updates).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is aborted, not failed, when the caller gave up just as an error came back', async () => {
    const controller = new AbortController();
    // A fetch that ignores the abort and answers with a 404 anyway.
    const client = new ServiceClient({
      baseUrl: BASE,
      fetch: (async () => {
        controller.abort();
        return json({ detail: 'No such song.' }, 404);
      }) as typeof fetch,
    });
    const result = polling(client, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(500);
    expect(result.outcome).toEqual({ kind: 'aborted' });
    expect(result.error).toBeUndefined();
  });

  it('does not start when the signal is aborted already', async () => {
    const { client, calls } = clientFor(() => json(song(step('done', 1))));
    const controller = new AbortController();
    controller.abort();
    const result = polling(client, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5000);
    expect(result.outcome).toEqual({ kind: 'aborted' });
    expect(calls).toHaveLength(0);
  });

  it('tries again after a poll nobody answers, and counts only the ones in a row', async () => {
    const dropped = new TypeError('Failed to fetch');
    const { client, times } = scripted([
      dropped,
      dropped,
      song(step('running', 0.5)),
      dropped,
      dropped,
      song(step('done', 1)),
    ]);
    const result = polling(client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(times).toHaveLength(6);
    expect(result.outcome).toMatchObject({ kind: 'fetched' });
  });

  it('gives up with an unreachable error after three unanswered polls in a row', async () => {
    expect(POLL_MAX_UNANSWERED).toBe(3);
    const { client, times } = scripted([new TypeError('Failed to fetch')]);
    const result = polling(client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(times).toHaveLength(3);
    expect(result.error).toMatchObject({ kind: 'unreachable' });
    expect(result.outcome).toBeUndefined();
  });

  it('fails at once for a song the service no longer has', async () => {
    const { client, calls } = clientFor(() => json({ detail: 'No such song.' }, 404));
    const result = polling(client);
    await vi.advanceTimersByTimeAsync(500);
    expect(result.error).toMatchObject({ kind: 'not-found' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
  });
});
