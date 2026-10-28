/**
 * Typed client for the optional Python service (see "Song sources" in
 * docs/ARCHITECTURE.md and the routes in service/encore_service/routes/
 * songs.py). It wraps the calls the browser makes: `health` (is the service
 * running), `createSongFromUrl` (add a YouTube link), `uploadSong` (add a
 * file, with progress), `getSong` (one status), `fetchSongAudio` (the stored
 * audio), `fetchStem` (the vocal or the backing, with the gain they were
 * scaled by), `fetchReference` (the melody) and `pollSong` (a status loop that
 * ends when the audio is fetched, when a chosen step has settled, or when a
 * step has failed). Nothing here decides to talk to the service: the caller
 * does, and a client is built from the `serviceUrl` setting each time, so a
 * changed setting needs no restart.
 *
 * A failed call throws a ServiceError whose `kind` says what to do about it:
 * 'unreachable' (no answer, or too slow), 'rejected' (a 422 or 502 whose plain
 * `detail` is the message), 'not-found' (404), 'not-fetched' (409: the song has
 * no audio) or 'unexpected' (anything else). A caller that gives up through its
 * AbortSignal gets an AbortError instead, which is no fault of the service.
 * `health` never throws. The polling rules are pure exports (`pollDelayMs`,
 * `settledAs`, `failedStep`), tested apart from any network. `fetch` and the
 * timers are the page's own unless injected, which is how the tests run with no
 * network.
 */
import { STEP_NAMES } from './types';
import type { Reference, SongLinkRequest, SongStatus, StemName, StepName, StepState } from './types';
import { postFile } from './upload';
import { isReference, parseStemGain, STEM_GAIN_HEADER } from './wire';
import type { StemDownload } from './wire';

/** Longest GET /health may take before the service counts as not running. */
export const HEALTH_TIMEOUT_MS = 1500;

/** Longest a link or status request may take, the link lookup included. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Longest the audio download may take, body included. */
export const AUDIO_TIMEOUT_MS = 120_000;

/** Longest an upload may take, the service's reply included. */
export const UPLOAD_TIMEOUT_MS = 300_000;

/** Wait before the first status poll, and the most the wait grows to. */
export const POLL_FIRST_MS = 500;
export const POLL_MAX_MS = 2000;
const POLL_GROWTH = 1.5;

/** Polls in a row that may go unanswered before the song is given up on. */
export const POLL_MAX_UNANSWERED = 3;

const STEP_STATES: ReadonlySet<string> = new Set<StepState>([
  'queued',
  'running',
  'done',
  'failed',
  'skipped',
]);

const UNREACHABLE_MESSAGE = 'The service did not answer.';
const NOT_FOUND_MESSAGE = 'The service does not have that song.';
const NOT_FETCHED_MESSAGE = 'The service has no audio for that song yet.';
const BAD_BODY_MESSAGE = 'The service sent an answer this app cannot read.';

/** What a failed call comes to; see the module comment. */
export type ServiceErrorKind =
  | 'unreachable'
  | 'rejected'
  | 'not-found'
  | 'not-fetched'
  | 'unexpected';

/** A call the service did not answer, or answered with a refusal. */
export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;
  /** The HTTP status, or null when no answer came. */
  readonly status: number | null;

  constructor(
    kind: ServiceErrorKind,
    message: string,
    status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ServiceError';
    this.kind = kind;
    this.status = status;
  }
}

/** An error saying the caller's own signal stopped the call. */
function abortError(): Error {
  return new DOMException('The call was aborted.', 'AbortError');
}

/** True for what a call throws when its caller aborted it. */
export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

/** The kind of failure an HTTP status stands for. */
export function kindOfStatus(status: number): ServiceErrorKind {
  if (status === 404) return 'not-found';
  if (status === 409) return 'not-fetched';
  if (status === 422 || status === 502) return 'rejected';
  return 'unexpected';
}

/**
 * The plain sentence in an error body. FastAPI's own `detail` is a string, or
 * a list of problems with a `msg` each when the request itself was malformed;
 * anything else reads as `fallback`.
 */
