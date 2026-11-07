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

- **Last done:** **WL1** (2026-11-07): learning mode now gives measured
  feedback on any song, including a YouTube karaoke video with no melody:
  intonation, stability, scoops, drift, vibrato, range and phrasing in a
  "Your voice" card, a tuner-style live lane, and new tips. Before it
  **W0e** (2026-11-06): a live keyboard over the lane's
  gutter, with the melody's key lit, a voice marker at the exact pitch
  joined to the ribbon, a Keyboard toggle, and "Save melody (.mid)". The
  YouTube player also moved to youtube.com so the sign-in clears the bot
  check (2026-11-06). Before it **W0d** (2026-11-05): a Mic check beside
  Calibrate. It
  runs four guided steps over a synthesised test melody, labels them,
  gets W0c's analysis from the service (`POST /takes/analyse`), and offers
  "Use these settings" for the gate, the bleed rule and the latency per
  device pair. It works over a loaded file or a YouTube video. Before it
  **W0c** (2026-11-05): `take_analysis` in the service
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
- **In progress (2026-11-07, overnight, owner asleep):** WL3b (aligning
  the original's melody to a karaoke video) in the main checkout. Landed
  tonight: WL1, W0f, WL2, WL3a (capture) and W6 (lyrics). The downloader
  fix waits on the owner (WL3).
- **Next:** **WL2** (progress over time), **WL3** (a
  melody for YouTube songs: capture while it plays, plus the downloader
  as a backup, both used together where possible), then **W0f** (library and
  favorites), **W0g** (backing music as
  notes), **W5**, **W6**, **W6b** (range and key), **W6c** (settings
  panel), **W6d** (fun extras), then the owner's **W7**. The owner asked
  to chain these in one session, 2026-11-06. W5's owner test needs a
  second person. The owner's tests for W0, W0b and W0d (Mic check in
  speaker and headphone modes) can run at any time; the card's findings
  set a tuning wave. Search needs the owner's YouTube Data API key
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

