/**
 * Unit tests for the pure pieces of the song search (src/search/): ISO 8601
 * durations and their display, the karaoke or original classifier, the query
 * for each chip, YouTube's own results address, "Find the original", and the
 * shape of an API key. Every expectation is a known answer written by hand.
 */
import { describe, expect, it } from 'vitest';
import { classifyResult, isKaraokeChannel } from '../src/search/classify';
import { formatDuration, parseIsoDuration } from '../src/search/duration';
import { normalizeApiKey } from '../src/search/key';
import { buildQuery, findOriginalQuery, youtubeResultsUrl } from '../src/search/query';

describe('parseIsoDuration', () => {
  it('reads minutes and seconds', () => {
    expect(parseIsoDuration('PT4M13S')).toBe(253);
  });

  it('reads hours, minutes and seconds', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
  });

  it('reads a part on its own', () => {
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('PT7M')).toBe(420);
    expect(parseIsoDuration('PT2H')).toBe(7200);
  });

  it('reads days', () => {
    expect(parseIsoDuration('P1DT2H')).toBe(93600);
    expect(parseIsoDuration('P1D')).toBe(86400);
  });

  it('reads zero, which a live stream reports', () => {
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('PT0S')).toBe(0);
  });

  it('rounds fractional seconds', () => {
    expect(parseIsoDuration('PT1M0.6S')).toBe(61);
  });

  it('is null for anything that is not a duration', () => {
    for (const text of ['', 'P', 'PT', 'P1DT', '4:13', 'PT4X', 'pt4m', 'PT-4M']) {
      expect(parseIsoDuration(text), text).toBeNull();
    }
  });
});

