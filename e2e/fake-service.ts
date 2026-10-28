/**
 * A stand-in for the Python service in the end-to-end runs. Playwright routes
 * every request to the service's address (the default `serviceUrl`) to
 * `stubService`, so a run never needs the real service, and the page never
 * reaches a port nothing listens on (which the browser would log as an error).
 * The stand-in answers the routes the app uses: `GET /health`, `POST /songs`
 * (a dropped file) and `POST /songs/url` (a link), `GET /songs/{id}`, and
 * `GET /songs/{id}/audio`, `/stems/{vocals|no_vocals}`, `/reference` and `/key`. What
 * each answers is a field of the returned object, which a test changes at its
 * own pace, so a test can hold a song at "running 45%" for as long as it likes
 * and move it on when it has looked; the health checks and the upload can be
 * held as well, as a slow service would, and answered when the test is ready.
 * Every request is recorded, and `songRequests` lists all but the health
 * checks: what a link or a file would have caused. The audio it serves is the
 * song fixture the other specs drop on the page. The stems are WAV fixtures
 * served as the FLAC the real service sends: the browser decodes by sniffing
 * the bytes, so the container does not matter to it. A stem carries the
 * `X-Stem-Gain` header, which the page can read because the stand-in exposes
 * it, as the real service does.
 */
import { readFileSync } from 'node:fs';
import type { BrowserContext, Request } from '@playwright/test';
import type { KeyMap, Reference, SongStatus, StepState, StepStatus } from '../src/service/types';
import { NO_VOCALS_FILE, SONG_FILE, VOCALS_FILE } from './fixtures';

/** The default `serviceUrl` setting. */
export const SERVICE_URL = 'http://localhost:8765';

/** One request the stand-in received. */
export interface ServiceRequest {
  method: string;
  path: string;
  /**
   * The parsed JSON body of a POST of JSON; `{ filename }` for an upload;
   * else undefined.
   */
  body?: unknown;
}

/** An error answer: the status and the plain `detail` the service sends. */
export interface Refusal {
  status: number;
  detail: string;
}

/** What `GET /songs/{id}/audio` and the stems answer: the file, or an error status. */
export type AudioAnswer = 'ok' | 409 | 404;

/** The factor the stems carry in `X-Stem-Gain` unless a test says otherwise. */
export const STEM_GAIN = 0.8;

/**
 * The melody the stand-in serves: two notes in the song's 4 s (A3 from 0.5 to
 * 2.0 s, E4 from 2.0 to 3.5 s) and a stretch of sound with no note after them.
 */
export const REFERENCE_FIXTURE: Reference = (() => {
  const f0_hz = Array.from({ length: 400 }, (_, i) => {
    const t = i * 0.01;
    if (t >= 0.5 && t < 2) return 220;
    return t >= 2 && t < 3.5 ? 329.63 : 0;
  });
  return {
    contour: { hop_s: 0.01, t0_s: 0, f0_hz, confidence: f0_hz.map((hz) => (hz > 0 ? 0.95 : 0)) },
    notes: [
      { onset_s: 0.5, offset_s: 2, midi: 57, cents_mean: 0, cents_std: 4, scoop_cents: 0 },
      { onset_s: 2, offset_s: 3.5, midi: 64, cents_mean: 0, cents_std: 4, scoop_cents: 0 },
    ],
    range: { low_midi: 57, high_midi: 64 },
    unpitched_regions: [[3.6, 3.9]],
  };
})();

/**
 * The key the stand-in serves: A minor, a few cents sharp, all through the
 * song. Chromium's fake microphone sings A4, which is in it.
 */
export const KEY_FIXTURE: KeyMap = {
  tuning_cents: 8,
  segments: [{ start_s: 0, end_s: 4, tonic: 9, mode: 'minor', confidence: 0.8 }],
};

