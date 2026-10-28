# Duet

Up to two singers on one song, on the equipment people have (owner,
2026-10-27). The question is which voice each pitch frame belongs to. Two
ways in, built in W5; nothing needs voice recognition.

## Two mics

Two input devices: a laptop's mic and a headset, two USB mics, or a
two-channel interface split into two streams. Each gets its own capture,
tracker, calibrated latency (latency is stored per input/output pair),
ribbon colour and, in learning mode, its own report card and tips. Nothing
to detect.

A Bluetooth headset's mic switches the headset to call quality; the device
picker says so.

## One mic, singers take turns

Most duets alternate lines. The app decides who sings when, not by
listening:

1. The reference is split into phrases at gaps between notes of about
   0.6 s or more, or at lyric lines when synced lyrics are loaded (W6).
2. Phrases are assigned A, B, A, ... A click on a phrase in the lane
   cycles it through A, B and both. The lane shows whose turn it is.
3. In learning mode each phrase is scored for its singer. A phrase marked
   both is credited to both singers and marked shared.

In karaoke mode nothing is attributed: two people sing into one mic and
the ribbon follows whoever is loudest.

## Honest limits

Two people on one mic singing at the same time cannot be told apart; the
app scores those phrases as shared instead of guessing. If someone sings
out of turn, their notes count for the singer whose turn it is.

## Later

Enrollment (a range glide and a speaker embedding per singer), voice
recognition and two-pitch tracking for overlapping singers on one mic,
harmony detection with a bonus, and duet card highlights. See Later in
`ROADMAP.md`.
