# Coaching

Two modes (owner, 2026-10-27). **Karaoke mode** is the default and never
judges: no scores, no hit or miss colours, no tips. The one thing it can show,
only when the singer turns the note guide on, is a neutral readout of the
nearest note and how many cents sharp or flat, with no colour and nothing
stored. **Learning mode** is
opt-in and direct: it scores every take against the original vocal and
says where the singing misses. Tips come only when the singer asks for
them. Every finding carries its evidence (which notes, how far off) so
the singer can jump to the moment and hear it.

Learning mode needs the original singer to compare against. On a karaoke
track (no vocal) it says so before the take, in plain words: "Learning
mode compares your singing with the original singer's. This is a karaoke
track, so there is no melody in it to compare with: the card measures your voice on
its own (Open can also score it against the key)." It offers to find the original recording instead, and,
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

### Your voice (WL1): the singing alone, no melody needed

Learning mode measures the singing itself on every take, with a melody or
without one, so a YouTube karaoke video (no vocal to take a melody from) gets
feedback too. The notes are the take's own (segmentation rule below, plus: a
piece under 150 ms that steps up into a longer note within 40 ms is a scoop
and joins it). The `voice` section of the report holds, per note and per take:

| Feature | How |
|---|---|
| Reference | each note's cents from the nearest tone of the song's key (the service's `KeyMap`, tuning taken off) when every judged note has a clear key; else of a key estimated from the sung notes; else the nearest semitone at A = 440 Hz. The card says which. |
| Estimated key | Krumhansl-Schmuckler: Pearson correlation of the duration-weighted pitch classes (notes ≥ 150 ms) with the 24 rotated Krumhansl-Kessler profiles. Needs ≥ 6 notes over ≥ 5 pitch classes, a correlation ≥ 0.75 and a lead of ≥ 0.05 over the best key that is not the winner's relative; otherwise "no clear key" and the semitone fallback. |
| Intonation | signed cents of each judged note (≥ 150 ms, its median pitch) from its tone; the take's median is the bias; the shares within ±25 c and ±50 c. |
| Stability | on notes over 650 ms (the 150 ms scoop window plus the 2 cycles vibrato needs at the slowest rate, 4 Hz, so a shorter note's vibrato could not be taken out and is not scored as spread), the std of cents after the first 150 ms with a straight line and, where found, the vibrato removed, so vibrato and drift are never called a wobble. |
| Scoop | median of the steady part minus median of the first 150 ms; positive is a slide up into the note. |
| Drift | on notes over 600 ms, the slope in cents per second of the same fit. |
| Vibrato | on notes over 500 ms, a sinusoid fitted together with the line over 3 to 9 Hz; it is vibrato when the best rate is 4 to 8 Hz, the amplitude (extent, cents either side) is ≥ 25 c, it explains ≥ 50 % of the variance (regularity), the note holds ≥ 2 cycles and the best rate explains at least 10 points more of the variance than the best rate 1 Hz or more away (a peak, not a plateau of wander). |
| Range | p10 to p90 of the voiced frames. |
| Phrases | notes joined while the silence between them is ≤ 250 ms; longer silences are breaths. Count, median and longest length, median breath. |

The voice is judged against concert pitch when there is no key map, so a
karaoke track tuned off A = 440 reads as the singer's bias; the card says what
the notes were judged against. In Strict with no melody, and on a karaoke
track, the take gets the voice section alone and the lane is coloured like a
tuner (25 c hit, 50 c okay, beyond that off, from the nearest tone). Open keeps
its freestyle colours. Karaoke mode computes none of it.

Later, with service analysis: dynamics (envelope, phrase-end fade, range), timbre (brightness,
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

Each item with a Replay (a worst note of "Your voice", a worst phrase) has
a summary and a muted detail line, which are evidence and always shown, and
one tip, shown only once the singer presses the card's Tips button (tips come
only on request). The detail line
gives the song time, the lyric sung there when lyrics were imported, the note
sung against its tone, cents sharp or flat, how long it was held, and every
trait that was measured on it (spread, scoop, drift, vibrato); a trait not
measured is left out. A phrase gives its shares on target, close and off, the
mean error, its median lean and entry time, and notes sung. The tip is a rule
over the dominant measured problem, the measure furthest past its threshold;
when no measure reaches its threshold there is no tip. The thresholds are the
take-level tips table below (`TIP_THRESHOLDS`), read by `REPLAY_TIP_THRESHOLDS`
in `src/app/replay-detail.ts`: scoop over 60 c, drift over 20 c/s, wobble over
35 c, wide vibrato over 80 c, a phrase lean over 20 c, and early or late at the
scoring style's own limit (60 ms in Strict, 120 ms in Open). One number is
replay's own: a note 60 c from its tone only weights the pitch tip against the
other rules and never gates it. Replay tips are not part of the three-tip cap
of the card's own tips.

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

## Scoring a karaoke track against its original (WL3b)

A karaoke video has no vocal, so no melody of its own. The singer can name
its original (Find the original, then Use as original on a result, or Use as
original on a prepared Library song with a melody) and the service borrows
that melody: it aligns the original's backing (the `no_vocals` stem when it
has one) to the karaoke audio by chroma and dynamic time warping, finds the
key shift between them (karaoke tracks are often sung a few semitones off),
and writes the original's contour and notes into the karaoke song's reference,
moved onto the karaoke's clock and shifted by that many semitones. The
reference carries `aligned_from`, `key_offset` and `confidence`. Strict then
scores the take against it like any song; the notice that a karaoke track has
no melody goes, and the song panel says the shift and the match in plain
words ("2 semitones higher than the original, match 87%").

It refuses rather than guesses. The match has a confidence from three checks:
how close the two backings are frame by frame, how steady the tempo ratio of
the warp is (it must stay between 0.8 and 1.25 over most of the song; a
re-recorded arrangement at another tempo or with a different structure fails
this), and how much of the karaoke the path covers. Under 0.5 nothing is
written, the card says "the arrangement differs too much; Open scoring uses
the key instead", and the notice offers Switch to Open as before. The
thresholds were set on synthetic chord progressions; real songs are the
owner's to try, and the floor is a constant (`CONFIDENCE_FLOOR` in
`service/encore_service/align.py`).

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
| drift | voice | \|slope\| > 20 c/s on > 40 % of notes over 600 ms, at least 3 notes | Long notes drift away from where they start. Set the pitch before you open the note and keep the air steady to the end. |
| vibrato_wide | voice | median vibrato extent > 80 c either side, at least 3 notes | Your vibrato swings wide. Relax the jaw and throat and let it narrow to a gentle pulse. |
| vibrato_irregular | voice | median vibrato regularity < 70 %, at least 3 notes | Your vibrato wanders in speed. Keep the air steady and let it settle into an even pulse. |
| short_phrases | voice | median phrase < 1.5 s, at least 4 phrases | You break lines into short pieces. Take a low breath and plan where you breathe, at the ends of lines. |

