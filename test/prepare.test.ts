/**
 * Tests for the preparing of a linked song, apart from the Session. The wording
 * of the song panel is checked as tables (one step as a line, the progress
 * lines, and the button, lines and note of every phase, including why the
 * button is off). `prepareLink` is then run against a stub client: a cold link
 * polled through queued, running and done; a cache hit that needs no polling; a
 * failed step with its own error; the service's refusals, a service that stops
 * answering and a song it forgot; the audio that has gone, which is asked for
 * again once and then reported; and a stop through the signal at each stage,
 * which is never a failure.
 */
import { describe, expect, it } from 'vitest';
import {
  ADD_AGAIN_LABEL,
  ADD_AGAIN_TITLE,
  ASKING_LINE,
  AUDIO_MISSING,
  LOADING_NOTE,
  PREPARED_LABEL,
  PREPARED_NOTE,
  PREPARE_LABEL,
  READY_NOTE,
  SERVICE_DOWN_NOTE,
  SERVICE_DOWN_TITLE,
  SERVICE_STOPPED,
  SONG_FORGOTTEN,
  WAITING_NOTE,
  canonicalWatchUrl,
  describeFailure,
  describePrepare,
  describeServiceError,
  describeStep,
  initialPrepare,
  prepareLink,
  stepLines,
} from '../src/app/prepare';
import type { PrepareClient, PrepareHooks, PrepareOutcome } from '../src/app/prepare';
import { ServiceError } from '../src/service/client';
import type { PollOptions, PollOutcome } from '../src/service/client';
import type { SongStatus, SongSteps, StepName, StepState, StepStatus } from '../src/service/types';

const ID = 'yt-dQw4w9WgXcQ';
const LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function step(state: StepState = 'queued', progress = 0, extra: Partial<StepStatus> = {}): StepStatus {
  return { state, progress, error: null, detail: null, ...extra };
}

function steps(fetchStep: StepStatus, others: Partial<SongSteps> = {}): SongSteps {
  return { fetch: fetchStep, separation: step(), key: step('skipped'), reference: step(), lyrics: step(), ...others };
}

function song(fetchStep: StepStatus, others: Partial<SongSteps> = {}): SongStatus {
  return { song_id: ID, title: 'Some Video', duration_s: 213, source: 'youtube', steps: steps(fetchStep, others) };
}

describe('canonicalWatchUrl', () => {
  it('is the one form the service always takes', () => {
    expect(canonicalWatchUrl('dQw4w9WgXcQ')).toBe(LINK);
  });
});

describe('describeStep', () => {
  it('says what each state of a step comes to', () => {
    expect(describeStep('fetch', step('queued'))).toBe('Fetching audio: waiting');
    expect(describeStep('fetch', step('running', 0.45))).toBe('Fetching audio 45%');
    expect(describeStep('fetch', step('done', 1))).toBe('Fetching audio: done');
    expect(describeStep('separation', step('running', 0.3))).toBe('Separating the vocal 30%');
    expect(describeStep('reference', step('running', 0.07))).toBe('Reading the melody 7%');
    expect(describeStep('lyrics', step('queued'))).toBe('Finding the lyrics: waiting');
  });

  it('keeps the percentage in range and whole', () => {
    expect(describeStep('fetch', step('running', 0.455))).toBe('Fetching audio 46%');
    expect(describeStep('fetch', step('running', -0.2))).toBe('Fetching audio 0%');
    expect(describeStep('fetch', step('running', 4))).toBe('Fetching audio 100%');
    expect(describeStep('fetch', step('running', Number.NaN))).toBe('Fetching audio 0%');
  });

  it('shows a failed step\'s own error, or says it failed', () => {
    expect(describeStep('fetch', step('failed', 0.2, { error: 'Download failed: HTTP Error 403' }))).toBe(
      'Download failed: HTTP Error 403',
    );
    expect(describeStep('fetch', step('failed', 0.2, { error: '  ' }))).toBe('Fetching audio failed');
    expect(describeStep('fetch', step('failed'))).toBe('Fetching audio failed');
  });

  it('gives the reason a step was skipped when there is one', () => {
    expect(describeStep('separation', step('skipped', 0, { detail: 'Not built yet (ROADMAP P2-T2)' }))).toBe(
      'Separating the vocal: skipped (Not built yet (ROADMAP P2-T2))',
    );
    expect(describeStep('separation', step('skipped'))).toBe('Separating the vocal: skipped');
  });
});

