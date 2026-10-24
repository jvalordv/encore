/**
 * Table tests for parseYouTubeUrl: every shape of link the service accepts
 * comes back as a video id (and start time when the link has one), and
 * everything the rules refuse (http, other schemes, look-alike hosts, user
 * info, ports, playlists, channels, bad ids, long input) comes back null. The
 * first two tables are the service's own, copied from
 * service/tests/test_youtube.py, so the two parsers are held to one list; keep
 * them in step when either side changes. Characters that cannot be seen are
 * written as brace escapes, so none hides in the source. Pure text in, answer
 * out; nothing here touches a browser or a network.
 */
import { describe, expect, it } from 'vitest';
import { parseYouTubeUrl } from '../src/audio/youtube-url';

const ID = 'dQw4w9WgXcQ';
const OTHER = 'aB3_x-Y9zQ0';

/** The service's ACCEPTED list: each must give back ID. */
const SERVICE_ACCEPTED: string[] = [
  `https://www.youtube.com/watch?v=${ID}`,
  `https://youtube.com/watch?v=${ID}`,
  `https://m.youtube.com/watch?v=${ID}`,
  `https://music.youtube.com/watch?v=${ID}`,
  `https://www.youtube.com/watch?v=${ID}&list=PLabcdefghijk&index=3`,
  `https://www.youtube.com/watch?list=PLabcdefghijk&v=${ID}&t=42s`,
  `https://www.youtube.com/watch?feature=share&v=${ID}`,
  `https://www.youtube.com/watch?v=${ID}#t=10`,
  `https://youtu.be/${ID}`,
  `https://youtu.be/${ID}?t=30&si=abcdefghijklmnop`,
  `https://youtu.be/${ID}/`,
  `https://www.youtube.com/shorts/${ID}`,
  `https://www.youtube.com/shorts/${ID}?feature=share`,
  `https://youtube.com/shorts/${ID}/`,
  `https://www.youtube.com/embed/${ID}`,
  `https://www.youtube.com/embed/${ID}?start=10`,
  `https://www.youtube-nocookie.com/embed/${ID}`,
  `https://www.youtube.com/live/${ID}`,
  `https://www.youtube.com/v/${ID}`,
  `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
  // No scheme, as pasted from an address bar that hides it.
  `youtu.be/${ID}`,
  `www.youtube.com/watch?v=${ID}`,
  `youtube.com/watch?v=${ID}`,
  `m.youtube.com/shorts/${ID}`,
  // Whitespace around the link is a copy and paste artefact.
  `  https://youtu.be/${ID}\n`,
  `\thttps://www.youtube.com/watch?v=${ID} `,
  // Scheme and host are case-insensitive; the id is not.
  `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`,
  `https://www.YouTube.com/watch?v=${ID}`,
];