`general` rules run in both styles (`flat_bias` and `sharp_bias` on
melody notes only), `match` rules in Strict, and `open` rules on
freestyle notes, in Open and in free phrases. `voice` rules read the voice
section on every take. With no melody the `general` rules `flat_bias`,
`sharp_bias`, `scoop` and `unstable_sustain` read the voice notes instead
(cents from the nearest tone, same thresholds, the evidence names what the
tone was); with a melody they read the melody's notes as before. Every tip
names its numbers.

Later, with service analysis: `vibrato_wider`, `vibrato_slower`,
`softer_here`, `brighter`, `phrase_fade`.

## Stars, personal bests and the streak (W6d)

Learning mode only, except the streak. Each learning take has one primary
measure, a share: Strict with a melody, the in-tune share (notes within
50 c); Strict with no melody, the share of notes within 50 c of their tone
(the voice section's measure); Open, the share of sung notes on the melody
or, off it, in the song's key (the in-key share alone when there is no
melody). A song's stars come from its best take: 1 star from 60 %, 2 from
75 %, 3 from 90 %. They show on the report card and on the song's Library
row, never in karaoke mode. A take is a personal best when its share, in
whole percent, tops every earlier take of the song measured the same way
(the first take has nothing to beat); the card then shows a short skin
flourish (still under `prefers-reduced-motion`) and one line with the
measure and both numbers. The header chip counts days sung in a row, in
both modes: a day counts when a take with at least 5 voiced frames was
saved that local day (Mic check takes excluded); yesterday keeps the streak
alive until today ends. It judges nothing. "Save card (.png)" draws the
card (song, date, stars, headline, the card's own lines) into a canvas in
the skin's colours.

## What we do not claim

- Tone aesthetics, emotion, diction, and "support" are not measured.
- Breathy or stylised singing is not wrong; tips stay quiet unless pitch
  or timing suffers.
- Rap and spoken sections have no pitch target; they are flagged unpitched
  and excluded from intonation.
- In key means a note fits the song, not that it is the right note or a
  good line. Blues bends and chromatic lines are not wrong: they show as
  off key with their distance, and only `off_key` comments on them.
- An estimated key is a guess from what was sung: a singer who is off key
  all night can point to the wrong key. It is labelled as estimated with its
  fit, and with no clear key notes are judged against the nearest semitone.
- Vibrato is called only in the 4 to 8 Hz band at 25 c or more and only where
  it peaks at one rate; a slower or smaller swing is counted in the note's
  spread. A note under 500 ms is not searched for vibrato and one under 650 ms
  gets no spread, since a vibrato in it could not be fitted.
- Reference vocals with doubles or harmonies confuse the tracker; frames
  with low confidence are excluded and the region is marked in the lane.
