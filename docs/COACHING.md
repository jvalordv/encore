# Coaching

Two goals, two modes. **General** mode judges the singing on its own terms.
**Match** mode judges it against the original vocal. Both run on the same
measured features. Every recommendation carries its evidence (which notes,
how far off) so the singer can jump to the moment and hear it.

## What we measure

Per take, after alignment to the reference (DTW on the two contours, with the
calibrated latency already removed):

| Group | Feature | How |
|---|---|---|
| Intonation | bias | mean signed cents error over voiced frames in notes |
| | stability | std of cents error within sustained notes (> 400 ms) |
| | scoop | cents error in the first 150 ms of a note vs its steady state |
| | drift | linear slope of cents error over notes > 1 s |
| | in-tune rate | share of notes with mean error within ±50 cents |
| Timing | onset delta | note onset minus reference onset, per note |
| | early/late bias | median onset delta |
| Vibrato | rate, extent | on notes > 500 ms: dominant modulation 4–8 Hz, peak-to-peak cents |
| | regularity | std of cycle period |
| Dynamics | envelope | RMS at 50 ms hop, normalised to the take's p95 |
| | phrase-end fade | drop in RMS over the last 300 ms of each phrase |
| | dynamic range | p95 minus p05 RMS in dB |
| Range | tessitura | p10–p90 of sung MIDI over all takes of this singer |
| | song range | low/high MIDI of the reference |
| Timbre | brightness | spectral centroid on voiced frames |
| | breathiness | harmonics-to-noise ratio (parselmouth) |
| | vowel shape | F1/F2 on sustained vowels (parselmouth) |
| Breath | phrasing | gaps > 250 ms vs reference gaps |

Notes are segmented from a contour by: voiced run ≥ 80 ms, split where the
median-filtered pitch jumps ≥ 80 cents and stays for ≥ 60 ms, merged across
gaps < 40 ms.

## Rules

Each rule is a pure function from features to zero or more recommendations.
Thresholds live in one table so they can be tuned. Examples of the initial
set:

| id | mode | fires when | message (Studio voice) |
|---|---|---|---|
| flat_bias | general | bias < −20 c on > 40 % of notes | You sing under the note, most on the higher ones. Aim slightly above where it feels right. |
| sharp_bias | general | bias > +20 c on > 40 % of notes | You push above the note. Relax the push on onsets. |
| scoop | general | median scoop > 60 c | You slide up into notes. Land on the centre, then add the slide on purpose. |
| unstable_sustain | general | stability > 35 c on > 30 % of long notes | Long notes wobble. Steady air; practise one sustained vowel at a time. |
| late_onsets | general | late bias > 60 ms | You are behind the beat. Breathe one beat earlier. |
| phrase_fade | general | fade > 6 dB on > 50 % of phrases | Phrases die at the end. Keep support to the last word. |
| out_of_range | general | song high > tessitura high + 2 semitones | This song sits above your comfortable range. Try it 2 semitones down. |
| vibrato_wider | match | extent > 1.6 × reference | Their vibrato is narrower than yours here. |
| vibrato_slower | match | rate < reference − 1 Hz | Their vibrato is faster; aim for a lighter, quicker shimmer. |
| held_shorter | match | duration < 0.7 × reference on > 30 % of long notes | They hold these notes longer. |
| softer_here | match | RMS 6 dB above reference on a phrase | They sing this phrase softer. |
| brighter | match | centroid > 1.3 × reference on sustained vowels | Their tone is darker; try a rounder vowel. |

Severity: `info`, `work_on`, `priority`. At most three `priority` items per
report so the singer has something to do rather than a wall of red.

## Fun layer

Scoring is per-frame cents error mapped to hit (≤ 25 c), okay (≤ 50 c), miss.
Streaks count consecutive hit notes. Phrases earn 0–3 stars. The final grade
is the in-tune rate with a timing penalty. Skins change the copy and the FX,
never the numbers (`docs/SKINS.md`).

## What we do not claim

- Tone aesthetics, emotion, diction, and "support" are not measured. We
  report proxies (stability, fade, brightness) and say so.
- Breathy or stylised singing is not wrong; match mode shows the difference,
  general mode stays quiet unless stability suffers.
- Rap and spoken sections have no pitch target; they are flagged unpitched
  and excluded from intonation.
- Reference vocals with doubles or harmonies confuse the tracker; frames with
  low confidence are excluded and the region is marked in the lane.