/** The service's REJECTED list: each must give back null. */
const SERVICE_REJECTED: string[] = [
  // Nothing there.
  '',
  '   \n',
  'not a link',
  ID,
  // Not https.
  `http://www.youtube.com/watch?v=${ID}`,
  `http://youtu.be/${ID}`,
  `ftp://youtu.be/${ID}`,
  `file:///youtu.be/${ID}`,
  `javascript:alert(1)//youtu.be/${ID}`,
  `data:text/html,https://youtu.be/${ID}`,
  `//youtu.be/${ID}`,
  `https:/youtu.be/${ID}`,
  `<https://youtu.be/${ID}>`,
  // Look-alike hosts, other hosts, and addresses.
  `https://youtube.com.evil.com/watch?v=${ID}`,
  `https://evilyoutube.com/watch?v=${ID}`,
  `https://notyoutu.be/${ID}`,
  `https://youtu.be.evil.com/${ID}`,
  `https://evil.com/youtube.com/watch?v=${ID}`,
  `https://evil.com/watch?v=${ID}&u=www.youtube.com`,
  `https://studio.youtube.com/watch?v=${ID}`,
  `https://www.youtube.com./watch?v=${ID}`,
  `https://127.0.0.1/watch?v=${ID}`,
  `https://[::1]/watch?v=${ID}`,
  'https://[::1/watch',
  `https://www.youtube.com\\@evil.com/watch?v=${ID}`,
  // A host whose lower-case form is ASCII only by the Kelvin sign.
  `https://www.youtube-nocoo\u{212A}ie.com/embed/${ID}`,
  // User information and ports.
  `https://youtube.com@evil.com/watch?v=${ID}`,
  `https://user:secret@www.youtube.com/watch?v=${ID}`,
  `https://www.youtube.com:443/watch?v=${ID}`,
  `https://www.youtube.com:8080/watch?v=${ID}`,
  `https://youtu.be:443/${ID}`,
  // Pages that are not one video.
  'https://www.youtube.com/playlist?list=PLabcdefghijk',
  'https://www.youtube.com/watch?list=PLabcdefghijk',
  'https://www.youtube.com/embed/videoseries?list=PLabcdefghijk',
  'https://www.youtube.com/embed/live_stream?channel=UCabcdefghijk',
  'https://www.youtube.com/@Blender',
  'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg',
  'https://www.youtube.com/user/BlenderFoundation',
  'https://www.youtube.com/c/Blender',
  `https://www.youtube.com/results?search_query=${ID}`,
  'https://www.youtube.com/',
  'https://www.youtube.com',
  'https://www.youtube.com/watch',
  'https://www.youtube.com/watch?v=',
  'https://youtu.be/',
  'https://youtu.be',
  // Ids that are not 11 characters of the id alphabet.
  'https://www.youtube.com/watch?v=dQw4w9WgXc',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQQ',
  'https://www.youtube.com/watch?v=dQw4w9WgXc!',
  'https://www.youtube.com/watch?v=dQw4w9WgXc.',
  'https://www.youtube.com/watch?v=dQw4w9WgXc%51',
  'https://www.youtube.com/watch?v=short',
  'https://youtu.be/dQw4w9WgXc',
  'https://youtu.be/dQw4w9WgXcQQ',
  'https://www.youtube.com/shorts/short',
  'https://youtu.be/d\u{451}w4w9WgXcQ',
  // A path that is close to a video path but is not one.
  `https://youtu.be/${ID}/extra`,
  `https://www.youtube.com/shorts/${ID}/extra`,
  `https://www.youtube.com//watch?v=${ID}`,
  `https://www.youtube.com/WATCH?v=${ID}`,
  `https://www.youtube.com/watch/?v=${ID}`,
  `https://www.youtube.com/${ID}`,
  `https://youtu.be/watch?v=${ID}`,
  // Whitespace or control characters inside the link.
  `https://youtu.be/${ID} extra`,
  'https://youtu.be/dQw4w9\nWgXcQ',
  'https://youtu.be/dQw4w9\tWgXcQ',
  `https://youtu.be/${ID}\x00`,
  `https://youtu.be/${ID}\u{200B}`,
  // Over the length cap.
  `https://youtu.be/${ID}?x=${'a'.repeat(2048)}`,
];

/** A row's name in a test title: the text, cut short, with no raw control. */
function shown(link: string): string {
  const text = link.length > 70 ? `${link.slice(0, 70)}...` : link;
  return JSON.stringify(text);
}

describe('parseYouTubeUrl against the service lists', () => {
  it.each(SERVICE_ACCEPTED.map((link) => [shown(link), link]))('accepts %s', (_shown, link) => {
    expect(parseYouTubeUrl(link)?.videoId).toBe(ID);
  });

  it.each(SERVICE_REJECTED.map((link) => [shown(link), link]))('refuses %s', (_shown, link) => {
    expect(parseYouTubeUrl(link)).toBeNull();
  });

  it('has enough rows to mean something', () => {
    expect(SERVICE_ACCEPTED.length + SERVICE_REJECTED.length).toBeGreaterThanOrEqual(30);
  });
});