describe('stepLines', () => {
  it('asks the service while nothing has been heard from it', () => {
    expect(stepLines(null)).toEqual([ASKING_LINE]);
  });

  it('shows the fetch whatever state it is in', () => {
    expect(stepLines(steps(step('queued')))).toEqual(['Fetching audio: waiting']);
    expect(stepLines(steps(step('running', 0.45)))).toEqual(['Fetching audio 45%']);
    expect(stepLines(steps(step('done', 1)))).toEqual(['Fetching audio: done']);
  });

  it('says nothing of later steps that are queued, skipped or not built, and shows one once it runs', () => {
    const idle = steps(step('done', 1), { separation: step('skipped', 0, { detail: 'Not built yet' }) });
    expect(stepLines(idle)).toEqual(['Fetching audio: done']);
    const busy = steps(step('done', 1), { separation: step('running', 0.5) });
    expect(stepLines(busy)).toEqual(['Fetching audio: done', 'Separating the vocal 50%']);
  });

  it('never shows the lyrics step, whatever it is doing', () => {
    const lyrics = steps(step('done', 1), { lyrics: step('running', 0.3) });
    expect(stepLines(lyrics)).toEqual(['Fetching audio: done']);
  });
});

describe('describePrepare', () => {
  const state = (phase: Parameters<typeof describePrepare>[0]['phase'], extra = {}) => ({
    ...initialPrepare(),
    phase,
    ...extra,
  });

  it('is hidden while no video is the song', () => {
    expect(describePrepare(initialPrepare()).visible).toBe(false);
  });

  it('is off while it checks the service, and says so', () => {
    const view = describePrepare(state('checking'));
    expect(view).toMatchObject({ visible: true, label: PREPARE_LABEL, disabled: true });
    expect(view.title).toMatch(/Checking/);
    expect(view.note).toMatch(/Checking/);
  });

  it('is off, with the reason in its title and a pointer to the README, when the service is not running', () => {
    const view = describePrepare(state('unavailable'));
    expect(view).toMatchObject({ visible: true, label: PREPARE_LABEL, disabled: true, title: SERVICE_DOWN_TITLE });
    expect(SERVICE_DOWN_TITLE).toMatch(/not running/);
    expect(SERVICE_DOWN_TITLE).toMatch(/service\/README\.md/);
    expect(view.note).toBe(SERVICE_DOWN_NOTE);
    expect(SERVICE_DOWN_NOTE).toMatch(/service\/README\.md/);
    expect(SERVICE_DOWN_NOTE).toMatch(/plays as before/);
  });

  it('is on, and says plainly that it downloads, when the service is there', () => {
    const view = describePrepare(state('ready'));
    expect(view).toMatchObject({ label: PREPARE_LABEL, disabled: false, note: READY_NOTE, title: READY_NOTE });
    expect(READY_NOTE).toMatch(/Downloads/);
    expect(READY_NOTE).toMatch(/service\/README\.md/);
    expect(view.lines).toEqual([]);
  });

  it('is off and shows the progress by step while the service works', () => {
    const view = describePrepare(state('preparing', { steps: steps(step('running', 0.45)) }));
    expect(view).toMatchObject({ label: PREPARE_LABEL, disabled: true, lines: ['Fetching audio 45%'] });
    expect(describePrepare(state('preparing')).lines).toEqual([ASKING_LINE]);
  });

  it('shows the fetch done and that the audio is loading', () => {
    const view = describePrepare(state('loading', { steps: steps(step('done', 1)) }));
    expect(view).toMatchObject({ disabled: true, lines: ['Fetching audio: done'], note: LOADING_NOTE });
  });

  it('says it is waiting for the take to end', () => {
    const view = describePrepare(state('waiting', { message: WAITING_NOTE }));
    expect(view).toMatchObject({ disabled: true, note: WAITING_NOTE, lines: [] });
    expect(WAITING_NOTE).toMatch(/^Prepared; switching after this take/);
  });

  it('reads Prepared once the app\'s own audio is the song, and says the karaoke track follows', () => {
    const view = describePrepare(state('prepared', { message: PREPARED_NOTE }));
    expect(view).toMatchObject({ label: PREPARED_LABEL, disabled: true, note: PREPARED_NOTE });
    expect(PREPARED_NOTE).toMatch(/karaoke track and the melody follow/);
  });

  it('offers Add again, with the reason, after a failure', () => {
    const view = describePrepare(state('failed', { message: 'Download failed: HTTP Error 403' }));
    expect(view).toEqual({
      visible: true,
      label: ADD_AGAIN_LABEL,
      disabled: false,
      title: ADD_AGAIN_TITLE,
      lines: [],
      note: 'Download failed: HTTP Error 403',
    });
    expect(ADD_AGAIN_LABEL).toBe('Add again');
  });

  it('is only ever on in the two phases that can start a preparation', () => {
    const on = (['none', 'checking', 'unavailable', 'ready', 'preparing', 'loading', 'waiting', 'prepared', 'failed'] as const)
      .filter((phase) => !describePrepare(state(phase)).disabled);
    expect(on).toEqual(['ready', 'failed']);
  });
});

