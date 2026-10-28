/**
 * Checks the parts of index.html the YouTube embed depends on, read as raw
 * text (the same way test/skins.test.ts reads it): the referrer policy that
 * keeps YouTube from refusing the embed with error 153, the pane for the
 * player (hidden until a link loads, a sibling of the lane and not inside it),
 * the link box, the dropzone copy, and that no script from YouTube is in the
 * page, since the IFrame API must load only when a link is first used. The
 * stylesheet is checked for the rules that keep the 480 pixel player inside
 * the page at every window width (the real layout is measured by the end-to-
 * end run, which is not part of CI).
 */
import { describe, expect, it } from 'vitest';

const rawHtml = import.meta.glob<string>('../index.html', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const rawCss = import.meta.glob<string>('../src/style.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const rawSkins = import.meta.glob<string>('../src/skins/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const html = Object.values(rawHtml)[0] ?? '';
const css = Object.values(rawCss)[0] ?? '';
const skinCss = Object.values(rawSkins);

/** The `@media (max-width: Npx)` rules of the stylesheet, with their bodies. */
function mediaBlocks(): Array<{ maxWidth: number; body: string }> {
  const blocks: Array<{ maxWidth: number; body: string }> = [];
  const header = /@media \(max-width:\s*(\d+)px\)\s*\{/g;
  for (let match = header.exec(css); match; match = header.exec(css)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') depth -= 1;
      end += 1;
    }
    blocks.push({ maxWidth: Number(match[1]), body: css.slice(start, end - 1) });
  }
  return blocks;
}

/** The opening tag of the element with the given id. */
function tagOf(id: string): string {
  return new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? '';
}

describe('index.html for the YouTube embed', () => {
  it('keeps the origin on cross-origin requests so the embed is not refused', () => {
    expect(html).toContain('<meta name="referrer" content="strict-origin-when-cross-origin"');
  });

  it('invites a pasted link in the dropzone', () => {
    expect(html).toContain('Drop an mp3 here, click to choose one, or paste a YouTube link');
  });

  it('has a link box and a Load button', () => {
    expect(tagOf('link-input')).toContain('type="text"');
    expect(tagOf('link-load')).toContain('type="button"');
  });

  it('holds the player in a pane that starts hidden', () => {
    expect(tagOf('embed-region')).toMatch(/\bhidden\b/);
    expect(tagOf('embed-player')).not.toBe('');
  });

  it('keeps the lane beside the player pane, never inside it', () => {
    const region = html.indexOf('id="embed-region"');
    const regionEnd = html.indexOf('</section>', region);
    const lane = html.indexOf('id="pitch-lane"');
    expect(region).toBeGreaterThan(-1);
    expect(lane).toBeGreaterThan(regionEnd);
    // Both sit in the same stage.
    const stage = html.indexOf('id="stage"');
    expect(stage).toBeGreaterThan(-1);
    expect(stage).toBeLessThan(region);
  });

  it('starts the embed offset field and the mode note hidden', () => {
    expect(tagOf('embed-offset')).toMatch(/\bhidden\b/);
    expect(tagOf('embed-note')).toMatch(/\bhidden\b/);
  });

  it('does not load anything from YouTube up front', () => {
    expect(html).not.toMatch(/<script[^>]+src="https?:\/\/[^"]*youtube/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:\/\/[^"]*(youtube|ytimg)/i);
  });
});

describe('index.html for preparing a linked song', () => {
  it('has an automatic-prepare checkbox that starts off, worded as the policy note needs', () => {
    const box = tagOf('auto-prepare');
    expect(box).toContain('type="checkbox"');
    expect(box).not.toMatch(/\bchecked\b/);
    expect(html).toContain(
      'Prepare YouTube songs automatically (downloads the audio; see service/README.md)',
    );
  });

  it('keeps the checkbox and its words in one label, so the words toggle it', () => {
    const label = /<label[^>]*\bfor="auto-prepare"[^>]*>([\s\S]*?)<\/label>/.exec(html)?.[1] ?? '';
    expect(label).toContain('id="auto-prepare"');
    expect(label).toContain('downloads the audio');
  });

  it('holds the prepare group in the song panel, hidden until a video is the song', () => {
    expect(tagOf('prepare')).toMatch(/\bhidden\b/);
    const panel = html.indexOf('id="song-panel"');
    const group = html.indexOf('id="prepare"');
    const devices = html.indexOf('aria-label="Devices"');
    expect(panel).toBeGreaterThan(-1);
    expect(group).toBeGreaterThan(panel);
    expect(group).toBeLessThan(devices);
  });

  it('has the button, the progress list and the note the panel is drawn into', () => {
    expect(tagOf('prepare-button')).toContain('type="button"');
    expect(tagOf('prepare-steps')).toMatch(/\bhidden\b/);
    expect(tagOf('prepare-note')).toContain('aria-live="polite"');
  });

  it('tells the singer in the embed note that the song can be prepared', () => {
    const note = /id="embed-note"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
    expect(note).toMatch(/Prepare the song/);
    expect(note).toMatch(/not built yet/);
  });
});

describe('style.css for the YouTube embed', () => {
  it('sizes the player at least 480 by 270 at 16:9', () => {
    const block = /\.embed-player\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/min-width:\s*480px/);
    expect(block).toMatch(/min-height:\s*270px/);
    expect(block).toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
  });

  it('puts nothing over, around or on the player that could cover or alter it', () => {
    const rules = [...css.matchAll(/(\.embed-region|\.embed-player|\.embed-slot)\s*\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const [, selector, body] of rules) {
      expect(body, selector).not.toMatch(/\b(transform|filter|opacity|clip-path|mask|overflow|z-index|backdrop-filter)\s*:/);
    }
    // No pseudo-element overlay on the frame or the player either.
    expect(css).not.toMatch(/\.embed-(region|player|slot)(::|:)(before|after)/);
    expect(css).not.toMatch(/#embed-(region|player)(::|:)(before|after)/);
  });

  it('takes the frame\'s look from the shared skin tokens only', () => {
    const frame = /\.embed-region,[\s\S]*?\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(frame).toContain('var(--color-surface)');
    expect(frame).toContain('var(--border-width)');
    expect(frame).toContain('var(--radius)');
  });
});

describe('style.css keeps the player inside the page at every width', () => {
  // The frame is the 480 px player, the frame's 8 px padding either side and
  // the widest skin's border either side.
  const widestBorder = Math.max(
    ...skinCss.map((source) => Number(/--border-width:\s*(\d+)px/.exec(source)?.[1] ?? 0)),
  );
  const frame = 480 + 2 * 8 + 2 * widestBorder;
  const pagePadding = 2 * 12;
  const pageGap = 12;
  /** What a page scrollbar takes from the width on a desktop browser. */
  const scrollbar = 15;

  it('reads the skins and the frame it is sizing for', () => {
    expect(skinCss.length).toBeGreaterThanOrEqual(3);
    expect(widestBorder).toBeGreaterThan(0);
    expect(/\.embed-region\s*\{[^}]*padding:\s*8px/.test(css)).toBe(true);
  });

  it('stacks the song panel above the stage before the stage is narrower than the frame', () => {
    const blocks = mediaBlocks();
    // Below 900 px the song column is at most this wide.
    const narrowColumns = blocks.find((b) => b.maxWidth === 900)?.body ?? '';
    const songColumn = Number(/minmax\(\s*\d+px,\s*(\d+)px\s*\)/.exec(narrowColumns)?.[1]);
    expect(songColumn).toBeGreaterThan(0);
    const stacked = blocks.find((b) => /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(b.body));
    expect(stacked).toBeDefined();
    // Beside the song column the stage is the window less these.
    expect(stacked!.maxWidth).toBeGreaterThanOrEqual(songColumn + pagePadding + pageGap + frame + scrollbar);
  });

  it('scrolls the stage sideways, not the page, when even one column is too narrow', () => {
    const scrolling = mediaBlocks().find((b) => /#stage\s*\{[^}]*overflow-x:\s*auto/.test(b.body));
    expect(scrolling).toBeDefined();
    expect(scrolling!.maxWidth).toBeGreaterThanOrEqual(pagePadding + frame + scrollbar);
  });

  it('never clips the frame or the player themselves', () => {
    // The scrolling stage is the only place a width can hide part of them.
    for (const { body } of mediaBlocks()) {
      expect(body).not.toMatch(/\.embed-(region|player|slot)[^{]*\{[^}]*overflow/);
    }
  });
});

describe('index.html for the karaoke track', () => {
  it('holds the karaoke panel in the song panel, after the prepare group and hidden', () => {
    expect(tagOf('karaoke')).toMatch(/\bhidden\b/);
    const prepare = html.indexOf('id="prepare"');
    const karaoke = html.indexOf('id="karaoke"');
    const devices = html.indexOf('aria-label="Devices"');
    expect(karaoke).toBeGreaterThan(prepare);
    expect(karaoke).toBeLessThan(devices);
  });

  it('no longer says in the embed note that the stems and melody are unbuilt', () => {
    const note = /id="embed-note"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
    expect(note).toMatch(/karaoke track and the melody/);
    expect(note).not.toMatch(/stems are not built/);
  });
});
