/** Tests for the oEmbed embeddability check: status mapping and failure safety. */
import { describe, expect, it } from 'vitest';

import { checkEmbeddable, describeVerdict, verdictForStatus } from '../src/audio/youtube-oembed';

describe('verdictForStatus', () => {
  it('maps the three answers and treats the rest as unknown', () => {
    expect(verdictForStatus(200)).toBe('ok');
    expect(verdictForStatus(401)).toBe('blocked');
    expect(verdictForStatus(404)).toBe('missing');
    expect(verdictForStatus(500)).toBe('unknown');
  });
});

describe('checkEmbeddable', () => {
  it('asks the oEmbed endpoint with the watch url', async () => {
    let asked = '';
    const verdict = await checkEmbeddable('abc', async (url) => {
      asked = url;
      return { status: 401 };
    });
    expect(verdict).toBe('blocked');
    expect(decodeURIComponent(asked)).toContain('watch?v=abc');
  });

  it('never blocks on a network failure or with no fetch', async () => {
    expect(await checkEmbeddable('abc', async () => Promise.reject(new Error('x')))).toBe('unknown');
    expect(await checkEmbeddable('abc', null)).toBe('unknown');
  });
});

describe('describeVerdict', () => {
  it('speaks only for blocked and missing', () => {
    expect(describeVerdict('blocked')).toContain('blocks');
    expect(describeVerdict('missing')).toContain('does not exist');
    expect(describeVerdict('ok')).toBeNull();
    expect(describeVerdict('unknown')).toBeNull();
  });
});
