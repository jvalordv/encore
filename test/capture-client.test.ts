/**
 * Tests for `ServiceClient.uploadCapture` against a fake XMLHttpRequest: the
 * form it sends (the WAV as `audio`, the optional title), the route it posts
 * to, the answer it reads (status plus `alongside` and the service's
 * message), and the plain reasons it carries from a refusal.
 */
import { describe, expect, it } from 'vitest';
import { ServiceClient } from '../src/service/client';
import type { ServiceError } from '../src/service/client';

const BASE = 'http://localhost:8765';
const VIDEO = 'dQw4w9WgXcQ';

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
  open(method: string, url: string): void {
    this.opened = { method, url };
  }
  send(body: FormData): void {
    this.sent = body;
  }
  abort(): void {
    this.onabort?.();
  }
  answer(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const WAV = new File([new Uint8Array([1, 2, 3, 4])], `${VIDEO}.wav`, { type: 'audio/wav' });

function uploader() {
  const xhr = new FakeXhr();
  const client = new ServiceClient({ baseUrl: `${BASE}/`, xhr: () => xhr as unknown as XMLHttpRequest });
  return { xhr, client };
}

const status = (extra: object = {}) => ({
  song_id: `yt-${VIDEO}`,
  title: 'A video',
  duration_s: 12,
  source: 'youtube',
  audio_source: 'capture',
  steps: {
    fetch: { state: 'done', progress: 1 },
    separation: { state: 'queued', progress: 0 },
    key: { state: 'queued', progress: 0 },
    reference: { state: 'queued', progress: 0 },
    lyrics: { state: 'queued', progress: 0 },
  },
  alongside: false,
  message: 'Capture stored as the audio; preparing it.',
  ...extra,
});

describe('ServiceClient.uploadCapture', () => {
  it('posts the WAV as the audio field with the title', async () => {
    const { xhr, client } = uploader();
    const result = client.uploadCapture(VIDEO, WAV, { title: 'A video' });
    expect(xhr.opened).toEqual({ method: 'POST', url: `${BASE}/songs/url/${VIDEO}/capture` });
    expect(xhr.sent?.get('audio')).toBeInstanceOf(File);
    expect(xhr.sent?.get('title')).toBe('A video');
    xhr.answer(200, status());
    const body = await result;
    expect(body).toMatchObject({ song_id: `yt-${VIDEO}`, audio_source: 'capture', alongside: false });
  });

  it('sends no title field when there is none', async () => {
    const { xhr, client } = uploader();
    const result = client.uploadCapture(VIDEO, WAV);
    expect(xhr.sent?.has('title')).toBe(false);
    xhr.answer(200, status());
    await result;
  });

  it('passes on that the song already had audio', async () => {
    const { xhr, client } = uploader();
    const result = client.uploadCapture(VIDEO, WAV);
    xhr.answer(200, status({ alongside: true, message: 'The song already has audio.' }));
    expect(await result).toMatchObject({ alongside: true, message: 'The song already has audio.' });
  });

  it.each([
    [400, 'The uploaded file is empty.'],
    [413, 'The file is over the 200 MiB limit.'],
    [422, 'The capture is not readable WAV audio, or it is empty.'],
  ])('carries the plain reason of a %i', async (code, detail) => {
    const { xhr, client } = uploader();
    const result = client.uploadCapture(VIDEO, WAV).catch((error: ServiceError) => error);
    xhr.answer(code, { detail });
    expect(await result).toMatchObject({ kind: 'rejected', message: detail });
  });

  it('says the service is unreachable when the network fails', async () => {
    const { xhr, client } = uploader();
    const result = client.uploadCapture(VIDEO, WAV).catch((error: ServiceError) => error);
    xhr.onerror?.();
    expect(await result).toMatchObject({ kind: 'unreachable' });
  });

  it('refuses an answer that is not a song status', async () => {
    const { xhr, client } = uploader();
    const result = client.uploadCapture(VIDEO, WAV).catch((error: ServiceError) => error);
    xhr.answer(200, { hello: 'there' });
    expect(await result).toMatchObject({ kind: 'unexpected' });
  });
});
