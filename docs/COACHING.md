# Coaching

Two modes (owner, 2026-10-27). **Karaoke mode** is the default and never
judges: no scores, no hit or miss colours, no tips. **Learning mode** is
opt-in and direct: it scores every take against the original vocal and
says where the singing misses. Tips come only when the singer asks for
them. Every finding carries its evidence (which notes, how far off) so
the singer can jump to the moment and hear it.

Learning mode needs the original singer to compare against. On a karaoke
track (no vocal) it says so before the take, in plain words: "Learning
mode compares your singing with the original singer's. This is a karaoke
track, so there is no singer in it to compare against: you're on your own
for this one." It offers to find the original recording instead, and,
from W4, to switch to Open, which scores the take on the song's key.

Scoring runs in the browser on the live tracker's frames (W3), aligned by
the calibrated latency. Re-tracking the take in the service, DTW
alignment and the timbre features are Later (`ROADMAP.md`).

## What we measure

Now (W3), from the live frames against `reference.json`:

| Group | Feature | How |
|---|---|---|
| Intonation | bias | mean signed cents error over voiced frames in notes |
| | stability | std of cents error within sustained notes (> 400 ms) |
| | scoop | cents error in the first 150 ms of a note vs its steady state |
| | in-tune rate | share of notes with mean error within ±50 cents |
| Timing | onset delta | note onset minus reference onset, per note |
| | early/late bias | median onset delta |
| Length | held length | sung duration against the reference note's |
| Range | song range | low/high MIDI of the reference |
| | sung range | p10–p90 of the singer's MIDI in this take |

Later, with service analysis: drift, vibrato (rate, extent, regularity),
dynamics (envelope, phrase-end fade, range), timbre (brightness,
breathiness, vowel shape), breath (phrasing gaps).

Notes are segmented from a contour by: voiced run ≥ 80 ms, split where the
median-filtered pitch jumps ≥ 80 cents and stays for ≥ 60 ms, merged across
gaps < 40 ms. The service uses this rule for the reference (W1); the
browser uses it for the take.

## Scoring (learning mode)

Per frame, the cents error against the reference note under it maps to
hit (≤ 25 c), okay (≤ 50 c) or miss. An octave-invariant option folds the
error into ±600 c for singers in another register. The report card shows
the in-tune rate, which notes were off and which way, early or late, and
the three worst phrases. Skins change the colours and the copy, never the
numbers (`docs/SKINS.md`).

## Scoring styles (learning mode, W4)

Two styles (owner, 2026-10-28), chosen beside the mode toggle and shown
only in learning mode. Both measure; they differ in what counts as right.
Strict is the default and is the scoring above.

| | Strict | Open |
|---|---|---|
| Compared with | the original's melody | the melody, else the song's key |
| Octave | must match (the octave-invariant option, off by default) | any octave |
| Pitch hit / okay | ≤ 25 c / ≤ 50 c | ≤ 50 c / ≤ 100 c |
| Onset on time | per note, early or late in ms | within ± 150 ms of the reference onset |
| Early or late tips fire at | 60 ms bias | 120 ms bias |
| A note off the melody | a miss | freestyle, judged on key fit |
| Free phrases | judged as in Open | everything off the melody is freestyle |
| Tips | `general` and `match` rules | `general` rules and `open` rules |

**Key fit.** The service estimates the song's key from the instrumental
(`KeyMap`: segments with a tonic, a mode and a confidence, plus a tuning
offset in cents). A freestyle note is in key when its mean pitch, after
the tuning offset, is within 50 c of a tone of the key's scale: the seven
notes of the major or natural minor scale, and in minor also the raised
6th and 7th. Notes shorter than 150 ms are passing tones and are not
judged. Where a segment's key is unclear (confidence under the gate),
freestyle there is judged only on steadiness, and the card says the key
was unclear. A relative major and minor have the same notes, so confusing
them changes nothing.

**Where freestyle applies.** In Open: any note that matches no melody
note, and any singing where there is no melody (gaps, a skipped
reference, a karaoke track). In both styles: phrases the singer marks
free. The card shows the share on the melody, the share of freestyle in
key, and each off-key note with how far off and a jump-to.

## Tips (learning mode, on request)

Each rule is a pure function from the take's measurements to zero or one
tip. Thresholds live in one table so they can be tuned. At most three tips
per take, the strongest first, so the singer has something to do rather
than a wall of red.

| id | mode | fires when | message |
|---|---|---|---|
| flat_bias | general | bias < −20 c on > 40 % of notes | You sing under the note, most on the higher ones. Aim slightly above where it feels right. |
| sharp_bias | general | bias > +20 c on > 40 % of notes | You push above the note. Relax the push on onsets. |
| scoop | general | median scoop > 60 c | You slide up into notes. Land on the centre, then add the slide on purpose. |
| unstable_sustain | general | stability > 35 c on > 30 % of long notes | Long notes wobble. Steady air; practise one sustained vowel at a time. |
| late_onsets | general | late bias > 60 ms | You are behind the beat. Breathe one beat earlier. |
| early_onsets | general | early bias > 60 ms | You come in ahead of the beat. Wait for it; listen for the note before. |
| out_of_range | general | song high > sung p90 + 2 semitones | This song sits above where your voice is comfortable today. Ease off the top notes rather than forcing them. |
| held_shorter | match | duration < 0.7 × reference on > 30 % of long notes | The original holds these notes longer. Keep the air going to the end. |
| off_key | open | > 25 % of freestyle notes off key, at least 4 notes | Some of your free notes land outside the song's key. Build ad-libs from notes of the melody or the bass line, and keep outside notes short, as passing notes. |

`general` rules run in both styles (`flat_bias` and `sharp_bias` on
melody notes only), `match` rules in Strict, and `open` rules on
freestyle notes, in Open and in free phrases.

Later, with service analysis: `vibrato_wider`, `vibrato_slower`,
`softer_here`, `brighter`, `phrase_fade`.

## What we do not claim

- Tone aesthetics, emotion, diction, and "support" are not measured.
- Breathy or stylised singing is not wrong; tips stay quiet unless pitch
  or timing suffers.
- Rap and spoken sections have no pitch target; they are flagged unpitched
  and excluded from intonation.
- In key means a note fits the song, not that it is the right note or a
  good line. Blues bends and chromatic lines are not wrong: they show as
  off key with their distance, and only `off_key` comments on them.
- Reference vocals with doubles or harmonies confuse the tracker; frames
  with low confidence are excluded and the region is marked in the lane.
