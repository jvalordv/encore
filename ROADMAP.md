# Roadmap

Work runs in **waves**. A wave is one session: one brief per track, one
light review, one commit (`W<n>: <summary>`), then the session stops and
the owner clears the context. Follow the resume protocol in `CLAUDE.md`
and the light pipeline in `docs/SESSIONS.md`. Finished work (Phases 0 to 2
through P2-T2) and its follow-ups are archived in `docs/HISTORY.md`.

## Goal (owner, 2026-10-27)

Karaoke for one or two people, with songs from a file or from YouTube, on
equipment most people have: a laptop's own mic and speakers, headphones, a
webcam or USB mic.

- **Karaoke mode** is the default and never judges: no scores, no misses,
  no tips. Sing, see your pitch line against the melody, have fun.
- **Learning mode** is opt-in and direct about where the singing misses:
  which notes, how far off, early or late. Tips appear only on request.
  Two styles (owner, 2026-10-28): Strict against the original's melody,
  or Open, where any octave counts and freestyle is judged on the key.
- **Token efficiency comes first.** Batch work into waves, review lightly,
  and stop after each wave so the owner can `/clear`. One thorough bug
  sweep comes after the owner has tested (W7), not inside every wave.

## Current state

- **Last done:** **W0c** (2026-11-05): `take_analysis` in the service
  reads a saved take and reports sections, verdicts and processing
  feedback for development: a decision audit, a crepe tracker check, a
  latency check, a what-if sweep of the constants, and measured findings.
  Before it **W0b** (2026-11-05): YouTube's controls hidden so
  Encore's are the only ones, held-down Play, Loop and Record, an oEmbed
  check that tells a blocked video from a missing one, the no-key Search
  line, and a full analysis trace with every take (raw frames with gate
  reasons, health at 4 Hz, an event log, environment, reference and key,
  calibration). Before it **W0** (the note guide, the mic meter and level
  gate, the bleed warning, Save take), W4 (Strict
  and Open scoring), W3 (learning mode), W2 (search and the karaoke core)
  and W1 (the reference step and the browser seams); older work in
  `docs/HISTORY.md`.
- **In progress:** none.
- **Next:** the owner's W0 and W0b tests and one protocol take run
  through W0c's command (under each wave). The findings set the next
  tuning wave. Then **W5** (needs a second person for its owner
  test). Search needs the owner's YouTube Data API key
  (README, "Run it"; pasted into the app, never into chat).
- **Blockers:** none for W5. YouTube now answers yt-dlp with "Sign in to
  confirm you're not a bot" (2026-10-28, seven tries on Big Buck Bunny), so
  Prepare for links and W2's "Find the original" fail until a newer
  yt-dlp gets through (`uv lock --upgrade-package yt-dlp`, then sync as
  below). Passing browser cookies is the owner's call, not an agent's.
  Uploads and search are not affected.
- **Policy flag:** the terms for YouTube's embedded player forbid
  downloading or caching its content, separating its audio, and fetching
  its data by other means (developer policies III.E.1.a, III.I.7,
  III.I.14). Prepare (yt-dlp, separation) does exactly that, and so does
  W2's "Find the original", which prepares a recording. Both stay opt-in
  and labelled; the README never claims compliance. Search uses the
  official Data API and is not affected.
  **Owner decision (2026-10-23): keep the prepare path, opt-in and off by
  default.** Do not re-ask.