/** The stand-in's behaviour, all of it open to change by the test. */
export interface FakeService {
  /** Every request received, in order, health checks included. */
  requests: ServiceRequest[];
  /** False refuses connections, as a service that is not running does. */
  up: boolean;
  /** The answer to `POST /songs/url`. */
  create: SongStatus | Refusal;
  /** The answer to `POST /songs`, a dropped file. */
  upload: SongStatus | Refusal;
  /** The answer to `GET /songs/{id}`. */
  status: SongStatus | Refusal;
  /** The answers to `GET /songs/{id}/audio`, in turn; the last one repeats. */
  audio: AudioAnswer[];
  /** The answer to `GET /songs/{id}/stems/{stem}`. */
  stems: AudioAnswer;
  /** The `X-Stem-Gain` sent with a stem; null sends no header. */
  stemGain: number | null;
  /** The answer to `GET /songs/{id}/reference`: the melody, or an error status. */
  reference: Reference | 409 | 404;
  /** The answer to `GET /songs/{id}/key`: the key map, or an error status. */
  key: KeyMap | 409 | 404;
  /** The requests that are not health checks. */
  songRequests(): ServiceRequest[];
  /** How many requests had this method and exactly this path. */
  count(method: string, path: string): number;
  /** Back to a service that is up, with a queued song and good audio. */
  reset(videoId: string): void;
  /**
   * Makes health checks wait for an answer, as a slow service would; the
   * returned function answers every check that is waiting, and those after.
   */
  holdHealth(): () => void;
  /**
   * Makes the answer to an upload wait, as a slow one would; the returned
   * function sends it, and every one after it.
   */
  holdUpload(): () => void;
}

/** One step as the service reports it. */
export function stepStatus(state: StepState, progress = 0, error: string | null = null): StepStatus {
  return { state, progress, error, detail: null };
}

/** A step that was skipped, with the reason the service gives. */
export function skippedStep(detail: string): StepStatus {
  return { state: 'skipped', progress: 0, error: null, detail };
}

/**
 * A link song's status with the given fetch step. The later steps are skipped
 * unless a test gives them: the specs about preparing a link care about the
 * fetch, and a song that is not going to be separated is not polled for ever.
 */
export function linkStatus(
  videoId: string,
  fetchStep: StepStatus,
  later: Partial<SongStatus['steps']> = {},
): SongStatus {
  const nothing = skippedStep('Not made by the stand-in');
  return {
    song_id: `yt-${videoId}`,
    title: 'Fake Video Title',
    duration_s: 213,
    source: 'youtube',
    steps: {
      fetch: fetchStep,
      separation: nothing,
      key: nothing,
      reference: nothing,
      lyrics: nothing,
      ...later,
    },
  };
}

/** The status of a dropped file: its fetch is skipped, as the service reports it. */
export function fileStatus(songId: string, steps: Partial<SongStatus['steps']> = {}): SongStatus {
  const nothing = skippedStep('Not made by the stand-in');
  return {
    song_id: songId,
    title: 'song',
    duration_s: 4,
    source: 'file',
    steps: {
      fetch: skippedStep('Not a link'),
      separation: nothing,
      key: nothing,
      reference: nothing,
      lyrics: nothing,
      ...steps,
    },
  };
}

function isRefusal(answer: SongStatus | Refusal): answer is Refusal {
  return 'detail' in answer;
}

/** Lets the page, served from another port, read the answers. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
  'access-control-expose-headers': 'X-Stem-Gain',
};

/** The song id the stand-in gives a dropped file. */
export const UPLOAD_SONG_ID = 'file-fake';

/** What a request body comes to in the record: JSON as parsed, a file by its name. */
function bodyOf(request: Request): unknown {
  const type = request.headers()['content-type'] ?? '';
  if (type.startsWith('multipart/form-data')) {
    const raw = request.postDataBuffer()?.toString('latin1') ?? '';
    return { filename: /filename="([^"]*)"/.exec(raw)?.[1] ?? '' };
  }
  const text = request.postData();
  return text ? JSON.parse(text) : undefined;
}

