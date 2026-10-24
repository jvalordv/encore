/**
 * A stand-in for the Python service in the end-to-end runs. Playwright routes
 * every request to the service's address (the default `serviceUrl`) to
 * `stubService`, so a run never needs the real service, and the page never
 * reaches a port nothing listens on (which the browser would log as an error).
 * The stand-in answers the four routes the app uses: `GET /health`,
 * `POST /songs/url`, `GET /songs/{id}` and `GET /songs/{id}/audio`. What each
 * answers is a field of the returned object, which a test changes at its own
 * pace, so a test can hold a song at "running 45%" for as long as it likes and
 * move it on when it has looked; the health checks can be held as well, as a
 * slow service would, and answered when the test is ready. Every request is
 * recorded, and `songRequests` lists all but the health checks: what a link
 * would have caused. The audio it serves is the song fixture the other specs
 * drop on the page.
 */
import { readFileSync } from 'node:fs';
import type { BrowserContext } from '@playwright/test';
import type { SongStatus, StepState, StepStatus } from '../src/service/types';
import { SONG_FILE } from './fixtures';

/** The default `serviceUrl` setting. */
export const SERVICE_URL = 'http://localhost:8765';

/** One request the stand-in received. */
export interface ServiceRequest {
  method: string;
  path: string;
  /** The parsed JSON body of a POST, else undefined. */
  body?: unknown;
}

/** An error answer: the status and the plain `detail` the service sends. */
export interface Refusal {
  status: number;
  detail: string;
}

/** What `GET /songs/{id}/audio` answers: the file, or an error status. */
export type AudioAnswer = 'ok' | 409 | 404;

/** The stand-in's behaviour, all of it open to change by the test. */
export interface FakeService {
  /** Every request received, in order, health checks included. */
  requests: ServiceRequest[];
  /** False refuses connections, as a service that is not running does. */
  up: boolean;
  /** The answer to `POST /songs/url`. */
  create: SongStatus | Refusal;
  /** The answer to `GET /songs/{id}`. */
  status: SongStatus | Refusal;
  /** The answers to `GET /songs/{id}/audio`, in turn; the last one repeats. */
  audio: AudioAnswer[];
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
}

/** One step as the service reports it. */
export function stepStatus(state: StepState, progress = 0, error: string | null = null): StepStatus {
  return { state, progress, error, detail: null };
}

/** A link song's status with the given fetch step; the later steps wait. */
export function linkStatus(videoId: string, fetchStep: StepStatus): SongStatus {
  return {
    song_id: `yt-${videoId}`,
    title: 'Fake Video Title',
    duration_s: 213,
    source: 'youtube',
    steps: {
      fetch: fetchStep,
      separation: stepStatus('queued'),
      reference: stepStatus('queued'),
      lyrics: stepStatus('queued'),
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
};

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
  const service: FakeService = {
    requests: [],
    up: true,
    create: linkStatus(videoId, stepStatus('queued')),
    status: linkStatus(videoId, stepStatus('queued')),
    audio: ['ok'],
    songRequests: () => service.requests.filter((r) => !(r.method === 'GET' && r.path === '/health')),
    count: (method, path) => service.requests.filter((r) => r.method === method && r.path === path).length,
    reset(id) {
      release();
      service.up = true;
      service.create = linkStatus(id, stepStatus('queued'));
      service.status = linkStatus(id, stepStatus('queued'));
      service.audio = ['ok'];
      service.requests.length = 0;
    },
    holdHealth() {
      release();
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return release;
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
    const text = request.postData();
    service.requests.push({ method, path, body: text ? JSON.parse(text) : undefined });
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
    } else if (method === 'POST' && path === '/songs/url') {
      await answer(service.create);
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
