# Duet

Two singers on one song. The question is which voice each pitch frame
belongs to. Three tiers, best available wins.

## Tier 1: two mics

Two input devices, or a two-channel interface split into two streams. Each
gets its own pitch tracker, lane ribbon, score, and report. Nothing to
detect. This is the recommended setup and the first to ship (P4-T1).

## Tier 2: one mic, singers alternate

Most duets alternate lines. Enrollment makes this reliable:

1. Each singer records a 15 s glide (low to high and back) and one spoken
   sentence. The browser derives a **range profile** (p05, p50, p95 of f0).
   The service derives a **speaker embedding** (ECAPA-TDNN via speechbrain)
   from the same audio.
2. Live: each voiced frame is provisionally assigned to the nearer range
   profile, with hysteresis so a singer is not flipped by one stray frame.
   Lanes draw two ribbons in the singers' colours; uncertain frames are
   drawn muted and not scored.
3. Post-take: the service slices the take into 0.5 s windows, embeds each,
   assigns by cosine similarity to the enrolled embeddings, smooths with a
   median filter, and overrides the live assignment. Confidence is the
   similarity margin.

## Tier 3: one mic, singers overlap

Best effort, clearly labelled as such.

- Multi-pitch: on windows where the embedding margin is small or the NSDF
  shows two clear peaks, run a two-source f0 estimate (harmonic summation
  over a 60–1000 Hz grid, pick the two best non-harmonically-related peaks).
- Assignment: Viterbi over frames with emission = closeness to each range
  profile and transition = pitch continuity; voices crossing is allowed but
  penalised.
- Unison or octave doubling cannot be attributed; both singers are credited
  with the frame, marked as shared.
- Harmony detection: both contours voiced and their interval stable within
  ±30 c at a 3rd, 5th, 6th, or octave for ≥ 300 ms. Harmony moments get a
  bonus and skin FX; this is the fun payoff of duet mode.

## Reference side

The original may be a duet too. Demucs returns one vocal stem. Line-level
assignment of the reference is done by the users from the lyrics view ("you
take these lines") or both sing the lead. Automatic lead/harmony separation
of the reference is a stretch goal (same multi-pitch machinery).

## Honest limits

Same mic, same register, singing at the same time, is not reliably
separable. The UI says so when confidence is low instead of guessing.