describe('parseYouTubeUrl accepts', () => {
  const accepted: Array<[string, string, { videoId: string; startS?: number }]> = [
    ['watch on www', `https://www.youtube.com/watch?v=${ID}`, { videoId: ID }],
    ['watch on the bare host', `https://youtube.com/watch?v=${ID}`, { videoId: ID }],
    ['watch on the mobile host', `https://m.youtube.com/watch?v=${ID}`, { videoId: ID }],
    ['watch on YouTube Music', `https://music.youtube.com/watch?v=${ID}`, { videoId: ID }],
    ['a youtu.be short link', `https://youtu.be/${ID}`, { videoId: ID }],
    ['a short', `https://www.youtube.com/shorts/${ID}`, { videoId: ID }],
    ['an embed address', `https://www.youtube.com/embed/${ID}`, { videoId: ID }],
    ['a nocookie embed address', `https://www.youtube-nocookie.com/embed/${ID}`, { videoId: ID }],
    ['a live address', `https://www.youtube.com/live/${ID}`, { videoId: ID }],
    ['a /v/ address', `https://www.youtube.com/v/${ID}`, { videoId: ID }],
    ['no scheme, youtu.be', `youtu.be/${ID}`, { videoId: ID }],
    ['no scheme, watch', `www.youtube.com/watch?v=${ID}`, { videoId: ID }],
    ['no scheme, bare host shorts', `youtube.com/shorts/${ID}`, { videoId: ID }],
    ['surrounding whitespace and a newline', `  https://youtu.be/${ID}\n`, { videoId: ID }],
    ['tabs around it', `\t${`https://youtu.be/${ID}`}\t`, { videoId: ID }],
    [
      'a no-break space and a line separator around it',
      `\u{a0}https://youtu.be/${ID}\u{2028}`,
      { videoId: ID },
    ],
    ['a next-line character around it, which Python trims', `https://youtu.be/${ID}\x85`, { videoId: ID }],
    ['an upper-case scheme and host', `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`, { videoId: ID }],
    ['a mixed-case host', `https://Www.YouTube.com/watch?v=${ID}`, { videoId: ID }],
    ['ids with dash and underscore', `https://youtu.be/${OTHER}`, { videoId: OTHER }],
    ['a trailing slash on a short link', `https://youtu.be/${ID}/`, { videoId: ID }],
    ['a trailing slash on a shorts address', `https://www.youtube.com/shorts/${ID}/`, { videoId: ID }],
    [
      'a playlist link means its one video',
      `https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=4`,
      { videoId: ID },
    ],
    ['v after other parameters', `https://www.youtube.com/watch?feature=share&v=${ID}`, { videoId: ID }],
    [
      'the first of two v parameters decides',
      `https://www.youtube.com/watch?v=${ID}&v=${OTHER}`,
      { videoId: ID },
    ],
    ['a share tracking parameter', `https://youtu.be/${ID}?si=AbCdEf123`, { videoId: ID }],
    ['a fragment is ignored', `https://www.youtube.com/watch?v=${ID}#comments`, { videoId: ID }],
    [
      'a YouTube Music radio list is ignored',
      `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
      { videoId: ID },
    ],
    ['v on a short link is ignored', `https://youtu.be/${ID}?v=${OTHER}`, { videoId: ID }],
    [
      'a non-ASCII character in a parameter nobody reads',
      `https://youtu.be/${ID}?x=caf\u{e9}`,
      { videoId: ID },
    ],
    ['a backslash in a parameter nobody reads', `https://youtu.be/${ID}?x=a\\b`, { videoId: ID }],
  ];
  it.each(accepted)('%s', (_name, input, expected) => {
    expect(parseYouTubeUrl(input)).toEqual(expected);
  });
});

describe('parseYouTubeUrl start times', () => {
  const base = `https://www.youtube.com/watch?v=${ID}`;
  const times: Array<[string, string, number | undefined]> = [
    ['bare seconds', `${base}&t=90`, 90],
    ['seconds with a unit', `${base}&t=90s`, 90],
    ['minutes and seconds', `${base}&t=1m30s`, 90],
    ['hours, minutes and seconds', `${base}&t=1h2m3s`, 3723],
    ['minutes only', `${base}&t=2m`, 120],
    ['hours only', `${base}&t=1h`, 3600],
    ['hours and seconds', `${base}&t=1h30s`, 3630],
    ['the start parameter', `https://www.youtube.com/embed/${ID}?start=45`, 45],
    ['t on a short link', `https://youtu.be/${ID}?t=1m30s`, 90],
    ['t before the v parameter', `https://www.youtube.com/watch?t=75&v=${ID}`, 75],
    ['t wins over start', `${base}&t=10&start=20`, 10],
    ['zero means no start', `${base}&t=0`, undefined],
    ['zero with a unit means no start', `${base}&t=0m0s`, undefined],
    ['a missing value', `${base}&t=`, undefined],
    ['text', `${base}&t=abc`, undefined],
    ['a negative number', `${base}&t=-5`, undefined],
    ['a fraction', `${base}&t=1.5`, undefined],
    ['units out of order', `${base}&t=30s1m`, undefined],
    ['minutes with a bare tail', `${base}&t=1m30`, undefined],
    ['an absurd value', `${base}&t=9999999999`, undefined],
    ['a percent-escaped value is not decoded', `${base}&t=9%30`, undefined],
    ['the fragment form is not read', `${base}#t=30`, undefined],
  ];
  it.each(times)('%s', (_name, input, startS) => {
    const parsed = parseYouTubeUrl(input);
    expect(parsed?.videoId).toBe(ID);
    expect(parsed?.startS).toBe(startS);
    // An absent start time is absent, not undefined-valued.
    if (startS === undefined) expect(parsed).toEqual({ videoId: ID });
  });
});

describe('parseYouTubeUrl refuses', () => {
  const refused: Array<[string, string]> = [
    ['http', `http://www.youtube.com/watch?v=${ID}`],
    ['http on youtu.be', `http://youtu.be/${ID}`],
    ['ftp', `ftp://youtube.com/watch?v=${ID}`],
    ['javascript:', `javascript:alert(1)//youtube.com/watch?v=${ID}`],
    ['data:', `data:text/html,https://youtu.be/${ID}`],
    ['a protocol-relative address', `//youtu.be/${ID}`],
    ['a single slash after the scheme', `https:/youtu.be/${ID}`],
    ['a look-alike suffix', `https://youtube.com.evil.com/watch?v=${ID}`],
    ['a look-alike prefix', `https://evilyoutube.com/watch?v=${ID}`],
    ['another top-level domain', `https://www.youtube.co/watch?v=${ID}`],
    ['youtu.be as a subdomain of another host', `https://youtu.be.evil.io/${ID}`],
    ['a digit for an o', `https://y0utube.com/watch?v=${ID}`],
    ['a Cyrillic letter for the final e', `https://youtub\u{435}.com/watch?v=${ID}`],
    ['a Kelvin sign that lower-cases to a k', `https://www.youtube-nocoo\u{212A}ie.com/embed/${ID}`],
    ['a Kelvin sign in the upper-case form of the name', `https://www.YOUTUBE-NOCOO\u{212A}IE.com/embed/${ID}`],
    ['a dotted capital I that lower-cases to i and a dot', `https://www.youtube.com\u{130}/watch?v=${ID}`],
    ['a dotted capital I where an i belongs', `https://www.youtube-nocook\u{130}e.com/embed/${ID}`],
    ['full-width letters', `https://\u{ff59}\u{ff4f}\u{ff55}\u{ff54}\u{ff55}.be/${ID}`],
    ['an accented letter', `https://www.youtub\u{e9}.com/watch?v=${ID}`],
    ['the host in the path of another', `https://evil.com/youtube.com/watch?v=${ID}`],
    ['the host in the query of another', `https://evil.com/?u=https://youtu.be/${ID}`],
    ['the studio subdomain', `https://studio.youtube.com/watch?v=${ID}`],
    ['the gaming subdomain', `https://gaming.youtube.com/watch?v=${ID}`],
    ['a doubled subdomain', `https://www.m.youtube.com/watch?v=${ID}`],
    ['www on youtu.be', `https://www.youtu.be/${ID}`],
    ['nocookie without www', `https://youtube-nocookie.com/embed/${ID}`],
    ['user info before the host', `https://user@www.youtube.com/watch?v=${ID}`],
    ['user and password', `https://user:pw@youtu.be/${ID}`],
    ['the real host as user info', `https://www.youtube.com@evil.com/watch?v=${ID}`],
    ['an explicit port', `https://www.youtube.com:443/watch?v=${ID}`],
    ['another port', `https://youtu.be:8080/${ID}`],
    ['an empty port', `https://www.youtube.com:/watch?v=${ID}`],
    ['a port with no scheme', `youtube.com:80/watch?v=${ID}`],
    ['a trailing dot on the host', `https://www.youtube.com./watch?v=${ID}`],
    ['a backslash', `https://www.youtube.com\\@evil.com/watch?v=${ID}`],
    ['a backslash in the path', `https://www.youtube.com/watch\\?v=${ID}`],
    ['a playlist page', 'https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstuvwx'],
    ['a watch link with only a list', 'https://www.youtube.com/watch?list=PLabcdefghijklmnopqrstuvwx'],
    ['a playlist embed', 'https://www.youtube.com/embed/videoseries?list=PLabcdefghijklmnopqrstuvwx'],
    ['a channel live-stream embed', 'https://www.youtube.com/embed/live_stream?channel=UCabc'],
    ['a handle page', 'https://www.youtube.com/@somechannel'],
    ['a channel page', 'https://www.youtube.com/channel/UC1234567890123456789012'],
    ['a custom channel page', 'https://www.youtube.com/c/SomeChannel'],
    ['a user page', 'https://www.youtube.com/user/someone'],
    ['a search page', 'https://www.youtube.com/results?search_query=karaoke'],
    ['the home page', 'https://www.youtube.com/'],
    ['the bare host', 'https://www.youtube.com'],
    ['youtu.be with no id', 'https://youtu.be/'],
    ['a watch link with no v', 'https://www.youtube.com/watch'],
    ['an empty v', 'https://www.youtube.com/watch?v='],
    ['a v with no equals sign', 'https://www.youtube.com/watch?v'],
    ['an empty first v, which decides', `https://www.youtube.com/watch?v=&v=${ID}`],
    ['an id one character short', 'https://youtu.be/dQw4w9WgXc'],
    ['an id one character long', 'https://youtu.be/dQw4w9WgXcQQ'],
    ['an id with a bad character', 'https://youtu.be/dQw4w9WgXc!'],
    ['a percent-encoded id', 'https://youtu.be/dQw4w9WgX%51Q'],
    ['a percent-encoded last character in v', 'https://www.youtube.com/watch?v=dQw4w9WgXc%51'],
    ['a percent-encoded first character in v', 'https://www.youtube.com/watch?v=%64Qw4w9WgXcQ'],
    ['a plus sign in v', 'https://www.youtube.com/watch?v=dQw4w9WgXc+'],
    ['a space inside the id', 'https://youtu.be/dQw4w9 gXcQ'],
    ['an id with a trailing segment', `https://youtu.be/${ID}/extra`],
    ['a shorts address with a trailing segment', `https://www.youtube.com/shorts/${ID}/extra`],
    ['a shorts address with two trailing slashes', `https://www.youtube.com/shorts/${ID}//`],
    ['an unknown path prefix', `https://www.youtube.com/clip/${ID}`],
    ['a bare id path on a youtube host', `https://www.youtube.com/${ID}`],
    ['watch on youtu.be', `https://youtu.be/watch?v=${ID}`],
    ['an empty segment before watch', `https://www.youtube.com//watch?v=${ID}`],
    ['a path under watch', `https://www.youtube.com/watch/extra?v=${ID}`],
    ['a trailing slash on watch', `https://www.youtube.com/watch/?v=${ID}`],
    ['an upper-case watch', `https://www.youtube.com/WATCH?v=${ID}`],
    ['a newline in the middle', `https://youtu.be/${ID}\nhttps://evil.example`],
    ['two links', `https://youtu.be/${ID} https://youtu.be/${OTHER}`],
    ['a control character', `https://youtu.be/${ID}\x00`],
    ['a zero-width space after the id', `https://youtu.be/${ID}\u{200b}`],
    ['a zero-width space in a parameter', `https://www.youtube.com/watch?v=${ID}&x=\u{200b}`],
    ['a zero-width joiner in the host', `https://you\u{200d}tu.be/${ID}`],
    ['a soft hyphen in a parameter', `https://www.youtube.com/watch?v=${ID}&x=a\u{ad}b`],
    ['a no-break space inside', `https://youtu.be/${ID}\u{a0}extra`],
    ['an ideographic space inside', `https://youtu.be/${ID}\u{3000}extra`],
    ['a byte order mark at the start, which Python does not trim', `\u{feff}https://youtu.be/${ID}`],
    ['a byte order mark at the end', `https://youtu.be/${ID}\u{feff}`],
    ['a private-use character inside', `https://youtu.be/${ID}?x=\u{e000}`],
    ['a lone surrogate inside', `https://youtu.be/${ID}?x=\u{d800}`],
    ['a bare id', ID],
    ['plain text', 'karaoke tonight'],
    ['an empty string', ''],
    ['only whitespace', '   \n\t '],
    ['only a byte order mark', '\u{feff}'],
    ['the scheme alone', 'https://'],
  ];
  it.each(refused)('%s', (_name, input) => {
    expect(parseYouTubeUrl(input)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['https://youtu.be/dQw4w9WgXcQ']]) {
      expect(parseYouTubeUrl(value as unknown as string)).toBeNull();
    }
  });
});

describe('parseYouTubeUrl length cap', () => {
  const prefix = `https://youtu.be/${ID}?x=`;

  it('counts 2048 characters as fine and 2049 as too many', () => {
    const atCap = prefix + 'a'.repeat(2048 - prefix.length);
    expect(atCap).toHaveLength(2048);
    expect(parseYouTubeUrl(atCap)).toEqual({ videoId: ID });
    expect(parseYouTubeUrl(`${atCap}a`)).toBeNull();
  });

  it('measures the link, not the whitespace around it, as the service does', () => {
    const atCap = prefix + 'a'.repeat(2048 - prefix.length);
    expect(parseYouTubeUrl(`  \n${atCap}\t  `)).toEqual({ videoId: ID });
    expect(parseYouTubeUrl(`  \n${atCap}a\t  `)).toBeNull();
  });

  it('refuses a huge paste without reading it', () => {
    expect(parseYouTubeUrl('x'.repeat(5_000_000))).toBeNull();
    expect(parseYouTubeUrl(' '.repeat(100_000))).toBeNull();
  });
});

describe('parseYouTubeUrl ids', () => {
  it('may hold dashes and underscores and keep their case', () => {
    for (const videoId of ['-_-_-_-_-_-', 'a-b_c-d_e-f', 'AbCdEfGhIjK', '___________']) {
      expect(parseYouTubeUrl(`https://youtu.be/${videoId}`)?.videoId).toBe(videoId);
      expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${videoId}`)?.videoId).toBe(videoId);
    }
  });

  it('are never percent-decoded: an escape does not make an id', () => {
    // %64 is "d" and %51 is "Q", so a decoding parser would accept these.
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=%64Qw4w9WgXcQ')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXc%51')).toBeNull();
    expect(parseYouTubeUrl('https://youtu.be/%64Qw4w9WgXcQ')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/embed/dQw4w9WgXc%51')).toBeNull();
  });

  it('are the first v parameter, as in the service', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&v=${OTHER}`)).toEqual({ videoId: ID });
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${OTHER}&v=${ID}`)).toEqual({ videoId: OTHER });
  });
});

describe('parseYouTubeUrl results', () => {
  it('returns a fresh object with only videoId and startS', () => {
    const a = parseYouTubeUrl(`https://youtu.be/${ID}?t=5`);
    const b = parseYouTubeUrl(`https://youtu.be/${ID}?t=5`);
    expect(a).toEqual({ videoId: ID, startS: 5 });
    expect(a).not.toBe(b);
    expect(Object.keys(a ?? {}).sort()).toEqual(['startS', 'videoId']);
  });
});