- **Machine facts (checked 2026-10-24):** Windows 10, RTX 4070 Ti 12 GB,
  NVIDIA driver 617.42, `uv` 0.11.16, Python 3.11.15, `ffmpeg` 9.0.2
  (winget), Node 24 on PATH (yt-dlp's JavaScript runtime). `service/.venv`
  has the CPU deps, yt-dlp[default], the `separation` extra (torch and
  torchaudio 2.11.0+cu128, demucs 4.1.0) and the `pitch` extra
  (torchcrepe). In `service/` use
  `uv sync --inexact --extra separation --extra pitch`; a plain `uv sync`
  uninstalls torch. C: had 152 GB free at the W1 commit; keep 15 GB free. uv's cache still holds a cu130 torch
  wheel (about 2.7 GiB); `uv cache clean torch torchaudio` frees it once
  nothing locks the files. The service is not running by default; the
  Vite dev server on :5173 is the owner's.
- **e2e on this machine:** the pinned headless shell
  (`chromium_headless_shell-1194`) is in `%LOCALAPPDATA%\ms-playwright`.
  If `npm run e2e` reports a missing executable, kill stuck
  `playwright install` node processes, delete `ms-playwright\__dirlock`
  and any browser folder without `INSTALLATION_COMPLETE`, then reinstall.
- **Repo hygiene:** repo-local git identity is `Claude
  <noreply@anthropic.com>`; use plain `git commit`. `.claude/worktrees/`
  is in `.git/info/exclude`. The owner said routine build, check, commit
  and push need no permission. Allow rules the owner may add to
  `.claude/settings.json` (an edit by Claude was blocked as
  self-modification): `Bash(git worktree:*)`, `Bash(git merge:*)`,
  `Bash(git cherry-pick:*)`, `Bash(git branch:*)`, `Bash(git rm:*)`,
  `Bash(git mv:*)`, `Bash(npx playwright test:*)`, `Bash(uv lock:*)`,
  `Bash(uv add:*)`, `Bash(ffmpeg:*)`, `Bash(ffprobe:*)`.
- **Owner tests, when convenient** (`git pull`, `npm run dev`):
  - Speakers: pick the webcam mic, choose Speakers under the mic picker;
    expect "Speaker mode: echo cancellation on, NS/AGC off". Calibrate
    twice with speakers on and report both status lines. Play the song
    aloud and sing a held vowel: does the ribbon follow you or the song?
    If it lags by a fixed amount, nudge the latency field and report the
    value. If bleed appears only with a specific Output, try System
    default.
  - YouTube: paste a link, press Play, sing. Report whether the ribbon
    tracks you, whether the video's sound bleeds into the mic in Speakers
    mode, whether a pre-roll ad shows and what the app says, and the
    "YouTube video offset" that makes takes line up.
  - Prepare: start the service (`cd service && uv run python -m
    encore_service`), load a link, press "Prepare for scoring" while it
    plays. Report whether the switch is audible, whether the muted video
    stays in step (also after a click on YouTube's timeline and a long
    buffer), and whether Speakers mode keeps the song out of the mic.
  - Karaoke core (W2b; replaces W1's curl test): start the service, drop
    an mp3 with singing. It plays at once while the Karaoke track group
    shows the upload, separation and melody. When the stems arrive Karaoke
    is selected with no restart (try it while playing). Switch Original,
    Karaoke and the vocal guide while playing: no gap, similar loudness;
    the guide level survives a reload. Report whether the note bars line
    up with the vocal you hear in Original and fit the lane's rows. Record
    and replay a take over Karaoke. A karaoke mp3 should say "Melody
    skipped:" and draw no bars. With the service stopped, a dropped file
    plays and one line says what is missing; start the service, click back
    into the window, and it uploads by itself.
  - Search (W2a): with no key, Search opens YouTube's own results in a new
    tab. Make a key (README, "Run it"), save it in the panel, search a song
    you know: report any wrong Karaoke or Original badge (Sing King,
    KaraFun, official videos). Pick a result, then use the song panel's
    Search button and Close. Try Find the original on a karaoke card. A
    wrong key should say YouTube does not accept it. Open the mic with no
    song: the readout and lane work under the search. Check the three
    skins and a narrow window.
  - Learning mode (W3): with the service up, drop a sung mp3 and wait for
    the melody. Sing one take in Karaoke mode: no colours, no card. Switch
    the header to Learning and sing another: the lane colours your line,
    and the card opens when the take stops. Try Jump and Replay on a worst
    phrase, then Tips. Report any tip that is plainly wrong for how you
    sang. Pick a Karaoke-badged search result in Learning mode: the "on
    your own" notice and Find the original should show. Check the header in
    all three skins at a narrow width (it now wraps).
  - Strict and Open (W4): restart the service first (songs prepared
    before W4 get their key when it starts). Drop a sung mp3, switch to
    Learning, and sing a Strict take with an ad-lib in one phrase; mark that
    phrase free (Shift+click it on the lane, or Mark free on the card) and
    check the card changes. Switch the selector to Open and sing one take
    with a line an octave off, an ad-lib in key and a plainly wrong note:
    report the melody share, the freestyle-in-key share, and any note
    called off key that was in key (or the reverse). Say whether the red
    flicker on scoops in Open is distracting. Drop a karaoke mp3 in Learning:
    the notice offers Switch to Open, and an Open take gets a card.

## Waves

Each wave lists what to build, the files it owns, and when it is done.
Tracks inside a wave share no files and may run in parallel.

- [x] **W0: Karaoke guide and mic diagnostics** (owner test, 2026-11-05;
  browser only). On a karaoke YouTube video in speaker mode the ribbon
  "fluctuates a lot, and it's unclear if the mic is getting my voice,
  feedback from the speakers, if I'm on or off". Claude Desktop's browser
  pane blocks the mic; the owner tests in a normal browser (say so in the
  README, "Run it").
  - **Guide (owner decision, 2026-11-05):** karaoke mode gets an opt-in
    guide, off by default, for minimal feedback "if they want it": a steady
    readout of the nearest note and how many cents off, against the song's
    key when a `KeyMap` exists (W4) and chromatic otherwise, smoothed so it
    does not jump. No colours, scores, misses or tips, and nothing stored
    with the take. Update the "Two modes" decision in
    `docs/ARCHITECTURE.md` and CLAUDE.md's purpose 1 to match: karaoke mode
    judges nothing unless the singer turns the guide on.
  - **Mic diagnostics, both modes:** a level meter against the measured
    noise floor with one plain state (hearing you, too quiet, nothing); a
    steadier ribbon (frames under the level and clarity gates are not
    drawn, instead of drawing jitter). In speaker mode, warn when the mic's
    pitch follows the song's melody rather than the singer, where the
    browser has the melody (uploads, prepared songs); for an unprepared
    YouTube video it cannot compare, and says so. This also closes W3's
    follow-up on gating scored frames by level in speaker mode.
  - **Save take** (owner confirmed, 2026-11-05): download a take's
    audio (WAV) and its frames and mic settings (JSON), so the owner can
    hand a take to a session for analysis (how much of the video reached
    the mic).
  - Done when the checks and e2e are green. Owner test: the same karaoke
    video in speaker mode with the guide on, and one take saved.
  - Built (2026-11-05): `src/analysis/{mic-level,note-guide,bleed}.ts`,
    `src/app/session/mic-health.ts`, `src/app/panels/{mic-health,note-guide}.ts`,
    `src/app/take-export.ts`. Floor: 10th percentile of 5 s, falls at once,
    rises at most 1.5 dB/s, capped at -35 dBFS. Draw and speaker-mode score
    gate: voiced, clear, 8 dB over the floor. State on the 1.5 s peak:
    hearing at 12 dB over (drops below 9), nothing under 4 (leaves above 6).
    Guide: 0.3 s median, holds a note until 65 c away, 0.5 s hold, "in tune"
    within 5 c. Bleed compares with the reference contour (not note
    medians): 5 s window, 150 frames, suspected at 60 % within 30 c and a
    median under 15 c; arms for the embed clock, the Original mix or a vocal
    guide above 0. Takes carry an optional `mic` field. The old
    hit-coloured tuner readout now shows in learning mode only. Review fix:
    mic health resets when the mic or monitor mode switches while open.
  - Follow-up: the bleed thresholds are untested on a human singer; tune
    them from the owner's saved take.
  - Follow-up: the floor mark sits 3 dB high to compare RMS with the
    peak-based meter bar; an RMS bar would remove that offset.
  - Follow-up: the state line reads "Nothing from the mic" in any pause over
    1.5 s; consider a softer word between phrases.
  - Follow-up: no e2e covers the speaker-mode bleed warning or the
    cannot-check line, or the learning-mode tuner readout still showing.
  - Follow-up: in the solo-loop e2e, "frame times strictly increase" failed
    once by 0.7 ms in an isolated rerun; the worker moved the clock read
    ahead of the level work and the full suite passed. Watch for it.
  - Owner test (W0): in a normal browser (not Claude Desktop's pane), the
    same karaoke YouTube video in speaker mode. The meter's state line
    should say Hearing you only while you sing; the ribbon should gap
    instead of jitter when you stop. Turn on Note guide (karaoke mode):
    report whether the readout is steady enough. On a prepared or uploaded
    sung song with Original playing aloud, stay silent for a few seconds:
    does the bleed warning show? Record one take and press Save WAV and Save
    JSON; hand both files to a session to see how much of the song reached
    the mic.

- [x] **W0b: Links that will not embed, and one set of controls** (owner
  test, 2026-11-05; browser only). The owner has no search key, so Search
  opens YouTube's own results in a new tab and the pasted link is not
  filtered for embedding (`videoEmbeddable` in `src/search/youtube.ts`
  applies only with a key). One such link failed with error 101/150 ("would
  not play that video here", `describeYouTubeError` in
  `src/audio/youtube-transport.ts`), which YouTube also sends for an id that
  does not exist.
  - **Tell the two apart before loading:** YouTube's oEmbed endpoint
    answers 401 when the owner blocks embedding and 404 when the video does
    not exist. Check it from the browser if CORS allows, else from the
    service, else skip the check. Say which it is, and for a blocked video
    say what helps: another upload of the song (karaoke channels usually
    allow embedding), or a search key so Search shows only videos that play
    here (README, "Run it").
  - **No-key Search:** say beside the button that YouTube's own results
    include videos that will not play here.
  - **Controls (owner decision, 2026-11-05): Encore's buttons only.** With
    a video loaded, Encore's Play/Pause and Stop sat beside YouTube's own
    controls and the owner could not tell what Encore's do. Hide YouTube's
    controls (`controls: 0` in the player vars), so Encore's buttons and the
    lane are the only controls. A click on the video still pauses, and the
    next click resumes, "because that's what people expect", in step with
    Encore's buttons. If YouTube does not do that itself with
    `controls: 0`, use a click layer over the video that calls the session's
    play toggle. Take the layer away while an ad plays, so its skip button
    still works.
  - **Pressed state (owner, 2026-11-05):** the transport buttons show what
    is on, like hardware controls. Play stays visibly held down (a filled
    background, `aria-pressed`) while playing, and so do Loop and Record
    while they are on. One look should tell whether the song is playing.
    This applies in all three skins and uses their tokens.
  - **Everything for analysis is recorded with each take (owner,
    2026-11-05).** W0's saved take already holds the mic settings at the
    start (`captureMicSettings` in `src/app/take-export.ts`) and the frames.
    It loses what matters for tuning: in speaker mode a gated frame is
    stored with f0=0, so its raw pitch is gone. Record:
    - each frame's raw f0, clarity and rms, plus its gate result and the
      reason it failed;
    - the noise floor, mic state and bleed state over time (sampled about
      4 times a second);
    - a timed log of what happened during the take: play, pause, seek, loop,
      mix or guide-level changes, mode and scoring changes, embed ads and
      buffering, mic or monitor switches;
    - the reference contour and `KeyMap` for the take's span, when the song
      has them;
    - what the browser actually granted (`MediaStreamTrack.getSettings()`),
      the AudioContext sample rate and base and output latency, the user
      agent, the skin, the settings that affect analysis, and the app
      version (build-time commit hash);
    - the calibration trials behind `latencyS`.
    Keep it on the take record (optional fields, so older takes still load)
    and in the JSON export (bump `TAKE_EXPORT_VERSION`). Nothing from it
    renders in karaoke mode. Test the export shape and the event log in
    unit tests.
  - Done when the checks and e2e are green (the fake YouTube in
    `e2e/fake-youtube.ts` answers the oEmbed check). Owner test: paste the
    link that failed and one that plays. Click the video to pause and
    resume and check Encore's Play button follows it. Press each control
    and check its pressed look in each skin.
  - Built (2026-11-05), two tracks in parallel (controls in the main
    checkout, metadata in a worktree), one review, one fresh fixer. oEmbed
    allows CORS from localhost, so the browser checks it directly
    (`src/audio/youtube-oembed.ts`, 4 s timeout, any failure means
    "unknown" and the load goes on); it runs alongside the API load. No
    click layer: YouTube's rules forbid covering the embed, and the
    transport already follows YouTube's own pause. The trace lives in
    `src/app/take-trace.ts`. Stored frames are `TakeFrame` (the old f0,
    clarity and rms unchanged, plus optional `rawF0` and `gate`), so
    scoring and replay behave as before. The event log comes from diffing
    the store, holds at most 2000 events, and ends with a `truncated`
    marker when full. A loop wrap is not logged as a seek. The export is
    version 2, and the build stamps `__APP_VERSION__` from git.
  - Follow-up: confirm that a click on the video still pauses with
    `controls: 0`. If it does not, the owner decides whether a click
    layer is acceptable.
  - Follow-up: the calibration trials are kept in memory from the last
    successful calibration only, and are dropped when the latency is
    edited by hand or the page reloads.
  - Follow-up: the reference and key slices are unit-tested only; no
    recorded-take test covers them on the fake harness. Loop and Record's
    pressed look is checked by CSS only.

- [x] **W0c: Analyse a saved take** (owner, 2026-11-05: "we absolutely
  need to be able to analyze saved sections"; service only, Python). A
  command that reads a take saved by W0 and W0b (the JSON, optionally the
  WAV) and prints a short report. A session can then run it and read a
  page of numbers instead of a large JSON file.
  - `uv run python -m encore_service.take_analysis <take.json> [--wav
    <take.wav>] [--section 0-10 --section 30-40 ...] [--window 5]
    [--json <out.json>]`. Pydantic models read the export, versions 1 and
    2, and a version-1 file says which numbers it cannot give.
  - **Sections:** the given ranges, fixed windows, and the spans between
    events (play, pause, seek, mix, monitor, input). Each section reports:
    - frames, voiced share, gate pass share and the failure reasons;
    - level (median and p90 dBFS) against the floor from the health
      samples;
    - against the reference, where the trace has it: the share within
      30 c octave-exact, the share within 50 c any octave, the median error
      and the best lag;
    - the share of time the app's bleed state said suspected;
    - one verdict: silence, singer, likely bleed, or unclear. The verdict
      follows written rules: bleed tracks the melody tightly at a steady
      lag, a singer is looser and drifts.
  - **The rest of the report:** the environment (what the browser granted:
    echo cancellation, noise suppression, gain control; the sample rate;
    latencies; calibration confidence; monitor, mix, output, app version)
    and a condensed event timeline. With the WAV: peak, clipped samples,
    DC offset, and a check that the length and sample rate match the JSON.
    A headline sums it up in one or two lines, such as "In the sections
    you marked silent, 62 % of frames followed the melody within 30 c at
    +40 ms: the speakers reached the mic."
  - **Processing feedback (owner, 2026-11-05: "so you can better improve
    the program and its processing capability; it is direct raw
    feedback").** The report serves development, not the singer. It covers:
    - a decision audit: frames the gate dropped that held clear pitch, and
      frames it passed in silent or bleed sections;
    - a tracker check of the browser frames against crepe on the WAV
      (`--crepe`, when the pitch extra is installed): voicing agreement,
      octave errors, cents difference, jitter on held notes;
    - a latency check: the best lag against `latencyS` and the
      calibration;
    - a what-if sweep of the gate and bleed constants over the raw frames,
      naming the settings that best separate the marked-silent sections
      from the singing ones;
    - a list of measured findings, each naming the constant or step and the
      number behind it.
  - The app's constants (`src/analysis/bleed.ts`, `src/analysis/mic-level.ts`)
    are mirrored in Python, and a pytest reads the TS files and fails when
    they drift.
  - pytest uses synthetic takes with known answers: a bleed section, a
    singer section, silence, a version-1 file. ruff stays clean.
  - Done when the service checks and `npm run check` are green. Owner test:
    record the protocol take (10 s silent with the song aloud, 20 s
    singing, 10 s silent), save both files, and run the command with
    `--section 0-10 --section 30-40`.
  - Built (2026-11-05): package `service/encore_service/take_analysis/`
    (22 small modules; the `processing/` subpackage holds the audit, sweep,
    latency, tracker and findings). Tests are `service/tests/take_factory.py`
    and `test_take_{analysis,processing,analysis_constants}.py`.
    `--section A-B[:silent|:sing]` is in take time (seconds from the first
    frame), and each section prints its song time too. The `:silent` and
    `:sing` labels feed the sweep. Frame, health and reference times share
    song time, with the latency already taken off. Event `songT` is the raw
    position, so span edges subtract `latencyS`. A WAV sample maps to song
    time as `startedAtSongS + i/rate - latencyS`. A positive bleed lag
    means the latency is under-corrected, so the implied latency is
    `latencyS + lag`. The tracker check (`--crepe`, CUDA here) compares
    only the frames before the first pause, seek or loop. The bleed sweep
    never recommends a rule that loses detection in the silent sections.
    A 5-minute take analyses in about 1.2 s. Review fixes: the reference
    array is built once, the bleed pick, the tracker cut at breaks, and
    the span latency.
  - Owner run (after W0b's test):
    `cd service && uv run python -m encore_service.take_analysis
    <take.json> --wav <take.wav> --section 0-10:silent --section
    10-30:sing --section 30-40:silent --crepe`, then hand the report to a
    session.
  - Follow-up: sections and spans assume song time runs straight through.
    A take with seeks needs a map from wall time to song time, built from
    the event log.
  - Follow-up: the bleed sweep can only count false alarms on singing
    sections. A silent section has no ground truth beyond the owner's
    label.
  - Follow-up: `--crepe` has run only on synthetic sines, not on a real
    take.

- [x] **W1: Seams and the reference melody.** Two tracks, one commit.
  - **W1a, service: reference melody** (was P2-T3). New `reference` step
    after separation: `torchcrepe` (full model) on `vocals.flac` at 10 ms
    hop, Viterbi decoding, a confidence gate, a median filter for octave
    errors. Segment notes by the rule in `docs/COACHING.md`. Save
    `reference.json` (the `Reference` schema in `docs/ARCHITECTURE.md`,
    Shared schemas) and serve it at `GET /songs/{id}/reference`.
    - No singing in the vocal stem (a karaoke upload): raise
      `StepSkipped` with a reason the browser shows. Decide by the share
      of 1 s windows where the vocal stem (divided by `stem_gain`) is
      above about -40 dBFS, not by a global ratio: measured 3.5% for a
      film with no singing against 81% for a sung song. Synthetic tests.
    - Declare a `pitch` extra (torchcrepe; it pulls resampy and numba).
      torchcrepe 0.0.24 works with torch 2.11 and bundles its weights,
      but `torchcrepe.load.audio` needs torchcodec (absent): read with
      soundfile and pass tensors to `torchcrepe.predict`. Stems are
      44.1 kHz; contour times come from the stem's own rate.
    - Move the model registry out of `separation.py` into its own module,
      one prefix per model family in `/gpu`'s `loaded_models`. Declare
      `julius` in the `separation` extra.
    - The `lyrics` step stays a stub but skips with "Lyrics come from a
      lookup in the app" instead of "Not built yet (ROADMAP P2-T4)";
      update the tests that pin the old text.
    - Done when the service checks are green and a real run on a sung
      song gives notes that follow the vocal (spot-check a few), while a
      karaoke upload is skipped with its reason.
  - **W1b, browser: seams** (refactor, no behaviour change). Purpose:
    later waves each touch their own small files, so a worker reads
    hundreds of lines instead of thousands.
    - Split `src/app/session.ts` (1,943 lines, no unit tests) into
      controllers under `src/app/session/`: songs and transports (file,
      link, embed lifecycle, ads), prepare (attempts, service probe,
      switch to prepared), input (devices, monitor mode, output,
      calibration, latency), takes (record, replay, delete). A small
      `Session` facade keeps today's public API, so `ui.ts` and the e2e
      suite do not change. Each controller gets the store and its parts
      injected. Move guards and comments intact; this is a move, not a
      rewrite.
    - Frame bus: the tracker publishes `{ singer, frame }` (singer 0 for
      now) to subscribers: the lane and the recorder today, scoring in
      W3, a second mic in W5.
    - State: `mode: 'karaoke' | 'learning'` in settings (default
      karaoke, no UI yet) and `singers` in the state (one entry, built
      from today's input).
    - Pitch lane (937 lines): pure geometry helpers in their own module,
      and drawing split into layers, one module each: grid, reference
      notes, one ribbon per singer, overlay (notices now, hit colours in
      W3). `PitchLane` composes them.
    - New UI goes in `src/app/panels/<name>.ts`, each exporting a mount
      function that returns a dispose; `ui.ts` only composes. Do not move
      existing UI out of `ui.ts` unless a split above needs it.
    - A fake-parts harness (transport, mic, recorder, clock) and unit
      tests for each controller's main paths: load, play/pause/seek,
      record and replay, the prepare switch, a calibration result.
    - Done when `npm run check` and `npm run e2e` are green with the
      existing tests unchanged apart from imports, no file in
      `src/app/session/` is over about 500 lines, and
      `docs/ARCHITECTURE.md` (Browser) names the controllers and the
      frame bus.
  - Done 2026-10-28. Checks: 1,159 unit tests, 51 e2e, 824 service tests.
    `src/app/session.ts` is a 285-line facade; the largest controller is
    381 lines. The lane is `pitch-lane.ts` (310) over `lane-*.ts` layers.
    Real run on YouTube blocked (bot check, see Blockers), so the reference
    step ran on the GPU on a synthetic sung line instead: 8 of 8 known
    notes within 50 cents and 60 ms, presence 1.0; the backing alone gave
    0.0 and skipped. 10 s of audio separated and tracked in 8.5 s cold;
    both models resident cost about 0.9 GB of VRAM. A pure tone is not a
    vocal to demucs (it lands in `no_vocals`), so test mixes need a
    formant voice. Frames under -50 dBFS get no pitch, which removed
    notes tracked from separation leftovers between words.
  - Follow-up: the spot-check on a real sung song is the owner's (list
    above); the 15% presence cut-off and the 0.3 confidence gate are
    untuned on real vocals.
  - Follow-up: the lyrics step still waits on separation ("Needs
    separation") when separation fails; make it independent.
  - Follow-up: `_is_done` in `pipeline.py` does not check that
    `reference.json` exists.
  - Follow-up: `vibrato` on notes is not measured (Later, deeper
    analysis).
  - Follow-up: `loadLink` has no unit test beyond its guards (it needs a
    fake YouTube API); e2e covers it.
  - Follow-up: the frame bus's unsubscribe functions are never called;
    harmless while `tracker.disconnect()` stops frames, but W5's second
    mic should unsubscribe on close.
  - For W3: `settings.mode` is read by nothing yet, and the lane's overlay
    layer has the hook for hit colours.
- [x] **W2: Search and karaoke core.** Two tracks, one commit.
  - **W2a, browser: YouTube search as the first screen.** Owns
    `src/search/` and the search panel. Owner decision (2026-10-27): the
    official API with the owner's own key; no keyless backend for now.
    - Search from the browser through the YouTube Data API v3, no
      service: `search.list` (`type=video`, `videoEmbeddable=true`, 12
      results, 100 quota units), then `videos.list` for durations (1
      unit). The key is a field in the search panel, kept through the
      storage adapter. The free quota (10,000 units a day) is about 100
      searches; a quota or key error says so in plain words.
    - Search goes through a provider interface (query in, results and
      errors out). The only provider now calls Google directly with the
      key from settings; a public app would add one that calls a server
      holding the key (Later, Public app). Which provider runs is one
      setting; nothing else in the app knows which is in use.
    - Without a key, or once the quota is spent, the box opens YouTube's
      own search in a new tab, and a pasted link works as today.
    - Results in a grid: thumbnail, title, channel, duration, and a
      Karaoke or Original badge from a pure, tested classifier (title and
      channel words such as karaoke, instrumental, backing track, sing
      along; known karaoke channels such as Sing King and KaraFun).
    - A chip chooses Karaoke versions or Originals, starting from the
      mode in settings: karaoke mode adds "karaoke" to the query, learning
      mode asks for originals. A pick loads like a pasted link.
    - The search is what the app shows when no song is loaded.
    - "Find the original": from a karaoke pick, search the title with the
      karaoke words removed, as Originals, and let the user pick one. W3
      calls it from learning mode.
    - README: how to create the key and restrict it (YouTube Data API v3
      only; websites `http://localhost:5173/*`).
    - Done when the checks and e2e are green, with the API answered by a
      Playwright route from fixture JSON.
  - **W2b, browser: karaoke core** (was P2-T5 without lyrics). Owns
    `src/service/`, the song panel, the lane's reference layer.
    - Client: keep polling status through separation and reference
      (P2-T1d stops at fetch). Fetch stems from
      `GET /songs/{id}/stems/{vocals|no_vocals}` (24-bit FLAC, 44.1 kHz);
      the `X-Stem-Gain` header is the factor the original must be
      multiplied by to sit at the stems' level. Fetch
      `GET /songs/{id}/reference`. Mirror only `Reference`, `Contour` and
      `Note` in `types.ts`. Hide the `lyrics` step in the progress line.
    - A dropped file uploads to the service when it is reachable
      (`POST /songs`) with progress in the song panel. With the service
      down everything works as today, plus one line saying what is missing.
    - Mix control in the song panel: Original, Karaoke (instrumental), and
      Karaoke with a vocal guide at a slider level. Karaoke is the default
      once stems arrive. Linked songs get it once prepared.
    - The lane's reference layer draws the target notes and marks
      unpitched regions. A skipped reference shows its reason and the lane
      runs without targets. Karaoke mode shows no scores, colours or
      misses.
    - Done when the checks and e2e are green (the fake service serves stems
      and a reference). Owner test: drop an mp3, wait for preparation, sing
      to the instrumental with the melody shown.
  - Done 2026-10-28. Checks: 1,334 unit tests, 71 e2e, 824 service tests
    (service untouched). The tracks ran one after the other, since both
    touch settings, `ui.ts` and the e2e fakes. W2b: `src/app/session/`
    `stems.ts` and `mix.ts`, pure `mix.ts`, `karaoke.ts` and
    `reference.ts` in `src/app/`, the karaoke panel, client calls in
    `src/service/` (`upload.ts`, `wire.ts`). Original plays at the stem
    gain, stems at unity; takes duck the whole mix. W2a: `src/search/`,
    a `SearchController`, the search panel above a 160 px lane. One review
    item fixed: a failure after the stems arrived hid the mix.
    `solo-loop.spec.ts` now stubs the service (a dropped file probes it),
    and the fake's linked songs skip the steps after fetch.
  - Follow-up: not tried on the real API: the Originals query's
    `-karaoke` operator, and whether a key restricted to
    `http://localhost:5173/*` accepts the page's referrer.
  - Follow-up: upload progress was not seen to fire under Playwright's
    route; check it against the real service with a large file.
  - Follow-up: the lane fits its rows to the contour's 2nd to 98th
    percentile, not the reference's `range`; check bars are not clipped.
  - Follow-up: a stem download that fails after separation says "add it
    again" and does not re-upload by itself.
  - Follow-up: the quota-spent flag lives in memory, so after a reload the
    first search spends a request to learn it again. Changing the chip does
    not re-run the search (quota); a blocked new tab cannot be detected
    with `noopener`.
  - Follow-up: the guide slider saves settings on every input event.
  - Follow-up: `src/audio/player.ts` (561) and `src/app/ui.ts` (619) are
    over the 500-line guide; split when a wave next touches them.
  - For W3: call `session.findOriginal({title, channel})` for a karaoke
    track; `TrackInfo` has no channel yet, so carry it from the picked
    result. The mode toggle should call
    `session.setSearchFilter(filterForMode(mode))`. Panels have no DOM unit
    tests (vitest runs in node); their view models are tested.
- [x] **W3: Learning mode** (was P2-T6, P2-T7, P3-T2, P3-T3; browser
  only). Owns `src/analysis/score.ts`, `src/coach/`, the mode and report
  panels, the lane's overlay layer.
  - A Karaoke / Learning toggle in the header, persisted, Karaoke by
    default.
  - `score.ts`, pure, tested on synthetic contours: per-frame cents error
    against the reference at the calibrated latency, with an
    octave-invariant option; hit within 25 cents, okay within 50, else
    miss. Per note: mean and spread of the error, scoop, onset delta, held
    length against the reference. Per take: in-tune rate (notes within
    ±50 cents), timing bias, worst phrases. It subscribes to the frame
    bus.
  - Learning mode only: the lane colours frames hit, okay or miss (skin
    tokens), and the end of a take shows a report card: in-tune share,
    which notes were off and which way (flat or sharp, in cents), early
    or late (in ms), and the three worst phrases with jump-to and replay.
    Stored with the take.
  - Tips on request: a Tips button on the card runs `src/coach/tips.ts`,
    pure rules with all thresholds in one table, tested on synthetic
    inputs: `flat_bias`, `sharp_bias`, `scoop`, `unstable_sustain`,
    `late_onsets`, `early_onsets`, `out_of_range` (advice only),
    `held_shorter` (`docs/COACHING.md`). At most three tips, each with its
    evidence and a jump-to. Plain, direct wording; per-skin copy is Later.
  - Karaoke tracks in learning mode: when the song is a karaoke track
    (W2a's badge, or a reference skipped for having no vocal), say plainly
    that the singer is on their own and why, before they sing: "Learning
    mode compares your singing with the original singer's. This is a
    karaoke track, so there is no singer in it to compare against: you're
    on your own for this one." Offer "Find the original" (W2a). An
    original, once prepared, is sung over its own separated instrumental;
    nothing is aligned to the karaoke video.
  - Done when the checks are green and tests pin the scoring math and
    every rule. Owner test: one take in each mode.
  - Done 2026-10-28. Checks: 1,449 unit tests, 74 e2e, 824 service tests
    (service untouched). One worker, one reviewer, one fix. New:
    `src/analysis/` `score.ts` (457), `take-notes.ts` (the service's
    note rule ported) and `phrases.ts`; `src/coach/tips.ts`; `src/app/`
    `learning.ts` and `report.ts` (view models); `session/scoring.ts` (the
    lane's bus subscriber, now grading frames in learning mode only); panels
    `mode.ts`, `report.ts`, and `takes.ts` (moved out of `ui.ts`, now 558).
    The grade colours were already skin tokens. `playTake(id, fromS)`
    replays from a 1 s lead-in. Defined here: a note is sung with at least
    5 scored frames, in-tune rate is over sung notes, a phrase is ranked with
    at least 200 ms scored and a mean error over 25 c. Review fix: a step
    scoop of 80 c or more split the sung note and read as a late entry; a
    piece under 150 ms at a reference onset now merges into the next.
  - Follow-up: `docs/ARCHITECTURE.md` (Mic constraints) says speaker mode
    gates scored frames by mic level above the noise floor; W3 does not,
    so bleed can be graded as singing in speaker mode.
  - Follow-up: a replayed take is drawn without hit colours; only live
    frames are graded.
  - Follow-up: a pasted link to a karaoke video has no badge, so the
    karaoke-track notice shows only once the service skips the melody
    ("No singing found").
  - Follow-up: sung notes match reference notes by largest overlap (at
    least 50 ms), so a legato run on one pitch gets an onset delta only on
    its best-overlapping note.
  - Follow-up: the lane's grade colours and the card's DOM are not checked
    in a browser beyond visibility and Tips (e2e `learning.spec.ts`).
  - Follow-up: the card and tips use Studio wording (`TIP_MESSAGES`);
    per-skin copy is Later.
  - Follow-up: `src/app/ui.ts` (558) and `src/audio/player.ts` (561) are
    still over the 500-line guide.
  - For W4: the phrase splitter already exists (`src/analysis/phrases.ts`,
    0.6 s gap); reuse it, do not build another. Thresholds live in the
    tables in `score.ts` and `src/coach/tips.ts`; the karaoke-track notice
    is in `src/app/learning.ts`.
- [x] **W4: Strict and Open scoring** (owner asked, 2026-10-28). Learning
  mode gets two styles. **Strict** scores against the original's melody,
  as W3 builds it. **Open** is lenient the way rhythm games' vocals are
  (any octave counts, wider windows) and adds freestyle: a note off the
  melody that fits the song's key counts as freestyle, not as a miss.
  Both measure; neither guesses. Windows, the key-fit rule and the new tip
  are in `docs/COACHING.md`, "Scoring styles". Karaoke mode is unchanged
  and shows none of it. Two tracks, one commit.
  - **W4a, service: the song's key.** Owns `encore_service/key.py`, its
    step and its route.
    - A new `key` step after separation, run on `no_vocals` for every
      song, with or without singing. Chroma at a tuning offset estimated
      from the instrumental, matched against the 24 major and minor key
      profiles over windows of about 8 s, smoothed so a key change is
      found but the key does not flicker. Each segment has a confidence
      (the best match against the runner-up); under the gate it is "key
      unclear". A relative major and minor share their notes, so mixing
      them up does not change in-key scoring.
    - Save `key.json` as `KeyMap { tuning_cents, segments: [{start_s,
      end_s, tonic, mode, confidence}] }` (add it to Shared schemas in
      `docs/ARCHITECTURE.md`), serve `GET /songs/{id}/key` like the
      reference, and add `key` to the `SongStatus` steps. numpy only, no
      new dependency.
    - Tests on synthetic audio: a I-IV-V-I progression in D major gives
      D major (or B minor), a change from C to D halfway is found within
      one window, a +30 cent tuning offset is measured, noise gives "key
      unclear".
  - **W4b, browser: the two styles.** Owns `src/analysis/key-fit.ts`,
    the style table in `score.ts`, the `off_key` rule in
    `src/coach/tips.ts`, the style selector, and free phrases in the
    lane's overlay layer. Mirror `KeyMap` in `src/service/types.ts`.
    - `settings.scoring: 'strict' | 'open'`, Strict by default so W3's
      behaviour does not change. The selector sits beside the mode toggle
      and shows only in learning mode.
    - Phrases: split the reference into phrases (a gap between notes of
      about 0.6 s or more; a pure, tested function, moved here from W5,
      which reuses it). A phrase can be marked free from the lane (not by
      a plain click, which W5 takes for turns) or from the report card. A
      free phrase in Strict is judged as in Open.
    - `key-fit.ts`, pure and tested: a sung note against the key at its
      time gives in key or off key, and the cents to the nearest scale
      tone. Where the key is unclear, a note is judged only on
      steadiness, and the card says why.
    - Open: notes match the melody at any octave with the wider windows.
      A note that matches no melody note, or comes where there is none
      (gaps, a skipped reference, free phrases), is freestyle: in key or
      off key. The card shows the share on the melody, the share of
      freestyle in key, and each off-key note with how far off and a
      jump-to.
    - Karaoke tracks: in Open the whole song is freestyle against the
      key, so learning mode gives real feedback on a karaoke track. W3's
      "on your own" message adds "Switch to Open to be scored on the
      song's key instead", beside "Find the original". Strict on the
      karaoke video itself stays Later.
    - Tips: `off_key` runs in Open and on free phrases; `held_shorter`
      runs in Strict only; `flat_bias` and `sharp_bias` use melody notes
      only.
    - Done when the checks and e2e are green, with tests pinning the key
      estimation, the key fit, both styles' windows and the new rule.
      Owner test: one song in each style with an ad-lib in one phrase,
      and a karaoke track in Open.
  - Done 2026-10-28. Checks: 1,590 unit tests, 77 e2e, 866 service
    tests. Two workers in parallel (service and browser, one checkout, no
    shared files), one reviewer, three fixes. W4a: `key.py` (466): STFT
    chroma 60 Hz to 5 kHz after a tuning offset from interpolated peaks,
    8 s windows every 2 s against the Krumhansl-Kessler profiles, Viterbi
    with a 0.75 switch penalty, confidence = margin over the best key that
    is neither the path key nor its relative, / 0.1, gated at 0.3. A
    5-minute stem takes about 0.6 s. W4b: `src/analysis/` `key-fit.ts`,
    `open-score.ts` (both styles' take scoring and live grades) and
    `free-phrases.ts`; `src/render/lane-free.ts`; `src/app/` `free-store.ts`
    and `key-state.ts`; `SCORING_STYLES` in `score.ts`; a `free` grade
    colour in all three skins. Defined here: the melody share is over
    on-melody plus judged plus unclear freestyle notes (passing tones
    left out); free phrases are `[start, end]` spans per song hash in the
    settings store; marking one from the card re-scores that take with its
    own style. A failed key step does not end the browser's wait for the
    melody. Review fixes: a restart during the key step left the later
    steps queued for good (the service now fails them too, "Add the song
    again"), a tuning of 49.996 c rounded to 50 and failed the schema, and
    a regex typo in the Open notice.
  - Follow-up: the key gate (0.3) and margin scale (0.1) are calibrated on
    synthetic chord loops only; no prepared song was cached on this machine
    to check real instrumentals.
  - Follow-up: the card never names the key (for example "D major"); the
    owner cannot see a wrong key estimate except through odd off-key calls.
  - Follow-up: Open's live grade marks frames more than 50 c from the
    scale red, so a scoop through an outside pitch flickers red.
  - Follow-up: a karaoke YouTube video gets a key only once prepared
    (blocked by the bot check); unprepared, Open judges its freestyle on
    steadiness only.
  - Follow-up: `src/analysis/score.ts` (521) joins `ui.ts` (558) and
    `player.ts` (561) over the 500-line guide; the lane's Shift+click glue
    is covered only by e2e.
  - For W5: phrases come from `splitPhrases` over the reference notes; a
    plain click on the lane is still free (`PitchLane.setPhraseClick` takes
    Shift+click only), and free spans are per song, not per singer.
- [ ] **W5: Two singers** (`docs/DUET.md`). Owns `src/duet/`, the
  singers panel, the lane's ribbon layer.
  - Settings: today's input becomes singer A; singer B is optional.
    Names and colours editable.
  - Two mics: pick a second input. It gets its own capture and tracker
    publishing `singer: 1` on the frame bus, its own calibrated latency
    (the input/output pair key already covers it), and its own ribbon.
  - One mic, two singers: turns. Take the phrases from W4's splitter and
    assign them A, B, A, ...; a click on a phrase in the lane cycles A,
    B, both. The lane shows whose turn it is. In learning mode each
    phrase is scored for its singer, and "both" phrases count for both,
    marked shared. No voice recognition.
  - Learning mode: one report card and one tips list per singer.
  - The device picker warns that a Bluetooth headset's mic drops it to
    call quality (its label says "Hands-Free" on Windows).
  - Done when the checks and e2e are green (two fake mics). Owner test
    with a second person: one mic with turns, then two mics if available.
- [ ] **W6: Synced lyrics** (small, optional).
  - Synced lyrics on request: look the song up on LRCLIB (lrclib.net,
    free, no key) by title and artist (from the file's tags, the video
    title, or typed), or paste an `.lrc` file or plain text. Show the
    current and next line, cached per song in IndexedDB. When lines
    exist, W5's turns follow them instead of note gaps. No Whisper.
  - Done when the checks are green. Owner test: sing an original with its
    lyrics.
- [ ] **W7: Owner test and one bug sweep.** The owner runs the full list:
  solo with a file, a link, a prepared link; learning mode; duet on one
  mic and on two; speakers and headphones. Then one reviewer reads
  everything changed since the trim plus the owner's findings, one fixer
  fixes, one commit. The goal is met.

## Later

Not scheduled. Pull one in only when the owner asks.

- **Lyrics by transcription.** Whisper on the vocal stem. If ever picked:
  whisperx 3.8.6 pins torch ~=2.8 and pyannote-audio >=4, which do not
  coexist with our torch 2.11 (uv silently fell back to an old whisperx
  3.4.5 stack). Options were faster-whisper directly (CTranslate2 on
  CUDA 12, why torch is on cu128) with our own word alignment, or whisperx
  in its own venv as a subprocess. Mind disk space.
- **Deeper analysis in the service.** Re-tracking the take with crepe,
  DTW alignment, vibrato, dynamics, timbre and breath features, the
  match-mode rules that need them (`docs/COACHING.md`), and speaker bleed
  in take analysis.
- **Scoring a karaoke video against its original.** Prepare both, align
  the original's melody to the karaoke audio (chroma DTW plus a key
  offset), then score while the singer follows the video. Re-recorded
  karaoke versions with another arrangement defeat it, so it needs its
  own confidence check. Until then the original's own instrumental
  stands in (W3).
- **Keyless search** through the service (yt-dlp), if the API quota or a
  shared desktop app ever needs it.
- **Range and key.** Estimate the singer's range and transpose the
  backing (a WSOLA AudioWorklet, or rubberband in the service).
  Transposing shifts W4's `KeyMap` by the same interval.
- **Chord-aware freestyle.** Judge Open's free notes against the chord
  under them, not only the key (chord estimation in the service), so an
  in-key note that clashes with its chord is caught.
- **Duet extras.** Enrollment, voice recognition for overlapping singers
  on one mic, harmony detection and bonus, duet card highlights.
- **Fun extras.** Streaks, stars, skin FX, more skins, per-skin coaching
  copy, a new-record flourish, PNG export of a report card.
- **Housekeeping.** A settings panel that gathers everything, self-hosted
  display fonts, e2e in CI.
- **Public app** (owner asked, 2026-10-27). What has to change before
  encore ships to other people. Not legal advice: get a review of the
  terms and rights items before a public or paid release.
  - Desktop shell: Tauri, the service as a sidecar, installers. Check
    early that YouTube's embedded player plays inside the shell; it has
    lately refused pages without a normal web address.
  - Search through a small server that holds the API key (a second
    provider behind W2a's interface), and Google's quota review, which
    audits the whole app against YouTube's policies.
  - Leave preparing YouTube songs out of the public build: it breaks
    YouTube's terms and would fail that review. Learning mode then works
    on the user's own copy of a song, and "Find the original" asks for
    that file instead of fetching it. Karaoke mode is unchanged.
  - Run without an NVIDIA card: lighter separation and pitch models on
    an ordinary processor or Apple silicon, in-process where possible
    (preparing takes minutes instead of seconds), and an install far
    smaller than today's 3 GB of GPU packages.
  - Lyrics: a licence from the publishers (sold by services such as
    LyricFind and Musixmatch) or no lyrics lookup, especially in a paid
    app. LRCLIB is fine for personal use.
  - Code signing: an Apple developer account and a Windows certificate.
  - Third-party licence notices, and an LGPL build of ffmpeg if it is
    bundled.
- **Follow-ups under finished tasks** in `docs/HISTORY.md`: an upload
  length cap, notes while a step runs, clearing crash leftovers, releasing
  GPU memory, and more. None block the goal.

## Estimates (corrected 2026-11-05 after W0, light pipeline)

W1 measured about 1 hour of wall time (two workers in parallel, then
one reviewer) and about 1.0 M subagent tokens. W2 measured 1 hour and
0.94 M (two workers one after the other, one reviewer, one small fix)
against an estimate of 2 hours and 1.1 M. W3 measured about 0.7 hours
and 0.53 M (one worker at 0.36 M, one reviewer at 0.17 M, a small fix)
against 0.8 and 0.7 M: one track with a detailed brief costs about half
of a two-track wave. W4 measured about 1 hour and 0.83 M (service
worker 0.20 M with its fix, browser worker 0.45 M, reviewer 0.18 M)
against 1 hour and 0.8 M; the browser track alone cost nearly all of W3.
W0 (added 2026-11-05, unestimated) measured about 0.75 hours and 0.85 M:
worker 0.33 M, reviewer 0.11 M, and the two-item fix sent back to the
warm worker 0.41 M, more than the build. A resumed worker re-reads its whole
context on every turn, so a small fix in a fresh agent with a pointed brief
may cost less. W0b tried that: two parallel workers (0.11 M and
0.14 M), reviewer 0.09 M, and a fresh fixer with a pointed brief 0.08 M,
for 0.42 M and about 0.6 hours. That is half of W0 for a similar size,
so small fixes go to a fresh agent from now on. The rest are left as they
were.

| Wave | Agent hours | Subagent tokens | Owner |
|---|---|---|---|
| W0 Guide and mic diagnostics (measured) | 0.75 | 0.85 M | 20 min |
| W0b Embed controls and take trace (measured) | 0.6 | 0.42 M | 15 min |
| W0c Take analysis (measured) | 0.4 | 0.44 M | 10 min |
| W1 Seams and reference (measured) | 1 | about 1.0 M | 10 min |
| W2 Search and karaoke core (measured) | 1 | 0.94 M | 20 min, an API key |
| W3 Learning mode (measured) | 0.7 | 0.53 M | 20 min |
| W4 Strict and Open scoring (measured) | 1 | 0.83 M | 20 min |
| W5 Two singers | 1 (0.7-1.8) | about 0.7 M | 30 min, a second person |
| W6 Synced lyrics | 0.4 (0.3-0.8) | about 0.3 M | 5 min |
| W7 Test and sweep | 0.8 (0.6-1.5) | about 0.6 M | 45 min |
| **Total** | **about 8 (7-11)** | **about 6.6 M** | **about 3.2 h** |

The full plan this replaces was about 126 hours and 60 M tokens. The
orchestrator's own reading adds about 100 to 200 thousand tokens per wave
if it reads outlines and diffs, not whole files.
