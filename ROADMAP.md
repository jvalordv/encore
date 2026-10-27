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
- **Token efficiency comes first.** Batch work into waves, review lightly,
  and stop after each wave so the owner can `/clear`. One thorough bug
  sweep comes after the owner has tested (W6), not inside every wave.

## Current state

- **Last done:** scope trimmed to the goal above (2026-10-27): waves
  replace Phases 2 to 6, deferred work is under Later. Before it P2-T2
  (demucs separation on the GPU) and the YouTube work (P2-T1 to P2-T1d),
  both in `docs/HISTORY.md`.
- **In progress:** none.
- **Next:** the owner's test results (list below) if they have any: fix
  what they show first, as `W0: <summary>`. Then **W1**. The owner is
  creating a YouTube Data API key for W2's search (2026-10-27).
- **Blockers:** none.
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
  has the CPU deps, yt-dlp[default] and the `separation` extra (torch and
  torchaudio 2.11.0+cu128, demucs 4.1.0). In `service/` use
  `uv sync --extra separation` (add `--extra pitch` from W1), or
  `--inexact`; a plain `uv sync` uninstalls torch. C: had 156 GB free at
  the P2-T2 commit; keep 15 GB free. uv's cache still holds a cu130 torch
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

## Waves

Each wave lists what to build, the files it owns, and when it is done.
Tracks inside a wave share no files and may run in parallel.

- [ ] **W1: Seams and the reference melody.** Two tracks, one commit.
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
      W3, a second mic in W4.
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
- [ ] **W2: Search and karaoke core.** Two tracks, one commit.
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
- [ ] **W3: Learning mode** (was P2-T6, P2-T7, P3-T2, P3-T3; browser
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
- [ ] **W4: Two singers** (`docs/DUET.md`). Owns `src/duet/`, the
  singers panel, the lane's ribbon layer.
  - Settings: today's input becomes singer A; singer B is optional.
    Names and colours editable.
  - Two mics: pick a second input. It gets its own capture and tracker
    publishing `singer: 1` on the frame bus, its own calibrated latency
    (the input/output pair key already covers it), and its own ribbon.
  - One mic, two singers: turns. Split the reference into phrases (a gap
    between notes of about 0.6 s or more; a pure, tested function) and
    assign them A, B, A, ...; a click on a phrase in the lane cycles A,
    B, both. The lane shows whose turn it is. In learning mode each
    phrase is scored for its singer, and "both" phrases count for both,
    marked shared. No voice recognition.
  - Learning mode: one report card and one tips list per singer.
  - The device picker warns that a Bluetooth headset's mic drops it to
    call quality (its label says "Hands-Free" on Windows).
  - Done when the checks and e2e are green (two fake mics). Owner test
    with a second person: one mic with turns, then two mics if available.
- [ ] **W5: Synced lyrics** (small, optional).
  - Synced lyrics on request: look the song up on LRCLIB (lrclib.net,
    free, no key) by title and artist (from the file's tags, the video
    title, or typed), or paste an `.lrc` file or plain text. Show the
    current and next line, cached per song in IndexedDB. When lines
    exist, W4's turns follow them instead of note gaps. No Whisper.
  - Done when the checks are green. Owner test: sing an original with its
    lyrics.
- [ ] **W6: Owner test and one bug sweep.** The owner runs the full list:
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

## Estimates (2026-10-27, light pipeline)

Rough until W1 is measured; correct them after each wave.

| Wave | Agent hours | Subagent tokens | Owner |
|---|---|---|---|
| W1 Seams and reference | 3.5 (2.5-6) | about 1.8 M | 5 min |
| W2 Search and karaoke core | 4.5 (3-7) | about 1.8 M | 20 min, an API key |
| W3 Learning mode | 3 (2-5) | about 1.2 M | 20 min |
| W4 Two singers | 3 (2-5) | about 1.2 M | 30 min, a second person |
| W5 Synced lyrics | 1 (0.5-2) | about 0.4 M | 5 min |
| W6 Test and sweep | 1.5 (1-3) | about 0.8 M | 45 min |
| **Total** | **about 16.5 (11-28)** | **about 7.2 M** | **about 2 h** |

The full plan this replaces was about 126 hours and 60 M tokens. The
orchestrator's own reading adds about 100 to 200 thousand tokens per wave
if it reads outlines and diffs, not whole files.
