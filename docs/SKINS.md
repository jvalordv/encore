# Skins

A skin changes how encore looks, moves, and talks. It never changes what it
measures. Three ship first, more are cheap once the contract holds.

## Contract

Every skin is three things:

1. **`src/skins/<id>.css`** setting every token below on `:root[data-skin=<id>]`.
2. **`src/skins/<id>.ts`** exporting a `Skin` object: metadata, FX config,
   and the personality copy table.
3. A registration line in `src/skins/index.ts`.

Tokens (all required, the registry test checks each CSS file defines them):

```
--color-bg --color-surface --color-surface-2 --color-text --color-text-muted
--color-accent --color-accent-2 --color-singer-a --color-singer-b
--color-hit --color-okay --color-miss --color-reference
--color-free --color-free-band
--font-display --font-body --font-mono
--radius --border-width --shadow
--motion-fast --motion-slow --easing
--lane-bg --lane-grid --lane-ribbon-width
```

`--color-free` paints a freestyle frame on the lane (learning mode, Open style or
a free phrase) and `--color-free-band` the band behind a free phrase; both are
translucent-friendly colours that read as neither a hit nor a miss.

`Skin` type:

```ts
interface Skin {
  id: string;            // lowercase word, matches the CSS file
  name: string;          // shown in the switcher
  tagline: string;
  fx: { particles: 'none' | 'sparks' | 'sparkles'; hitEffect: 'none' | 'flash' | 'hearts';
        streakShake: boolean; confettiOnGrade: boolean };
  copy: Partial<Copy>;   // every user-facing string, keyed; Studio is complete
}
```

`Copy` keys are shared across skins (same facts, different voice): streak
callouts by tier, phrase star captions, grade titles, report card headings,
and one phrasing per coaching rule id from `docs/COACHING.md`. Missing keys
fall back to Studio so a new skin can start small.

Switching sets `data-skin` on `<html>`, persists to `localStorage`, and emits
a state event so canvases re-read their colours. All skins must keep text
contrast at WCAG AA and honour `prefers-reduced-motion` (FX off, transitions
instant).

## The three

**Studio** (`studio`). Utilitarian. Near-black background, one cool accent,
monospace numbers, hairline grid, no particles. Copy is plain: "87 % in
tune. Best streak 14." The default and the fallback.

**Arcade** (`arcade`). Neon on black, chunky display font, scanline texture
on the lane, sparks on hits, screen shake at streak milestones, combo
counter. Copy shouts: "COMBO ×12!", "PERFECT", grades as rank letters with a
flashing "NEW RECORD".

**Dreamhouse** (`dreamhouse`). Hot pink, lavender, gold, rounded everything,
soft shadows, a script display font paired with a clean body font, sparkle
particles, hearts on perfect notes, glitter ribbon trail, confetti on the
grade. Copy is warm and extra: "Gorgeous! ✨", "That chorus was a whole
moment", report card titled "Tonight's Encore".

Later candidates: Lounge (velvet, brass, warm lamps), Y2K (chrome, lime,
bubbles), Blueprint (paper and ink, for the owner's inner engineer).
