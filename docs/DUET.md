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

Two mics in one room hear each other and the speakers. In speaker mode a
frame on B's mic that is at least 6 dB under A's simultaneous level and
within 50 cents of A's pitch is treated as A leaking in and is not scored
for B (the cost: a much quieter B singing A's exact note is dropped too).
Headphones give the cleanest result.

## As built (W5)

- Settings keep `duet`: singer B on or off, two names, two colours, B's
  input. Code is in `src/duet/`; the panel is `src/app/panels/singers.ts`.
- Singer B's mic has its own capture, tracker, noise floor and gate, and its
  latency and tuning come from B's own input and output pair. Its frames go
  on the frame bus as `singer: 1`. B's input is not reopened by itself.
- A take keeps singer A's report in `report`, so an old take, progress, stars
  and the streak are singer A's and never mix in B. B's report, the names, the
  turns and the shared stretches are in `duet`; with two mics B's frames are in
  `duetFramesB`. Each singer's card is drawn from these.
- Turns follow synced lyric lines when there are some, else the melody's
  phrases. Clicks are kept per song (`duet.turns.<hash>` in the settings
  store). In karaoke mode the strip only names whose turn it is.
- Not done: B's audio is not recorded (only A's mic is) and B's frames are not
  replayed on the lane; there is no Mic check for B (its tuning is read for
  its pair if one exists).
- Test seam: `?secondFake` (or `?secondFake=HZ`) in the page address makes
  singer B's mic a steady tone made in the page (330 Hz by default), since
  Chromium's fake capture plays one file for every device. Choosing any input
  in B's picker opens it. Without the parameter nothing changes.

## Later

Enrollment (a range glide and a speaker embedding per singer), voice
recognition and two-pitch tracking for overlapping singers on one mic,
harmony detection with a bonus, and duet card highlights. See Later in
`ROADMAP.md`.