/** Routes the service's address on `context` to a stand-in that is up. */
export async function stubService(context: BrowserContext, videoId: string): Promise<FakeService> {
  // Set while health checks are held; opening it answers the ones waiting.
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const release = (): void => {
    gate = null;
    open?.();
    open = null;
  };
  // The same, for the answer to an upload.
  let uploadGate: Promise<void> | null = null;
  let uploadOpen: (() => void) | null = null;
  const releaseUpload = (): void => {
    uploadGate = null;
    uploadOpen?.();
    uploadOpen = null;
  };
  const service: FakeService = {
    requests: [],
    up: true,
    create: linkStatus(videoId, stepStatus('queued')),
    upload: fileStatus(UPLOAD_SONG_ID),
    status: linkStatus(videoId, stepStatus('queued')),
    audio: ['ok'],
    stems: 'ok',
    stemGain: STEM_GAIN,
    reference: REFERENCE_FIXTURE,
    key: KEY_FIXTURE,
    songRequests: () => service.requests.filter((r) => !(r.method === 'GET' && r.path === '/health')),
    count: (method, path) => service.requests.filter((r) => r.method === method && r.path === path).length,
    reset(id) {
      release();
      releaseUpload();
      service.up = true;
      service.create = linkStatus(id, stepStatus('queued'));
      service.upload = fileStatus(UPLOAD_SONG_ID);
      service.status = linkStatus(id, stepStatus('queued'));
      service.audio = ['ok'];
      service.stems = 'ok';
      service.stemGain = STEM_GAIN;
      service.reference = REFERENCE_FIXTURE;
      service.key = KEY_FIXTURE;
      service.requests.length = 0;
    },
    holdHealth() {
      release();
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return release;
    },
    holdUpload() {
      releaseUpload();
      uploadGate = new Promise<void>((resolve) => {
        uploadOpen = resolve;
      });
      return releaseUpload;
    },
  };

  await context.route(`${SERVICE_URL}/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    // A preflight only asks leave for the real request; it is not one of ours.
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const path = new URL(request.url()).pathname;
    service.requests.push({ method, path, body: bodyOf(request) });
    if (!service.up) {
      await route.abort('connectionrefused');
      return;
    }
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const answer = (what: SongStatus | Refusal) =>
      isRefusal(what) ? json(what.status, { detail: what.detail }) : json(200, what);

    if (method === 'GET' && path === '/health') {
      try {
        await gate;
        await json(200, { status: 'ok', version: 'test' });
      } catch {
        // A check the page gave up on while it was held has nothing to answer.
      }
    } else if (method === 'POST' && path === '/songs') {
      try {
        await uploadGate;
        await answer(service.upload);
      } catch {
        // An upload the page gave up on while it was held has nothing to answer.
      }
    } else if (method === 'POST' && path === '/songs/url') {
      await answer(service.create);
    } else if (method === 'GET' && /^\/songs\/[^/]+\/stems\/(vocals|no_vocals)$/.test(path)) {
      if (service.stems === 'ok') {
        const file = path.endsWith('/vocals') ? VOCALS_FILE : NO_VOCALS_FILE;
        const gain: Record<string, string> =
          service.stemGain === null ? {} : { 'X-Stem-Gain': String(service.stemGain) };
        await route.fulfill({
          status: 200,
          headers: { ...CORS, ...gain, 'content-type': 'audio/flac' },
          body: readFileSync(file),
        });
      } else {
        const detail = service.stems === 409 ? 'Song not separated yet.' : 'No such stem.';
        await json(service.stems, { detail });
      }
    } else if (method === 'GET' && /^\/songs\/[^/]+\/reference$/.test(path)) {
      if (typeof service.reference === 'number') {
        await json(service.reference, { detail: 'Song has no reference melody.' });
      } else {
        await json(200, service.reference);
      }
    } else if (method === 'GET' && /^\/songs\/[^/]+\/key$/.test(path)) {
      if (typeof service.key === 'number') {
        await json(service.key, { detail: 'Song has no key.' });
      } else {
        await json(200, service.key);
      }
    } else if (method === 'GET' && /^\/songs\/[^/]+\/audio$/.test(path)) {
      const next = service.audio.length > 1 ? service.audio.shift() : service.audio[0];
      if (next === 'ok') {
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'audio/wav' },
          body: readFileSync(SONG_FILE),
        });
      } else {
        await json(next ?? 404, { detail: next === 409 ? 'Song not fetched yet.' : 'No such song.' });
      }
    } else if (method === 'GET' && /^\/songs\/[^/]+$/.test(path)) {
      await answer(service.status);
    } else {
      await json(404, { detail: 'Not Found' });
    }
  });
  return service;
}
