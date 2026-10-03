/**
 * Checks the skin contract (docs/SKINS.md): every skin CSS file defines every
 * token and keeps text readable, the registry matches the files on disk, the
 * Studio copy table is complete and covers every coaching rule, and missing
 * copy falls back to Studio. CSS and docs are read as raw text through Vite's
 * glob import, which needs no Node typings and runs without a DOM.
 */
import { describe, expect, it } from 'vitest';
import { copyFor, SKIN_STORAGE_KEY, SKIN_TOKENS, SKINS } from '../src/skins';
import { studio } from '../src/skins/studio';
import { COPY_KEYS } from '../src/skins/types';
import type { Skin } from '../src/skins/types';

const rawCss = import.meta.glob<string>('../src/skins/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const rawCoaching = import.meta.glob<string>('../docs/COACHING.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const rawSkinsDoc = import.meta.glob<string>('../docs/SKINS.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const rawIndexHtml = import.meta.glob<string>('../index.html', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Skin CSS keyed by file stem, e.g. "studio". */
const cssById = new Map(
  Object.entries(rawCss).map(([path, css]) => [path.replace(/^.*\/(.+)\.css$/, '$1'), css]),
);

/** The token declarations inside a skin's `:root[data-skin=<id>] { ... }`. */
function tokenBlock(id: string): string {
  const css = cssById.get(id) ?? '';
  const match = new RegExp(`:root\\[data-skin=['"]?${id}['"]?\\]\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : '';
}

function tokenValue(block: string, token: string): string | undefined {
  return new RegExp(`(?:^|[\\s;{])${token}\\s*:\\s*([^;]+);`).exec(block)?.[1].trim();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('skin registry', () => {
  it('has unique lowercase single-word ids', () => {
    const ids = SKINS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });

  it('matches the CSS files in src/skins one to one', () => {
    expect(SKINS.map((s) => s.id).sort()).toEqual([...cssById.keys()].sort());
  });

  it('lists Studio first, as the default', () => {
    expect(SKINS[0]).toBe(studio);
  });

  it('uses the storage key the pre-paint script in index.html reads', () => {
    const html = Object.values(rawIndexHtml)[0] ?? '';
    expect(html).toContain(`localStorage.getItem('${SKIN_STORAGE_KEY}')`);
  });
});

describe('skin token contract', () => {
  it('is exactly the token list in docs/SKINS.md', () => {
    const doc = Object.values(rawSkinsDoc)[0] ?? '';
    // The first code fence after "Tokens" holds the contract.
    const fence = /Tokens[^`]*```\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
    const documented = fence.match(/--[a-z0-9-]+/g) ?? [];
    expect(documented.length).toBeGreaterThan(0);
    expect([...SKIN_TOKENS].sort()).toEqual([...documented].sort());
  });
});

describe('skin CSS tokens', () => {
  for (const skin of SKINS) {
    it(`${skin.id} defines every token`, () => {
      const block = tokenBlock(skin.id);
      expect(block, `no :root[data-skin=${skin.id}] block`).not.toBe('');
      const missing = SKIN_TOKENS.filter((token) => tokenValue(block, token) === undefined);
      expect(missing).toEqual([]);
    });

    it(`${skin.id} keeps text at WCAG AA on every surface`, () => {
      const block = tokenBlock(skin.id);
      const grounds = ['--color-bg', '--color-surface', '--color-surface-2'];
      for (const fg of ['--color-text', '--color-text-muted', '--color-accent']) {
        for (const bg of grounds) {
          const ratio = contrast(tokenValue(block, fg) ?? '#000000', tokenValue(block, bg) ?? '#000000');
          expect(ratio, `${skin.id} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

describe('skin copy', () => {
  it('gives Studio every copy key and nothing else', () => {
    expect(Object.keys(studio.copy).sort()).toEqual([...COPY_KEYS].sort());
    for (const key of COPY_KEYS) expect(studio.copy[key].trim(), key).not.toBe('');
  });

  it('has a copy key for every rule id in docs/COACHING.md', () => {
    const doc = Object.values(rawCoaching)[0] ?? '';
    const ruleIds = [...doc.matchAll(/^\| (\w+) \| (?:general|match) \|/gm)].map((m) => m[1]);
    expect(ruleIds.length).toBeGreaterThan(0);
    for (const id of ruleIds) expect(COPY_KEYS as readonly string[], id).toContain(id);
  });

  it('only overrides known keys in every skin', () => {
    for (const skin of SKINS) {
      for (const key of Object.keys(skin.copy)) expect(COPY_KEYS as readonly string[]).toContain(key);
    }
  });

  it('falls back to Studio for a missing key', () => {
    const bare: Skin = { id: 'bare', name: 'Bare', tagline: '', fx: studio.fx, copy: {} };
    for (const key of COPY_KEYS) expect(copyFor(bare, key)).toBe(studio.copy[key]);

    const partial: Skin = { ...bare, copy: { streak5: 'Custom' } };
    expect(copyFor(partial, 'streak5')).toBe('Custom');
    expect(copyFor(partial, 'streak10')).toBe(studio.copy.streak10);
  });

  it('lets a skin override Studio where it defines a key', () => {
    const arcade = SKINS.find((s) => s.id === 'arcade') as Skin;
    expect(copyFor(arcade, 'streak5')).not.toBe(studio.copy.streak5);
  });
});