- [x] **W0d: Mic check in the app** (owner, 2026-11-05: "build that into a
  calibration setting"; running the command by hand "seems imprecise").
  The app runs W0c's protocol itself, labels the sections, gets the
  analysis from the service, and offers the tuned settings. Two tracks:
  service and browser.
  - **Guided steps** (a Mic check button beside Calibrate). Each step shows
    one prompt, a countdown and the live meter:
    1. Quiet room, 5 s: nothing plays and you stay silent. This measures
       the noise floor.
    2. Speakers only, 10 s: the app plays the test melody through the
       chosen output at the song volume while you stay silent. This
       measures bleed. In headphones mode it measures leakage.
    3. Sing along, 15 s: the melody plays and you sing with it.
    4. Sing alone, 10 s: nothing plays and you sing.
    Cancel at any step. The check records like a take and runs in either
    mode.
  - **Test melody** (default): synthesised in the browser as a voice-like
    harmonic tone with vibrato, in a comfortable range (low or high), and
    played through the audio engine and the chosen output, so echo
    cancellation sees it as the page's own audio. Its contour is the exact
    reference. Option: use the loaded song instead, when it has a melody.
  - **Labels in the trace:** the check's take carries `kind: 'mic-check'`
    and a `sections` list (label, span) in its trace. The JSON export
    gains them (version 3), and W0c's command reads them when no
    `--section` is given.
  - **Service:** `POST /takes/analyse` (multipart JSON and WAV, Pydantic
    response) runs W0c's analysis, crepe included when the pitch extra is
    installed. It returns the findings and recommended values: the draw
    margin, the clarity threshold, the bleed rule, and the latency.
  - **Settings:** the tunable constants become settings kept per device
    pair, like `latencyByDevicePair`, defaulting to today's constants and
    sanitised. The gate, the bleed detector and the meter read them.
  - **Result card:** the findings in plain words, with before and after
    numbers, a "Use these settings" button and "Reset to defaults". It
    talks about the mic and the room only, never grades the singing, and
    so is fine in karaoke mode. With the service down, the steps still run
    and the take is saved. The card says the analysis needs the service
    and offers Save WAV and Save JSON.
  - Tests: unit tests for the melody generator (exact contour), the step
    machine and the settings sanitiser; pytest for the endpoint and for
    reading sections from the trace; e2e that runs the check with the fake
    mic and a fake service answer, then applies the settings.
  - Done when every check is green. Owner test: run the Mic check in
    speaker mode, then in headphones mode, and report the card and whether
    the ribbon behaves better after "Use these settings".
  - Built (2026-11-05), service and browser tracks in parallel in one
    checkout, one review, one fresh fixer.
    - **Service:** `POST /takes/analyse` in
      `service/encore_service/routes/takes.py`, with
      `take_analysis/{mic_check,tuning}.py`. A value is advised only when
      it changes and the evidence meets the minimums: 100 sung frames, 90 %
      of them kept for the gate; a bleed rule that flags no sung section
      and keeps every silent one the current rule flags; for latency, 150
      frames at a match share of 0.7 or more and a move of at least 5 ms.
      Values are clamped to the same bounds as `TUNING_RANGES`.
    - **Browser:** `src/analysis/{mic-tuning,test-melody}.ts`,
      `src/app/mic-check.ts` (the step machine), and
      `src/app/{session,panels}/mic-check.ts`. Tuning is kept as
      `micTuningByDevicePair` and read by the gate, the bleed detector, the
      tracker clarity and the trace. The check plays its 40 s melody as a
      transient song (`Player.loadTransient`). Stems that arrive meanwhile
      go to the shelved song. A YouTube video is parked, paused at its
      position, and a prepared song's follower is suspended. The take is
      stored under the song key `mic-check`, and the card offers Save WAV
      and Save JSON. Use these settings refuses when the device pair
      changed since the check.
    - The e2e test seam is `?micCheckScale` (8 s instead of 40). Review
      fixes: stems arriving mid-check, the device pair, the lane range,
      and YouTube support.
  - Follow-up: during a check over an unprepared YouTube video, a click on
    the video would still play it aloud; guard it with the parked state.
  - Follow-up: "Use the loaded song" is not built; it needs a melody for
    any song.
  - Follow-up: the section verdicts in `measure.py` and `match.py` still use
    the mirrored constants, not the take's tuning; only the sweep and the
    advice use the tuning.
  - Follow-up: `src/app/session/takes.ts` (520 lines) and
    `src/audio/player.ts` (640) are over the size rule; split them in a
    quiet wave.
  - Follow-up: the three skins and the narrow window were not looked at
    in a browser.

- [x] **W0e: Keyboard view and melody MIDI** (owner, 2026-11-06: "auto
  transpose music to midi and then have that play on the keyboard ... a
  line show where the singer's voice falls note wise on the keyboard, for
  a nice broad visual representation"). Owner decisions, 2026-11-06: the
  melody and the voice first (transcribing the backing music is Later),
  visual only (no piano sound). Browser only, one track.
  - **Keyboard:** a piano keyboard down the lane's left edge, its keys
    lined up with the lane's semitone rows (`midiToY`, `isBlackKey` and
    the gutter in `src/render/lane-geometry.ts`), following the lane's
    range. The melody's key lights up while its note sounds at the
    playhead (from the reference notes, `LaneNote`). The singer's pitch
    shows as a marker at its exact, unrounded height, joined to the
    ribbon by a short line, and the nearest key glows softly. In karaoke
    mode the colours are neutral, with no hit or miss, the same rule as
    the note guide. Learning mode may use the existing grade colours. A
    `keyboard` setting, on by default, turns it off. It works in all
    three skins with their tokens and stays readable in a narrow window.
  - **Melody as MIDI:** a "Save melody (.mid)" button where the song's
    melody is shown, when a reference exists. It writes a Standard MIDI
    File, type 0, timed so that 1 tick = 1 ms (tempo 60 bpm at 1000 ticks
    per quarter), with one note per reference note, rounded to the
    nearest semitone. The pitch bend for the cents is left out.
  - Tests: the key layout against the lane rows; the marker height from
    f0; the lit key at a time; the MIDI encoder (exact bytes for a two-note
    case, and a round trip through a small parser in the test).
  - Done when the checks and e2e are green (one e2e: the keyboard renders
    with a melody and the .mid downloads). Owner test: sing over a
    prepared song and say whether the keyboard reads well at a glance;
    open the .mid in any MIDI player.
  - Built (2026-11-06): `src/render/lane-keyboard.ts`, a live layer over
    the existing piano gutter in `lane-grid.ts`. The lit key is the
    reference colour at 65 % alpha, so the C labels stay readable. The
    lit key is found by binary search (`overlappingRange`). The marker
    uses only the newest frame at or before now, so it disappears as soon
    as the singer stops or the gate closes. A karaoke frame has no grade,
    so the marker takes the singer's colour. Also
    `src/audio/midi-file.ts` (type 0, 1 tick = 1 ms; a same-key overlap
    is cut, and a same-tick repeat replaces the earlier note),
    `src/app/panels/keyboard.ts` and `src/app/melody-download.ts`. The
    lane canvas exposes `data-keyboard`. Review fixes: the lingering
    marker, a same-tick MIDI double on, and the missing tests (a fake DOM
    helper is in `test/fake-dom.ts`).
  - Follow-up: the keyboard has not been looked at in the three skins or
    a narrow window.

- [x] **WL1: Learning feedback on any song** (owner, 2026-11-06: "get
  the learning mode built out so we can get some feedback; that's the
  whole point of this in the first place"). Today learning mode scores
  only against a prepared song's melody. A YouTube link cannot be prepared
  while YouTube's bot check blocks the downloader, and a karaoke video has
  no vocal to take a melody from. So on the owner's usual songs learning
  mode says nothing. This wave makes it give measured feedback with no
  melody at all. Browser only.
  - **The voice alone:** from the take's frames, segment notes (the
    W3 rule in `docs/COACHING.md`) and measure, per note and per take:
    - intonation against the nearest note (or the nearest scale tone when
      a `KeyMap` exists, else a key estimated from the sung notes
      themselves, labelled as estimated): the sharp or flat bias and the
      share of notes within ±25 c and ±50 c;
    - stability on held notes (over 400 ms): the std of cents;
    - scoops into notes (the first 150 ms against the steady part);
    - drift over long notes (the slope in cents per second);
    - vibrato (rate, extent, regularity) where present;
    - range used (p10 to p90), and phrase lengths and breath gaps.
  - **Live:** in learning mode with no melody, the lane colours the ribbon
    by cents from the nearest note (or scale tone), like a tuner. The
    existing grade colours apply.
  - **Report card:** a "Your voice" section beside the melody scores (or
    alone when there is no melody), with the worst notes jumpable and
    replayable like today's worst phrases. New tips from the same rule
    engine (`src/coach/tips.ts`): `drift`, `vibrato_wide`,
    `vibrato_irregular`, `short_phrases`, and reuse of `scoop`,
    `flat_bias`, `sharp_bias` and `unstable_sustain` without a reference.
    Every tip names its number.
  - Update `docs/COACHING.md` ("What we measure", "Tips") to match.
  - Tests: each measure on synthetic contours with known answers (a 6 Hz
    ±50 c vibrato, a 30 c/s drift, a 100 c scoop, a steady sharp bias),
    the estimated key, and the tips firing past their thresholds only.
    One e2e: learning mode on a YouTube link with the fake mic gives a
    card with "Your voice".
  - Owner test: sing a YouTube karaoke video in learning mode and say
    which tips ring true.
  - Built (2026-11-07):
    - Modules: `src/analysis/{voice,contour-fit,key-estimate}.ts`,
      `src/app/voice-report.ts`, `src/app/panels/voice-block.ts`.
    - Report: `TakeReport.voice` is optional, and `noMelody: true` when
      there is no reference or it is a karaoke track in Strict.
    - Key: the reference is the key map when clear, else an estimated
      key (Krumhansl-Kessler: at least 6 notes, at least 5 pitch
      classes, r ≥ 0.75, a lead of ≥ 0.05 over the best non-relative),
      else the nearest semitone. Both fallbacks are at A = 440 Hz, and
      the card says so.
    - Note fit: one joint least-squares fit per note (level, line,
      sine).
    - Stability: only on notes over 0.65 s, long enough to fit a 4 Hz
      vibrato, so vibrato never counts as wobble.
    - Vibrato: 4–8 Hz, extent ≥ 25 c, regularity ≥ 0.5, a peak margin of
      0.1 over rates 1 Hz away, and at least 2 cycles.
    - Live: with no melody the lane grades like a tuner (25 c hit, 50 c
      okay).
    - New tips: `drift`, `vibrato_wide`, `vibrato_irregular` and
      `short_phrases`. Thresholds are in `TIP_THRESHOLDS` and
      docs/COACHING.md.
    - Review fixes: stability vs vibrato length, vibrato false
      positives, the basis line, and the karaoke-track notice.
  - Follow-up: with no key map the voice is judged at A = 440 Hz, so a
    karaoke track tuned away from 440 shows as the singer's bias. WL3's
    capture gives a key map with tuning and closes this for captured
    songs.
  - Follow-up: `VIBRATO_NOTE_S` (0.5 s, the "looked for vibrato" count)
    disagrees with the 0.65 s that a 4 Hz vibrato needs.
  - Follow-up: drift over about 25 c/s can be cut by the 80 c
    segmentation rule, so extreme drift is under-reported.
  - Follow-up: Open freestyle on a track with no melody still shows the
    'free' colour live. Tuner colours there are untried.
- [x] **WL2: Progress over time.** Each learning take stores its summary
  (it already does). A Progress view shows per song and overall trends:
  in-tune share, bias, stability, scoops, range. Show the best and the
  latest, and the change since the first week. Learning mode only; nothing
  in karaoke mode. Tests: aggregation across takes and songs, and old
  takes without the new fields.
  - Built (2026-11-07):
    - Code: `src/analysis/progress.ts` (aggregation),
      `src/app/progress.ts` (measures and wording), the panel
      `src/app/panels/progress.ts`, and `src/render/sparkline.ts` (inline
      SVG).
    - Visibility: a Progress button in the header, in learning mode
      only.
    - Series: Strict and Open in-tune shares are separate. Bias and the
      ±25 c and ±50 c shares are split by the reference they were
      measured against (song key, estimated key, nearest semitone).
      Stability, scoop, drift, vibrato and range are one series each.
    - Trend: Theil-Sen per week over one median per local day; with
      fewer than 3 days it says "not enough days yet".
    - Panel: it caches the points and reloads only when the takes
      change.
    - Review fixes: within-session pair slopes, mixed references, and
      reloading on every song change.
  - Follow-up: listing takes still clones every record's frames from
    IndexedDB. A small summaries object store, written on put, would
    make Progress cheap with hundreds of takes.
  - Follow-up: sparklines are spaced per take, not by time.
- [ ] **WL3: A melody for YouTube songs** (owner decision, 2026-11-06:
  capture while it plays as the main path, plus the downloader fixed as a
  backup; "maybe they could both be used for improved accuracy where
  possible"). Two routes into the same prepare pipeline:
  - **Downloader fix:** yt-dlp's PO-token provider plugin (the bgutil
    provider in its Node script mode; Node 24 is on PATH) and a newer
    yt-dlp, with no browser cookies. When it works, Prepare and "Find the
    original" run automatically as before.
    **Waiting on the owner (2026-11-07):** the overnight session's
    safety check refused to start this work: a plugin that gets past
    YouTube's bot check. It needs the owner's explicit go-ahead in chat
    before any agent installs or wires it. Capture covers YouTube songs
    meanwhile.
  - **Both, for accuracy:** when both a download and a capture exist for
    a video, the download is the audio source (lossless timing, no room
    or tab-volume effects). The capture is cross-checked against it by
    chroma alignment to confirm the timing offset of the embed
    (`embedOffsetS`) and the latency. If only one exists, use it. Record
    which source a melody came from, and show it on the song panel.
  - **Capture while it plays** (main path): with "Capture for learning"
    on, Chrome's tab-audio share
  (`getDisplayMedia`, this tab, audio) records the video as it plays once.
  The service separates it and extracts the melody and key as Prepare
  does today, so it is not stopped by bot checks. For a karaoke video it
  gives the key and the backing notes (Open scoring and W0g), and the
  melody comes from "Find the original" (W2), aligned to the karaoke
  audio by chroma DTW. That is the Later item "Scoring a karaoke video
  against its original", now pulled in. It has its own confidence check
  and falls back to Open when the arrangement differs. Both routes are
  opt-in and in the same policy category as Prepare (Current state,
  Policy flag).
  - Likely two waves (WL3a capture and the downloader fix, WL3b the
    karaoke-to-original alignment); split when it is briefed.
  - **WL3a, capture, built (2026-11-07).** The downloader fix waits on
    the owner, above.
    - Service: `POST /songs/url/{video_id}/capture`
      (`service/encore_service/routes/capture.py`) stores song
      `yt-{id}` with `source.wav` and the fetch step done, so the
      existing prepared-link flow runs separation, key and reference
      unchanged. `audio_source` (`capture` or `download`) is on the song
      record. A download keeps its place, and the capture goes beside it
      as `capture.wav`. A second capture replaces the first and re-runs
      the steps.
    - Browser:
      - Files: `src/audio/{capture-assembler,tab-capture}.ts`,
        `src/app/capture.ts`, `src/app/session/capture.ts`,
        `src/app/panels/capture.ts`.
      - Capture: the tab is shared with `getDisplayMedia` and recorded
        as PCM. Blocks are placed at their video time, only while the
        video plays.
      - Sending: Stop needs 90 % coverage; a video that ends needs 50 %.
      - Refusals: a share stopped from Chrome's bar fails the capture,
        and silent audio is refused.
      - Song change: changing songs cancels a capture or an upload.
    - Test seam: `?captureFake`.
  - Follow-up: the owner should try the real tab share once. Headless
    Chromium cannot pick a tab, so only the seam is tested end to end.
  - Follow-up: the offset between the tab audio and the embed clock is
    not calibrated. That is fine for separation, not for timing; WL3b's
    cross-check can measure it.
  - Follow-up: a playback rate other than 1 is not guarded, and a reload
    mid-capture loses it.
  - **WL3b, still to do:** align the original's melody to a karaoke
    video by chroma DTW (with a key offset and a confidence check,
    falling back to Open), and cross-check a capture against a download
    when both exist.

- [x] **W0f: Library and favorites** (owner, 2026-11-06: "create a
  playlist of favorites, which would be the youtube links if they're from
  ... through the app view and play saved music tracks"). Two tracks:
  browser and service.
  - **Library:** every song you load, a YouTube link or an uploaded file,
    is added to a Library list kept in the browser (IndexedDB, like the
    takes), newest first. Each entry has its title, its source (a YouTube
    video id, or a file's hash and name), its length, when it was last
    played, whether it is prepared (karaoke stems, melody), and how many
    takes it has. Click an entry to load it: a link loads the video, and
    an upload is fetched back from the service
    (`GET /songs/{id}/audio`, with stems and melody as now). With the
    service down, an upload entry says it needs the service. Remove an
    entry with a confirm step. The takes stay with their song.
  - **No-key Search (owner, 2026-11-06):** without a key, the Search panel
    shows a "Set up in-app search" box with the steps from the README (a
    Google Cloud project, enable YouTube Data API v3, create an API key
    limited to that API, paste it here). Opening YouTube's own results
    stays as a secondary link.
  - **Service:** `GET /songs` lists what the store holds (id, name,
    length, which steps are done), so the Library can show an upload the
    browser forgot (cleared storage, another browser).
  - **Favorites:** a star on the current song and on each Library entry.
    Favorites is a playlist: order it (up and down), play it from the top
    or from any entry, with Next and Previous, moving to the next song
    when one ends (a setting, on by default). Export and import the
    favorites as a JSON file, so a list survives a browser reset or moves
    to another machine (links travel; uploads need the same service
    store).
  - Tests: the library store (add, update, dedupe by source, remove, old
    records), the playlist order and advance logic, export and import
    (sanitised), and the `GET /songs` route. One e2e: load two songs, star
    them, reorder, and let one end to see the next load.
  - Done when every check is green. Owner test: star the two songs you
    recorded, reload the page, and play the Favorites through.
  - Built (2026-11-07):
    - Code: `src/app/{library,playlist,library-share,library-state}.ts`,
      `src/app/session/library.ts`, `src/app/panels/library.ts`, and
      `src/library.css`.
    - Store: IndexedDB `encore-library` v1. A record is keyed by the song
      hash the takes use (`yt-<id>` or the file's sha256); the takes
      count is derived. `songs.ts` notes each load and gained
      `loadStored` (fetch an upload back from the service).
    - Favorites: they move to the next song on a natural end only (not
      while looping), and survive a Mic check. The `autoAdvance` setting
      is in the settings store. Export format:
      `{kind:'encore-favorites', version:1}`. Import refuses other
      versions.
    - Service and Search: the service has `GET /songs` (newest first),
      and the Search panel shows the "Set up in-app search" box without
      a key.
    - Review fixes: Mic check vs the playlist, a loop wrap
      auto-advancing, the import version, an unread import file, and a
      stale playlist after another load won.
  - Follow-up: `src/app/session.ts` is over 500 lines; move a facade or
    two out.
  - Follow-up: without crypto the file hash falls back to FNV and cannot
    match the service's sha256 id.
  - Follow-up: "Last played" is set at load, not at play.
  - Follow-up: the drawer was not looked at in the three skins or a
    narrow window.

- [ ] **W0g: Backing music as notes** (owner, 2026-11-06: "we can also do
  the backing music as midi as well, but they could show as grey").
  Service and browser.
  - **Service:** a `backing` step after separation transcribes the
    instrumental stem (`no_vocals`) to notes with a polyphonic
    transcription model (Basic Pitch, through an ONNX backend if it runs
    on this machine; one new optional extra, `transcribe`, installed like
    `pitch`). `GET /songs/{id}/backing` returns notes (onset, offset, midi,
    velocity). It is skipped with a plain line when the extra is missing.
    Accuracy on dense mixes is rough: say so in the README, and keep notes
    under about 30 ms or with low confidence out.
  - **Browser:** backing notes drawn grey behind the melody bars on the
    lane, and grey lit keys on the W0e keyboard, under the melody's
    colour. A "Backing notes" toggle, on when present. "Save melody (.mid)"
    gains a "with backing" choice that writes a type-1 file with two
    tracks (melody, and backing on another channel).
  - Tests: the step on a synthetic two-chord WAV with known notes (skip
    when the extra is missing), the route, drawing order and colours (by
    the lane's layer list, not pixels), and the type-1 MIDI encoder.
  - Done when every check is green. Owner test: prepare a song, look at
    the grey notes against the music, and open the two-track .mid.

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
- [x] **W6: Synced lyrics** (small, optional).
  - Synced lyrics on request: look the song up on LRCLIB (lrclib.net,
    free, no key) by title and artist (from the file's tags, the video
    title, or typed), or paste an `.lrc` file or plain text. Show the
    current and next line, cached per song in IndexedDB. When lines
    exist, W5's turns follow them instead of note gaps. No Whisper.
  - Done when the checks are green. Owner test: sing an original with its
    lyrics.
  - Owner, 2026-11-06: import only, no transcription of sung lyrics. Most
    karaoke videos already show lyrics, so the lyrics line is off by
    default for a Karaoke-badged video and on for others when lines
    exist.
  - Built (2026-11-07):
    - Code: `src/lyrics/{lrc,title,lrclib,store,controller}.ts`,
      `src/app/panels/lyrics.ts`, and `src/lyrics.css`.
    - Lookup: LRCLIB on request only, sending the title, artist and
      length (`/get`, then `/search`, preferring synced lyrics). Paste or
      drop an `.lrc` file or plain text, up to 1 MB.
    - Display: the current and next line ride the lane at the same song
      time as the melody bars. A ±0.1 s nudge per song is cached in
      IndexedDB, and the show/hide choice is remembered per song.
    - Review fixes: the time base, empty synced text, plain-only
      results, a late duration, the remembered choice, and the size cap.
  - Follow-up: there is no ID3 tag parsing, so title and artist are
    guessed from the file or video name.
  - Follow-up: lyrics do not follow a take played solo. W5's turns
    following the lines are still to do with W5.
- [ ] **W6b: Range and key** (owner pulled it in from Later, 2026-11-06).
  - Range: estimate the singer's comfortable range from takes (a robust
    low and high, e.g. the 5th and 95th percentile of voiced, gated
    frames over the last takes or a short "sing low, sing high" step in
    the Mic check), shown as a band on the W0e keyboard.
  - Key: transpose the song by semitones (-6 to +6) to fit the range,
    with a suggested shift from the melody's range against the singer's.
    Browser playback uses a pitch-shifting AudioWorklet (WSOLA,
    hand-written and tested); the YouTube embed cannot be shifted, so
    there the suggestion only shows. The melody bars, keyboard, `KeyMap`
    (W4), scoring and the MIDI export shift by the same interval.
  - Tests: the range estimate on synthetic frames, the WSOLA shift on a
    sine (pitch within 5 c, length unchanged), the shifted `KeyMap` and
    notes. Owner test: transpose a prepared song and sing it.
- [ ] **W6c: Settings panel** (owner pulled it in from Later, 2026-11-06).
  One panel that gathers every setting: mic and output, monitor mode,
  latency and Mic check tuning per device pair, note guide, keyboard,
  vocal guide level, skin, search key, service URL, auto-advance and
  auto-prepare. It reads and writes the same settings store; the inline
  controls stay where they are used. Includes Reset all, and export and
  import of settings (no search key in the export unless asked). Tests:
  the export sanitiser. Owner test: change a few, reload, export.
- [ ] **W6d: Fun extras** (owner pulled it in from Later, 2026-11-06).
  Streaks (days sung in a row), stars per song in learning mode only (no
  stars or streak counts in karaoke mode beyond "days sung", which judges
  nothing), skin effects on a new personal best in learning mode, and PNG
  export of a report card. Per-skin copy where the skins already have
  personality text. Tests: streak dates across time zones and midnight,
  star thresholds. Owner test: sing on two days, export a card.
- [ ] **W7: Owner test and one bug sweep.** The owner runs the full list:
  solo with a file, a link, a prepared link; learning mode; duet on one
  mic and on two; speakers and headphones. Then one reviewer reads
  everything changed since the trim plus the owner's findings, one fixer
  fixes, one commit. The goal is met.

## Later

Not scheduled. Pull one in only when the owner asks.

- **Lyrics by transcription.** Owner, 2026-11-06: not needed; imported
  lyrics (W6) are enough. Whisper on the vocal stem. If ever picked:
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
| W0d Mic check in the app (measured) | 1 | 0.75 M | 15 min |
| W0e Keyboard and melody MIDI (measured) | 0.4 | 0.31 M | 10 min |
| WL1 Learning feedback on any song (measured) | 0.6 | 0.42 M | 20 min |
| W0f Library and favorites (measured, worktree) | 0.6 | 0.45 M | 10 min |
| WL2 Progress over time (measured) | 0.5 | 0.35 M | 10 min |
| WL3a Capture for learning (measured, worktree) | 0.8 | 0.47 M | 10 min |
| W6 Imported lyrics (measured, worktree) | 0.5 | 0.33 M | 5 min |
| W1 Seams and reference (measured) | 1 | about 1.0 M | 10 min |
| W2 Search and karaoke core (measured) | 1 | 0.94 M | 20 min, an API key |
| W3 Learning mode (measured) | 0.7 | 0.53 M | 20 min |
| W4 Strict and Open scoring (measured) | 1 | 0.83 M | 20 min |
| W5 Two singers | 1 (0.7-1.8) | about 0.7 M | 30 min, a second person |
| W6 Synced lyrics | 0.4 (0.3-0.8) | about 0.3 M | 5 min |
| W7 Test and sweep | 0.8 (0.6-1.5) | about 0.6 M | 45 min |
| **Total** | **about 9 (8-12)** | **about 7.4 M** | **about 3.5 h** |

The full plan this replaces was about 126 hours and 60 M tokens. The
orchestrator's own reading adds about 100 to 200 thousand tokens per wave
if it reads outlines and diffs, not whole files.