describe('describeFailure and describeServiceError', () => {
  it('uses the failed step\'s error, or names the step', () => {
    const withError = song(step('failed', 0, { error: 'Download failed: x' }));
    expect(describeFailure(withError, 'fetch')).toBe('Download failed: x');
    expect(describeFailure(song(step('failed')), 'fetch')).toBe(
      'Fetching audio failed. Add the song again to retry.',
    );
    const later = song(step('done', 1), { lyrics: step('failed', 0, { error: '  ' }) });
    expect(describeFailure(later, 'lyrics')).toBe('Finding the lyrics failed. Add the song again to retry.');
  });

  it('tells what each failed call means for the person', () => {
    expect(describeServiceError(new ServiceError('unreachable', 'The service did not answer.'))).toBe(SERVICE_STOPPED);
    expect(describeServiceError(new ServiceError('rejected', 'This video is 20 min long.', 422))).toBe(
      'This video is 20 min long.',
    );
    expect(describeServiceError(new ServiceError('not-found', 'x', 404))).toBe(SONG_FORGOTTEN);
    expect(describeServiceError(new ServiceError('not-fetched', 'x', 409))).toBe(AUDIO_MISSING);
    expect(describeServiceError(new ServiceError('unexpected', 'The service answered with an error (HTTP 500).', 500))).toBe(
      'The service answered with an error (HTTP 500).',
    );
    expect(SERVICE_STOPPED).toMatch(/service\/README\.md/);
  });

  it('falls back to the text of anything else that was thrown', () => {
    expect(describeServiceError(new Error('boom'))).toBe('boom');
    expect(describeServiceError('plain')).toBe('plain');
    expect(describeServiceError(new Error(''))).toBe('Error');
  });
});

/** What a stub client is told to do, call by call. */
interface Script {
  create: Array<SongStatus | Error>;
  poll?: Array<{ updates?: SongStatus[]; outcome: PollOutcome } | Error>;
  audio?: Array<ArrayBuffer | Error>;
}

/** A client that follows a script and logs every call it gets. */
class StubClient implements PrepareClient {
  readonly calls: string[] = [];
  readonly pollSignals: Array<AbortSignal | undefined> = [];
  constructor(private readonly script: Script) {}

  async createSongFromUrl(url: string): Promise<SongStatus> {
    this.calls.push(`create:${url}`);
    return this.take(this.script.create, 'create');
  }
  async pollSong(id: string, options: PollOptions = {}): Promise<PollOutcome> {
    this.calls.push(`poll:${id}`);
    this.pollSignals.push(options.signal);
    const next = this.take(this.script.poll ?? [], 'poll');
    for (const update of next.updates ?? []) options.onUpdate?.(update);
    return next.outcome;
  }
  async fetchSongAudio(id: string): Promise<ArrayBuffer> {
    this.calls.push(`audio:${id}`);
    return this.take(this.script.audio ?? [], 'audio');
  }
  private take<T>(queue: Array<T | Error>, what: string): T {
    const next = queue.shift();
    if (next === undefined) throw new Error(`the stub was not given another ${what} answer`);
    if (next instanceof Error) throw next;
    return next;
  }
}

const BYTES = new Uint8Array([1, 2, 3, 4]).buffer;

function abortError(): Error {
  return new DOMException('The call was aborted.', 'AbortError');
}