describe('formatDuration', () => {
  it('writes minutes and seconds', () => {
    expect(formatDuration(253)).toBe('4:13');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('writes hours from an hour up', () => {
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('writes nothing for no length, a live stream or a bad number', () => {
    for (const value of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatDuration(value), String(value)).toBe('');
    }
  });
});

describe('classifyResult', () => {
  it('calls a title with a karaoke word karaoke', () => {
    const titles = [
      'Adele - Hello (Karaoke Version)',
      'Hello [KARAOKE]',
      'Hello (Instrumental)',
      'Hello - Backing Track',
      'Hello (Sing Along)',
      'Hello (singalong)',
      'Hello (Off Vocal)',
      'Hello - Minus One',
      'Hello (No Vocals)',
      'Hello without vocals',
      'Hello (In the Style of Adele)',
    ];
    for (const title of titles) expect(classifyResult(title, 'Some Channel'), title).toBe('karaoke');
  });

  it('calls anything from a known karaoke channel karaoke', () => {
    for (const channel of ['Sing King', 'KaraFun', 'Sunfly', 'Lucky Voice', 'ZZang KARAOKE']) {
      expect(classifyResult('Adele - Hello', channel), channel).toBe('karaoke');
    }
  });

  it('reads the channel name for karaoke words too', () => {
    expect(classifyResult('Adele - Hello', 'Best Karaoke Hits')).toBe('karaoke');
  });

  it('calls an ordinary video an original', () => {
    expect(classifyResult('Adele - Hello (Official Music Video)', 'AdeleVEVO')).toBe('original');
    expect(classifyResult('Hello', 'Adele')).toBe('original');
  });

  it('does not take a word that only contains a karaoke word', () => {
    expect(classifyResult('Instrumentalist Blues', 'Singapore Airlines')).toBe('original');
    expect(isKaraokeChannel('Singapore Airlines')).toBe(false);
    expect(isKaraokeChannel('Singa')).toBe(true);
  });
});

describe('buildQuery', () => {
  it('adds karaoke for the karaoke chip', () => {
    expect(buildQuery({ text: 'adele hello', filter: 'karaoke' })).toBe('adele hello karaoke');
  });

  it('leaves karaoke out of the originals chip with a minus', () => {
    expect(buildQuery({ text: 'adele hello', filter: 'original' })).toBe('adele hello -karaoke');
  });

  it('does not repeat karaoke the words already ask for', () => {
    expect(buildQuery({ text: 'adele hello karaoke', filter: 'karaoke' })).toBe('adele hello karaoke');
    expect(buildQuery({ text: 'adele hello karaoke', filter: 'original' })).toBe('adele hello karaoke');
  });

  it('squashes spaces and gives nothing for blank text', () => {
    expect(buildQuery({ text: '  adele   hello ', filter: 'karaoke' })).toBe('adele hello karaoke');
    expect(buildQuery({ text: '   ', filter: 'karaoke' })).toBe('');
  });

  it('keeps a very long query to a sane length', () => {
    const long = buildQuery({ text: 'a'.repeat(500), filter: 'original' });
    expect(long.length).toBeLessThan(215);
  });
});

describe('youtubeResultsUrl', () => {
  it("points at YouTube's results page with the query encoded", () => {
    expect(youtubeResultsUrl({ text: 'rock & roll', filter: 'karaoke' })).toBe(
      'https://www.youtube.com/results?search_query=rock%20%26%20roll%20karaoke',
    );
  });
});

describe('findOriginalQuery', () => {
  it('takes a bracketed karaoke tag away', () => {
    expect(findOriginalQuery('Adele - Hello (Karaoke Version)', 'Some Channel')).toBe('Adele - Hello');
  });

  it('takes brackets of other kinds and the channel tag line away', () => {
    expect(findOriginalQuery('Hello (Karaoke Version) - Adele | Sing King', 'Sing King')).toBe(
      'Hello - Adele',
    );
    expect(findOriginalQuery('Hello - Adele [Instrumental]', '')).toBe('Hello - Adele');
  });

  it('keeps brackets that say nothing about karaoke', () => {
    expect(findOriginalQuery('Hello (Live at the Palace) (Karaoke)', '')).toBe('Hello (Live at the Palace)');
  });

  it('takes loose karaoke words and their trailers away', () => {
    expect(findOriginalQuery('Hello Karaoke Version', '')).toBe('Hello');
    expect(findOriginalQuery('Hello - Instrumental Track with Lyrics', '')).toBe('Hello');
  });

  it("takes the channel's own name out of the title", () => {
    expect(findOriginalQuery('Sing King Karaoke - Hello', 'Sing King')).toBe('Hello');
    expect(findOriginalQuery('KaraFun: Hello', 'KaraFun')).toBe('Hello');
  });

  it('keeps the artist from "originally performed by" and "in the style of"', () => {
    expect(findOriginalQuery('Hello (Originally Performed by Adele) [Karaoke Version]', '')).toBe(
      'Hello Adele',
    );
    expect(findOriginalQuery('Hello (In the Style of Adele)', '')).toBe('Hello Adele');
  });

  it('leaves an ordinary title alone', () => {
    expect(findOriginalQuery('Adele - Hello', 'Adele')).toBe('Adele - Hello');
  });

  it('falls back to the whole title when only karaoke words are in it', () => {
    expect(findOriginalQuery('Karaoke', '')).toBe('Karaoke');
    expect(findOriginalQuery('  (Karaoke Version)  ', '')).toBe('(Karaoke Version)');
  });

  it('does not take a word that only contains a karaoke word', () => {
    expect(findOriginalQuery('The Instrumentalist - Hello (Karaoke)', '')).toBe('The Instrumentalist - Hello');
  });
});

describe('normalizeApiKey', () => {
  it('keeps a key of letters, digits, hyphens and underscores', () => {
    expect(normalizeApiKey('AIzaSyA-b_c123')).toBe('AIzaSyA-b_c123');
  });

  it('trims space and the quotes of a copied snippet', () => {
    expect(normalizeApiKey('  AIzaSy123  ')).toBe('AIzaSy123');
    expect(normalizeApiKey('"AIzaSy123"')).toBe('AIzaSy123');
  });

  it('reads blank as "no key"', () => {
    expect(normalizeApiKey('')).toBe('');
    expect(normalizeApiKey('   ')).toBe('');
  });

  it('refuses text that cannot be a key', () => {
    for (const text of ['two words', 'key=abc', 'https://x.test/?key=abc', 'a'.repeat(200), 'ключ']) {
      expect(normalizeApiKey(text), text).toBeNull();
    }
  });
});