export function plainDetail(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail.trim() || fallback;
  if (!Array.isArray(detail)) return fallback;
  const problems = detail
    .map((item) => (item as { msg?: unknown } | null)?.msg)
    .filter((msg): msg is string => typeof msg === 'string' && msg.trim() !== '');
  return problems.length > 0 ? problems.join('; ') : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` is a song status this app can use. */
export function isSongStatus(value: unknown): value is SongStatus {
  if (!isRecord(value) || typeof value.song_id !== 'string' || value.song_id === '') return false;
  if (value.source !== 'file' && value.source !== 'youtube') return false;
  const { steps } = value;
  if (!isRecord(steps)) return false;
  return STEP_NAMES.every((name) => {
    const step = steps[name];
    return (
      isRecord(step) &&
      typeof step.state === 'string' &&
      STEP_STATES.has(step.state) &&
      typeof step.progress === 'number' &&
      Number.isFinite(step.progress)
    );
  });
}

/**
 * How a song's status ends the wait for it. 'fetched' once the audio is in the
 * cache (`fetch` is done, or skipped, which a link never is but costs nothing
 * to read the same way): the audio is what the app is after, so a later step
 * failing does not hold it back. 'failed' when any step has failed: a song
 * interrupted by a restart fails one step and leaves the later ones queued, so
 * waiting for them to move would wait for ever. Null while it is still going.
 */
export function settledAs(status: SongStatus): 'fetched' | 'failed' | null {
  const { fetch } = status.steps;
  if (fetch.state === 'done' || fetch.state === 'skipped') return 'fetched';
  return failedStep(status) === null ? null : 'failed';
}

/** The first step, in run order, that has failed; null when none has. */
export function failedStep(status: SongStatus): StepName | null {
  return STEP_NAMES.find((name) => status.steps[name].state === 'failed') ?? null;
}

/**
 * True once every step up to and including `upTo` has run its course: done,
 * skipped or failed. A step that failed ends the wait early, since the ones
 * after it stay queued (a restart interrupts a song that way) and the caller
 * reads the failure from the step itself.
 */
export function settledThrough(status: SongStatus, upTo: StepName): boolean {
  for (const name of STEP_NAMES) {
    const { state } = status.steps[name];
    if (state === 'failed') return true;
    if (state === 'queued' || state === 'running') return false;
    if (name === upTo) return true;
  }
  return true;
}

/**
 * Wait before the poll that follows `attempt` earlier ones: 500 ms, then 750,
 * 1125, 1688 and 2000 from there on. Slow enough not to hammer a service busy
 * downloading, quick enough that a short fetch is noticed.
 */
export function pollDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(POLL_MAX_MS, Math.round(POLL_FIRST_MS * POLL_GROWTH ** n));
}

/**
 * What pollSong reports when it stops. 'settled' answers `through` (see
 * PollOptions): the steps up to it have run their course, whichever way.
 */
export type PollOutcome =
  | { kind: 'fetched'; status: SongStatus }
  | { kind: 'settled'; status: SongStatus }
  | { kind: 'failed'; status: SongStatus; step: StepName }
  | { kind: 'aborted' };

/** Options of pollSong. */
export interface PollOptions {
  /** Called with every status the service reports, the last one included. */
  onUpdate?: (status: SongStatus) => void;
  /** Stops the polling at once; pollSong then settles as 'aborted'. */
  signal?: AbortSignal;
  /**
   * Keep polling until the steps up to this one have settled (see
   * `settledThrough`), whatever the later ones do. Without it the poll ends
   * when the audio is fetched or any step has failed.
   */
  through?: StepName;
}

/** Resolves true after `ms`, or false at once if `signal` aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reads a body as JSON; a body that is not is the service's fault. */
async function readJson(response: Response): Promise<unknown> {
  // Read as text first so a connection that drops mid-body stays a network
  // failure, while text that is not JSON is told apart from it.
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServiceError('unexpected', BAD_BODY_MESSAGE, response.status);
  }
}

/** Parses text as JSON; null for what is not (an error page, no body). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The ServiceError for a failing status and the JSON body that came with it. */
function failureFrom(status: number, body: unknown): ServiceError {
  const kind = kindOfStatus(status);
  switch (kind) {
    case 'rejected':
      return new ServiceError(
        kind,
        plainDetail(body, `The service refused the request (HTTP ${status}).`),
        status,
      );
    case 'not-found':
      return new ServiceError(kind, NOT_FOUND_MESSAGE, status);
    case 'not-fetched':
      return new ServiceError(kind, NOT_FETCHED_MESSAGE, status);
    default:
      return new ServiceError(kind, `The service answered with an error (HTTP ${status}).`, status);
  }
}

/** The ServiceError for a response with a failing status. */
async function failureOf(response: Response): Promise<ServiceError> {
  // An error page that is not JSON leaves the status alone to do the talking.
  return failureFrom(response.status, parseJson(await response.text()));
}

/** Everything injectable; only the address is required. */
export interface ServiceClientOptions {
  /** Base URL without a trailing slash: the `serviceUrl` setting. */
  baseUrl: string;
  /** The fetch to use; the page's own, looked up at each call, by default. */
  fetch?: typeof fetch;
  healthTimeoutMs?: number;
  requestTimeoutMs?: number;
  audioTimeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Builds the upload's request; the page's own XMLHttpRequest by default. */
  xhr?: () => XMLHttpRequest;
}

/** What an upload is told and what it reports. */
export interface UploadCallOptions {
  /** Called with the share sent, 0 to 1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** The service's HTTP API, as far as the browser uses it. */
export class ServiceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly healthTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly audioTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly xhrFactory: (() => XMLHttpRequest) | undefined;

  constructor(options: ServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.audioTimeoutMs = options.audioTimeoutMs ?? AUDIO_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
    this.xhrFactory = options.xhr;
  }

  /**
   * True when the encore service answers on this address within about 1.5 s.
   * Anything else (a refused connection, a timeout, another server with no
   * /health) is false; this never throws.
   */
  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const limits = { timeoutMs: this.healthTimeoutMs, signal };
      const body = await this.call('/health', { method: 'GET' }, limits, readJson);
      return isRecord(body) && body.status === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Adds a YouTube link as a song and answers with its status. A repeat of a
   * link the service has is a cache hit that queues whatever is unfinished.
   */
  async createSongFromUrl(url: string, signal?: AbortSignal): Promise<SongStatus> {
    const body: SongLinkRequest = { url };
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    const limits = { timeoutMs: this.requestTimeoutMs, signal };
    return this.statusOf(await this.call('/songs/url', init, limits, readJson));
  }

  /** The song's status now. */
  async getSong(id: string, signal?: AbortSignal): Promise<SongStatus> {
    const path = `/songs/${encodeURIComponent(id)}`;
    const limits = { timeoutMs: this.requestTimeoutMs, signal };
    return this.statusOf(await this.call(path, { method: 'GET' }, limits, readJson));
  }

  /** The song's stored audio, as the bytes of the file the service holds. */
  async fetchSongAudio(id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const path = `/songs/${encodeURIComponent(id)}/audio`;
    const limits = { timeoutMs: this.audioTimeoutMs, signal };
    return this.call(path, { method: 'GET' }, limits, (response) => response.arrayBuffer());
  }

  /**
   * Adds an audio file as a song and answers with its status. The service
   * names a song by the hash of its bytes, so a file it has is a cache hit.
   * `onProgress` hears the share sent (0 to 1); a stop through `signal` is an
   * AbortError, like any other call. A refusal (an empty file, one over the
   * size limit, one of a type it does not take) carries the service's own
   * plain reason.
   */
  async uploadSong(file: File, options: UploadCallOptions = {}): Promise<SongStatus> {
    const result = await postFile(`${this.baseUrl}/songs`, 'file', file, {
      onProgress: options.onProgress,
      signal: options.signal,
      timeoutMs: this.uploadTimeoutMs,
      xhr: this.xhrFactory,
    });
    if (result.kind === 'aborted') throw abortError();
    if (result.kind === 'network') throw new ServiceError('unreachable', UNREACHABLE_MESSAGE);
    const body = parseJson(result.text);
    if (result.status < 200 || result.status >= 300) {
      // The upload route also says no with a 400, 413 or 415, each with a
      // plain reason of its own.
      if ([400, 413, 415].includes(result.status)) {
        const fallback = `The service refused the file (HTTP ${result.status}).`;
        throw new ServiceError('rejected', plainDetail(body, fallback), result.status);
      }
      throw failureFrom(result.status, body);
    }
    return this.statusOf(body);
  }

  /**
   * One stem of a separated song (24-bit FLAC) with the factor the song was
   * scaled by to make the stems. A 409 ('not-fetched') means it has not been
   * separated yet.
   */
  async fetchStem(id: string, stem: StemName, signal?: AbortSignal): Promise<StemDownload> {
    const path = `/songs/${encodeURIComponent(id)}/stems/${stem}`;
    const limits = { timeoutMs: this.audioTimeoutMs, signal };
    return this.call(path, { method: 'GET' }, limits, async (response) => ({
      bytes: await response.arrayBuffer(),
      gain: parseStemGain(response.headers.get(STEM_GAIN_HEADER)),
    }));
  }

  /**
   * The song's reference melody. A 409 ('not-fetched') means there is none:
   * the step has not finished, or it was skipped (the status says which).
   */
  async fetchReference(id: string, signal?: AbortSignal): Promise<Reference> {
    const path = `/songs/${encodeURIComponent(id)}/reference`;
    const limits = { timeoutMs: this.requestTimeoutMs, signal };
    const body = await this.call(path, { method: 'GET' }, limits, readJson);
    if (!isReference(body)) throw new ServiceError('unexpected', BAD_BODY_MESSAGE);
    return body;
  }

  /**
   * Polls the song's status with a growing wait (see `pollDelayMs`) until it
   * settles (see `settledAs`, or `settledThrough` with the `through` option)
   * or `signal` aborts. One dropped request should not lose a download that is
   * under way, so a poll nobody answers is tried again; POLL_MAX_UNANSWERED of
   * them in a row, or any other failure, is thrown.
   */
  async pollSong(id: string, options: PollOptions = {}): Promise<PollOutcome> {
    const { signal, onUpdate, through } = options;
    let attempt = 0;
    let unanswered = 0;
    for (;;) {
      if (!(await sleep(pollDelayMs(attempt), signal))) return { kind: 'aborted' };
      attempt += 1;
      let status: SongStatus;
      try {
        status = await this.getSong(id, signal);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return { kind: 'aborted' };
        const dropped = error instanceof ServiceError && error.kind === 'unreachable';
        unanswered += 1;
        if (dropped && unanswered < POLL_MAX_UNANSWERED) continue;
        throw error;
      }
      unanswered = 0;
      onUpdate?.(status);
      if (through !== undefined) {
        if (settledThrough(status, through)) return { kind: 'settled', status };
        continue;
      }
      const settled = settledAs(status);
      if (settled === 'fetched') return { kind: 'fetched', status };
      if (settled === 'failed') {
        // Narrowed by settledAs, which only says 'failed' when a step has.
        return { kind: 'failed', status, step: failedStep(status) as StepName };
      }
    }
  }

  private statusOf(body: unknown): SongStatus {
    if (!isSongStatus(body)) throw new ServiceError('unexpected', BAD_BODY_MESSAGE);
    return body;
  }

  /**
   * One HTTP call under a time limit and the caller's signal. `read` turns the
   * response into the result and runs inside the limit, so a body that stalls
   * is cut off too. Whatever goes wrong without an answer is 'unreachable'.
   */
  private async call<T>(
    path: string,
    init: RequestInit,
    limits: { timeoutMs: number; signal: AbortSignal | undefined },
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const { signal } = limits;
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, limits.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) throw await failureOf(response);
      return await read(response);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (signal?.aborted) throw abortError();
      throw new ServiceError('unreachable', UNREACHABLE_MESSAGE, null, { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }
}