/** Runs prepareLink and records what it reported on the way. */
async function run(client: PrepareClient, controller = new AbortController()) {
  const seen: Array<{ kind: 'steps' | 'loading'; steps: SongSteps }> = [];
  const hooks: PrepareHooks = {
    signal: controller.signal,
    onSteps: (s) => seen.push({ kind: 'steps', steps: s }),
    onLoading: (s) => seen.push({ kind: 'loading', steps: s }),
  };
  const outcome: PrepareOutcome = await prepareLink(client, LINK, hooks);
  return { outcome, seen };
}

describe('prepareLink', () => {
  it('adds a new link, follows the fetch through queued, running and done, and brings back the audio', async () => {
    const queued = song(step('queued'));
    const half = song(step('running', 0.45));
    const done = song(step('done', 1));
    const client = new StubClient({
      create: [queued],
      poll: [{ updates: [song(step('running', 0.2)), half, done], outcome: { kind: 'fetched', status: done } }],
      audio: [BYTES],
    });
    const { outcome, seen } = await run(client);
    expect(outcome).toEqual({ kind: 'audio', bytes: BYTES, status: done });
    expect(client.calls).toEqual([`create:${LINK}`, `poll:${ID}`, `audio:${ID}`]);
    expect(seen.map((s) => s.kind)).toEqual(['steps', 'steps', 'steps', 'steps', 'loading']);
    expect(seen.map((s) => s.steps.fetch.state)).toEqual(['queued', 'running', 'running', 'done', 'done']);
    expect(seen[2].steps.fetch.progress).toBe(0.45);
  });

  it('does not poll a link the service already has, and goes straight for the audio', async () => {
    const done = song(step('done', 1));
    const client = new StubClient({ create: [done], audio: [BYTES] });
    const { outcome, seen } = await run(client);
    expect(outcome).toMatchObject({ kind: 'audio' });
    expect(client.calls).toEqual([`create:${LINK}`, `audio:${ID}`]);
    expect(seen.map((s) => s.kind)).toEqual(['steps', 'loading']);
  });

  it('passes the abort signal to every call it makes', async () => {
    const controller = new AbortController();
    const done = song(step('done', 1));
    const client = new StubClient({
      create: [song(step('queued'))],
      poll: [{ outcome: { kind: 'fetched', status: done } }],
      audio: [BYTES],
    });
    await run(client, controller);
    expect(client.pollSignals).toEqual([controller.signal]);
  });

  it('ends with the step\'s own error when the fetch fails, and asks for no audio', async () => {
    const failed = song(step('failed', 0.3, { error: 'Download failed: HTTP Error 403. Update yt-dlp.' }));
    const client = new StubClient({
      create: [song(step('queued'))],
      poll: [{ outcome: { kind: 'failed', status: failed, step: 'fetch' } }],
    });
    const { outcome } = await run(client);
    expect(outcome).toEqual({ kind: 'failed', message: 'Download failed: HTTP Error 403. Update yt-dlp.' });
    expect(client.calls).toEqual([`create:${LINK}`, `poll:${ID}`]);
  });

  it('ends at once when the status that comes back from adding the link has failed already', async () => {
    const failed = song(step('failed', 0, { error: 'Interrupted by a restart. Add the song again to retry.' }));
    const client = new StubClient({ create: [failed] });
    const { outcome } = await run(client);
    expect(outcome).toEqual({
      kind: 'failed',
      message: 'Interrupted by a restart. Add the song again to retry.',
    });
    expect(client.calls).toEqual([`create:${LINK}`]);
  });

  it('names the step when it failed without saying why', async () => {
    const client = new StubClient({ create: [song(step('failed'))] });
    expect((await run(client)).outcome).toEqual({
      kind: 'failed',
      message: 'Fetching audio failed. Add the song again to retry.',
    });
  });

  it('reports the service\'s refusal of the link in its own words', async () => {
    const detail = 'Live streams and premieres cannot be practised; pick a finished video.';
    const client = new StubClient({ create: [new ServiceError('rejected', detail, 422)] });
    expect((await run(client)).outcome).toEqual({ kind: 'failed', message: detail });
    const yt = 'YouTube lookup failed: Video unavailable. Update yt-dlp: uv lock --upgrade-package yt-dlp';
    const lookup = new StubClient({ create: [new ServiceError('rejected', yt, 502)] });
    expect((await run(lookup)).outcome).toEqual({ kind: 'failed', message: yt });
  });

  it('says the service stopped when it stops answering at any stage', async () => {
    const down = (): ServiceError => new ServiceError('unreachable', 'The service did not answer.');
    const atCreate = new StubClient({ create: [down()] });
    expect((await run(atCreate)).outcome).toEqual({ kind: 'failed', message: SERVICE_STOPPED });
    const atPoll = new StubClient({ create: [song(step('queued'))], poll: [down()] });
    expect((await run(atPoll)).outcome).toEqual({ kind: 'failed', message: SERVICE_STOPPED });
    const atAudio = new StubClient({ create: [song(step('done', 1))], audio: [down()] });
    expect((await run(atAudio)).outcome).toEqual({ kind: 'failed', message: SERVICE_STOPPED });
  });

  it('says so when the service has forgotten the song', async () => {
    const client = new StubClient({
      create: [song(step('queued'))],
      poll: [new ServiceError('not-found', 'x', 404)],
    });
    expect((await run(client)).outcome).toEqual({ kind: 'failed', message: SONG_FORGOTTEN });
  });

  it('adds the link again once when the service says the audio is gone, then fetches it', async () => {
    const lost = new ServiceError('not-fetched', 'x', 409);
    const done = song(step('done', 1));
    const client = new StubClient({
      create: [done, song(step('queued'))],
      poll: [{ outcome: { kind: 'fetched', status: done } }],
      audio: [lost, BYTES],
    });
    const { outcome } = await run(client);
    expect(outcome).toEqual({ kind: 'audio', bytes: BYTES, status: done });
    expect(client.calls).toEqual([
      `create:${LINK}`,
      `audio:${ID}`,
      `create:${LINK}`,
      `poll:${ID}`,
      `audio:${ID}`,
    ]);
  });

  it('reports the audio as missing, after one more try and no more, when it is still gone', async () => {
    const lost = (): ServiceError => new ServiceError('not-fetched', 'x', 409);
    const done = song(step('done', 1));
    const client = new StubClient({
      create: [done, done],
      audio: [lost(), lost(), BYTES],
    });
    const { outcome } = await run(client);
    expect(outcome).toEqual({ kind: 'failed', message: AUDIO_MISSING });
    expect(client.calls.filter((call) => call.startsWith('create:'))).toHaveLength(2);
    expect(client.calls.filter((call) => call.startsWith('audio:'))).toHaveLength(2);
  });

  it('does not add the link again for any other failure of the audio', async () => {
    const client = new StubClient({
      create: [song(step('done', 1))],
      audio: [new ServiceError('unexpected', 'The service answered with an error (HTTP 500).', 500)],
    });
    expect((await run(client)).outcome).toEqual({
      kind: 'failed',
      message: 'The service answered with an error (HTTP 500).',
    });
    expect(client.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
  });

  it('is aborted, not failed, when the signal stops it before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new StubClient({ create: [abortError()] });
    expect((await run(client, controller)).outcome).toEqual({ kind: 'aborted' });
  });

  it('is aborted when the poll was stopped, and asks for no audio', async () => {
    const client = new StubClient({
      create: [song(step('queued'))],
      poll: [{ outcome: { kind: 'aborted' } }],
    });
    const { outcome } = await run(client);
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(client.calls).toEqual([`create:${LINK}`, `poll:${ID}`]);
  });

  it('is aborted when the signal stops the audio download', async () => {
    const client = new StubClient({ create: [song(step('done', 1))], audio: [abortError()] });
    expect((await run(client)).outcome).toEqual({ kind: 'aborted' });
  });

  it('is aborted, whatever the stub throws, once the signal has been aborted', async () => {
    const controller = new AbortController();
    const client = new StubClient({ create: [new Error('something else')] });
    controller.abort();
    expect((await run(client, controller)).outcome).toEqual({ kind: 'aborted' });
  });

  it('does not report the audio as loading when the fetch failed', async () => {
    const client = new StubClient({
      create: [song(step('queued'))],
      poll: [{ outcome: { kind: 'failed', status: song(step('failed', 0, { error: 'x' })), step: 'fetch' as StepName } }],
    });
    const { seen } = await run(client);
    expect(seen.some((s) => s.kind === 'loading')).toBe(false);
  });
});
