# Roadmap

Each task is sized for one worker session and ends in one commit. Tier is the
model that should do it (S = Sonnet, H = Haiku, F = orchestrator). "Done when"
is the acceptance test; "Verify" is the command that proves it. Follow the
resume protocol in `CLAUDE.md`.

## Current state

- **Last done:** P2-T1 (service song intake: cache, one-at-a-time job
  queue, step pipeline with a runner registry, status and audio routes;
  183 service tests). Before it: a Windows CRLF fix to
  `test/skins.test.ts` (`b462609`). 491 unit tests green. Speaker mode
  still untried on real speakers.
- **Workflow:** the orchestrator (Opus) runs each wave as a Workflow:
  Sonnet implementer, three review lenses, adversarial verification of
  findings, fixer, critic. Then it reviews the diff itself and commits.
  Browser-side work runs in a git worktree and merges at the end, so the
  owner's dev server on :5173 reloads once.
- **e2e on this machine:** Playwright's Chromium was missing (earlier runs
  were elsewhere). `npx playwright install chromium` hung once on the
  headless-shell download and was retried; if `npm run e2e` says the
  executable does not exist, rerun that install.
- **In progress:** no code. The owner is running the speaker/calibration
  checklist below on real hardware and has not reported results yet. When
  they do: fix what the status lines and their notes show, as `P1-T10`
  follow-up commits, before taking P2 work that edits `src/`.
- **Blockers:** none.
- **Owner priority, stated in session:** pick a YouTube video and have it
  play inside the app, and be parsed like a dropped mp3 ("very important").
  Specified in `docs/ARCHITECTURE.md` (YouTube playback in the app, Song
  sources, Decisions) and tasked as **P2-T1c** (embedded player, no
  service), **P2-T1 and P2-T1b** (service intake and yt-dlp), **P2-T1d**
  (prepare in the background and switch to the engine), ahead of the rest
  of Phase 2.
- **Policy flag for the orchestrator:** the terms for the embedded player
  forbid downloading or caching YouTube content, separating its audio, and
  fetching its data by other means (sections III.E.1.a, III.I.7, III.I.14
  of the developer policies). Prepare-for-scoring (yt-dlp, separation)
  does exactly that. The design keeps the two paths separable and the
  prepare path opt-in, and the README must not paper over it. **Owner
  decision (2026-10-23): keep the prepare path, opt-in and off by
  default, as specced.** Do not re-ask.
- **Next:** orchestrator pass (Opus). Two tracks can run at once because
  they touch different trees: service (P2-T1, then P2-T1b; only
  `service/`, safe while the owner tests) and browser (P2-T1c, spike
  first). P2-T1d joins them and goes last. One task per commit.
- **Machine facts (checked 2026-10-23):** Windows 10, `uv` 0.11.16 and
  `ffmpeg` 9.0.2 (winget) are on PATH; `node` yes, `deno` no. `service/`
  has `uv.lock` but no `.venv` yet (`uv sync` not run) and nothing is
  listening on :8765. The Vite dev server is on :5173 (the owner's).
- **Repo hygiene done this session:** repo-local git identity set to
  `Claude <noreply@anthropic.com>` to match history (plain `git commit`
  works; `git -c ...` does not match the allow rule and prompts). Read-only
  MCP tools added to `.claude/settings.json`. Edit/Write/PowerShell still
  prompt unless the owner sets the app's permission mode; not ours to flip.
- **Owner-side, when convenient:**
  - `git pull`, `npm run dev`. Pick the webcam mic, choose Speakers under
    the mic picker, read the status line: expect "Speaker mode: echo
    cancellation on, NS/AGC off". If it says the browser kept echo
    cancellation off, report it.
  - Calibrate twice with speakers on and report both status lines. Success
    reads "Latency N ms (trials ...; confidence ...)". A failure now says
    which knob to turn (speaker volume, mic distance) or lists the trial
    delays if they disagree.
  - Play the song through the speakers and sing a held vowel. Does the
    ribbon follow you or the song? Try normal and loud song volume, then a
    few seconds in Headphones mode with speakers still playing to hear the
    difference. If the ribbon lags the song by a fixed amount in speaker
    mode, the canceller's buffering adds a few ms a raw calibration does
    not see; nudge the latency field and report the value.
  - If bleed persists only when a specific Output is chosen in the picker,
    try System default: Chrome's canceller may not reference a non-default
    output.
  - GPU machine: install uv and ffmpeg, `uv sync` in `service/`, enable the
    PyTorch CUDA index per `service/README.md`, `uv sync --extra gpu`, and
    confirm `GET /gpu` shows `cuda_available: true`.

---

## Phase 0: Scaffold

Goal: a repo any session can clone, check, and extend. No features yet.

- [x] **P0-T1** (F) Planning docs: `CLAUDE.md`, `ROADMAP.md`, `docs/*`.
- [x] **P0-T2** (S) Front-end skeleton. Vite + strict TS + vitest matching
  `4th-dimension`. `index.html` with the app shell regions (top bar with skin
  switcher, song panel, pitch lane, controls, status bar), `src/main.ts`
  mounting them, and the skin token system from `docs/SKINS.md` with the three
  skins as CSS files plus a `Skin` type and personality copy objects. Skin
  switcher persists to `localStorage`. One vitest smoke test for the skin
  registry. *Done when:* `npm run check` and `npm run build` pass, the dev
  server shows the shell, and switching skins visibly changes it.
  *Verify:* `npm run check && npm run build`.
- [x] **P0-T3** (S) Service skeleton under `service/`. `pyproject.toml` with
  CPU deps and a `gpu` extra listing the heavy models (not installed in CI).
  FastAPI app with `GET /health`, `GET /gpu` (reports torch and CUDA status
  without failing if torch is absent), CORS for `localhost:5173`, pydantic
  schemas from `docs/ARCHITECTURE.md` (contour, notes, song status), stub
  routers for `/songs`, `/analyze`, `/duet` returning 501. `service/README.md`
  with Windows and Linux GPU setup. One pytest hitting `/health`.
  *Done when:* `uv run ruff check .` and `uv run pytest` pass.
  *Verify:* `cd service && uv run ruff check . && uv run ruff format --check . && uv run pytest`.
- [x] **P0-T4** (H) Repo plumbing: `.gitignore` (node, python, `service/cache/`,
  audio files), `.editorconfig`, `README.md` (what it is, screenshots later,
  setup in five lines), GitHub Actions CI running the front-end checks and
  the service lint and tests on push. *Done when:* CI config is valid YAML
  and mirrors the local commands. *Verify:* `npm run check` locally; CI on
  first push.
- [x] **P0-T5** (S) Scaffold review. Fresh-eyes pass over P0-T2 to P0-T4
  against `CLAUDE.md` conventions: comment headers, import order, strictness,
  no stray TODOs, commands in docs match `package.json` and `pyproject.toml`.
  Fix what is small, list what is not under this task.
  *Verify:* all checks green.
  - Follow-up: Starlette's TestClient warns that `httpx` is deprecated in
    favour of `httpx2` in the dev group. Only a warning; swap when it bites.
  - Follow-up: `numpy` and `soundfile` sit in base deps unused until P2-T1.

## Phase 1: Solo practice loop (browser only)

Goal: drop an mp3, pick a mic, sing, see your pitch live against the song.
Works with no service running.

Verification for this phase: unit tests on the DSP, plus an end-to-end
smoke in headless Chromium (`npm run e2e`, Playwright with a fake audio
capture device fed a known tone) that proves the worklet loads from the
built bundle and the tracker reports the right pitch. `e2e` stays out of
`check` and CI until Phase 5 adds a browser to CI.

- [x] **P1-T1** (S) Audio engine core. `src/audio/engine.ts`: one
  `AudioContext` at 48 kHz, master gain, output device selection via
  `setSinkId` where supported. `src/audio/player.ts`: drag-and-drop or file
  picker for mp3/wav/flac, decode to `AudioBuffer`, transport (play, pause,
  seek, loop region), position in seconds exposed through the state store.
  Tests for transport math (seek clamping, loop wrap).
- [x] **P1-T2** (S) Mic capture. `src/audio/mic.ts`: enumerate input devices,
  open the chosen one with `echoCancellation`, `noiseSuppression`, and
  `autoGainControl` all `false`, channel count 1 or 2, surface the live
  `MediaStream` and an input-level meter. Device list refreshes on
  `devicechange`. Permission errors shown in the status bar, not the console.
- [x] **P1-T3** (S) Latency calibration. `src/audio/latency.ts`: play a short
  chirp through the output, record the mic, cross-correlate to find the
  round-trip delay, repeat three times, take the median, store per
  (output, input) device pair in `localStorage`. UI: a "Calibrate" button
  with the measured value shown. Tests: synthetic signal with a known delay
  recovers it within one hop.
- [x] **P1-T4** (S) Live pitch tracker. `src/analysis/pitch-worklet.ts`
  (AudioWorklet) implementing McLeod Pitch Method on 2048-sample windows with
  a 480-sample hop (10 ms at 48 kHz), with clarity threshold for voicing.
  Posts `{t, f0, clarity}` frames to the main thread. `src/analysis/pitch.ts`
  holds the pure functions so they are unit-testable: NSDF, peak picking,
  parabolic interpolation, Hz to MIDI to cents. Tests: synthetic sines,
  sawtooth, and a vibrato tone recover frequency within 5 cents; silence
  reports unvoiced.
- [x] **P1-T5** (S) Pitch lane renderer. `src/render/pitch-lane.ts`: canvas
  that scrolls with song time, draws the live f0 trace as a ribbon coloured
  by the active skin, with a piano-key gutter, octave lines, and a playhead.
  Reference contour overlay slot (empty until Phase 2). Sized to its container
  with `ResizeObserver` and device pixel ratio.
  - Note: the P0 placeholder lane does not redraw on a bare
    `devicePixelRatio` change (window dragged between monitors). Add a
    `matchMedia('(resolution: ...)')` listener here.
- [x] **P1-T6** (S) Take recording. `src/audio/recorder.ts`: record the mic to
  a WAV blob aligned to song time with the latency offset applied. Takes
  stored in IndexedDB with song hash, date, duration, and the live f0 frames.
  Take list UI with playback of your own take mixed under the song.
- [x] **P1-T7** (S) State store and shell wiring. `src/app/state.ts`: typed
  event store (same shape as `4th-dimension`'s `StateStore`). Wire song,
  mic, calibration, tracker, lane, takes, and skin together. Keyboard
  shortcuts: space play/pause, R record, arrows seek. Status bar shows
  device names, latency, and tracker health.
- [x] **P1-T8** (F) Phase review. Orchestrator reads the diff of Phase 1,
  smoke-tests with a real mp3 and mic on the owner's machine (owner runs,
  reports), writes follow-ups into Phase 5, confirms Phase 2 briefs.
  - Done by the review worker with the E2E suite; the owner smoke test is
    still pending (Current state). Fixed in review: loop end key never
    engaged the loop; Record over a replaying take; stuck mic status without
    AudioWorklet; capture finish throwing on disconnected nodes.
  - Follow-up (P2 or P5): 'System default' mic stores `inputDeviceId` null,
    so it is not reopened after reload, and latency is keyed by requested
    ids so a default-device latency follows whatever the OS default becomes.
    Store the opened track's real deviceId and key latency by it.
  - Follow-up: `loadLatency`/`saveLatency` in `src/audio/latency.ts` are
    unused (Session keeps latency in settings). Delete them and their tests.
  - Follow-up: recording is refused while a loop is active; Phase 3 decides
    how looped practice passes are recorded (split takes at wraps).
  - Follow-up: lane only draws frames while the song plays; consider a
    free-sing warm-up mode with time-based scroll.
  - Follow-up: `RateMeter` over-reads fps for the first moments after the
    mic opens; use a 500 ms minimum span.
  - Follow-up: Takes list sits below the fold at 760 px; move above Latency.
  - Follow-up: PitchLane throws without a 2D context; degrade like audio.
  - Follow-up: settings UI for `serviceUrl` and `octaveInvariant` (P2-T5 or
    P5-T3).

- [x] **P1-T9** (S) Calibration that survives a real room. The confidence
  test compared the correlation peak with the second-highest peak, which
  room reflections defeat. Use GCC-PHAT for the lag with a first-arrival
  rule, confidence as peak over background, a longer and louder chirp with
  a pre-roll that measures the noise floor so "mic did not hear the chirp"
  is reported separately from "echo unstable", three trials that must
  agree, and the per-trial numbers in the status line. Tests with a
  synthetic room (reflections, noise, hum).
- [x] **P1-T10** (S) Speaker mode. Monitor setting `headphones | speakers`
  with a toggle beside the mic picker. In speaker mode the mic opens with
  browser echo cancellation on (it references Chrome's own playback, so
  it strips the song from the mic) while noise suppression and auto gain
  stay off. Status bar reports the mode and whether the browser honoured
  it. Default stays headphones. Documented in `docs/ARCHITECTURE.md`.
  - Phase 2 note (P2-T6): in speaker mode, gate scored frames by mic level
    above the noise floor measured at mic open, so residual bleed is not
    scored as singing. Phase 3 may add our own cancellation in the worklet
    from the known song signal and latency.
  - Follow-up: README still says headphones are required for calibration;
    reword once speaker mode is confirmed on real hardware.
  - Follow-up: an `input.opening` flag in state so Record and Calibrate
    wait during the 100 to 300 ms of a mic reopen instead of failing.
  - Follow-up: `loadLatency`/`saveLatency` in `src/audio/latency.ts` remain
    unused; delete with their tests (P1-T8 note).

## Phase 2: Song preparation and scoring

Goal: the service isolates the vocal, the app shows the reference melody and
lyrics, and scores each take against it.

- [x] **P2-T1** (S) Song intake. Service `POST /songs` accepts an audio file,
  hashes it, stores under `service/cache/<hash>/`, returns `song_id`.
  `GET /songs/{id}` reports status per step (fetch, separation, reference
  analysis, lyrics) with progress; `fetch` is `skipped` for uploads. Add
  `GET /songs/{id}/audio` serving `source.<ext>` so the browser can reload a
  cached song. Work runs in a background task queue, one job at a time to
  protect VRAM; the queue takes any callable job so P2-T1b can enqueue a
  download. Persist `meta.json` and `status.json` per `docs/ARCHITECTURE.md`
  (Song sources). Extend `SongSteps`/`SongStatus` in `schemas.py` (`fetch`,
  `title`, `duration_s`, `source`) and mirror in `types.ts` later (P2-T5).
  Tests with a tiny synthetic WAV; no models needed.
  - Done: `store.py`, `jobs.py`, `pipeline.py`, lifespan in `app.py`,
    routes in `routes/songs.py`; 183 service tests. Review (three lenses,
    probe-verified) found two real bugs, both fixed with tests that fail
    when reverted: songs queued at a restart were stranded, and a job
    raising `SystemExit` killed the worker silently.
  - `tests/conftest.py` resets every `pipeline.RUNNERS` entry to None per
    test. A task that registers a runner must register it in its own tests
    with `monkeypatch.setitem`, or tests would start real downloads/models.
  - Follow-up (P2-T1b): a re-add returns the stored status, so a `failed`
    step still reads failed while its retry is queued. Add one
    `queue_preparation(store, jobs, song_id)` in `pipeline.py` used by both
    routes and the lifespan: submit, and when accepted reset non-done
    applicable steps to `queued` (clear error/detail) before returning.
  - Follow-up: the 200 MiB limit is checked after the framework has spooled
    the body. An ASGI size guard would reject early. Low value on loopback.
  - Follow-up (P2-T2): `duration_s` is None for m4a (libsndfile cannot read
    AAC); fill it in meta and status once the audio is decoded.
- [x] **P2-T1b** (S) **YouTube intake, service. Owner priority.**
  `POST /songs/url` with `{url}` per "Song sources" in
  `docs/ARCHITECTURE.md`: host allow list, metadata lookup through yt-dlp's
  Python API without downloading, reject live and over-long videos
  (`ENCORE_MAX_SONG_S`, default 900, added to `Settings` and the README
  table), id `yt-<video id>`, repeat links are cache hits. The download is a
  queued job that fills the `fetch` step with progress (yt-dlp progress
  hook) and ends with ffmpeg writing `source.flac`. Add `yt-dlp` to base
  dependencies (pure Python, installs in CI). Check the installed yt-dlp's
  docs for its JavaScript-runtime requirement and wire the runtime on PATH
  (this machine has Node, no Deno). Errors surface in the step's `error`
  with the update hint. Tests inject a fake extractor/downloader: URL
  validation table (watch, youtu.be, shorts, music.youtube, playlist link,
  http, other hosts, junk), over-length and live rejection, cache hit,
  failure path. One manual run against a real, short, freely licensed video
  recorded in the task notes. `service/README.md` gets a YouTube section
  with the personal-use note.
  - Done: `youtube.py` (parser, canonical URL, lookup, download, ffmpeg),
    `fetch.py` (the runner), `POST /songs/url`, `queue_preparation`,
    `add_link`, `ENCORE_MAX_SONG_S`; 507 service tests. Review fixes: a
    `$` in the cache path made yt-dlp write elsewhere (now refused with a
    message); a link whose audio was lost could never be re-fetched (a done
    fetch with no audio now counts as not done). `queue_preparation` resets
    steps through an `on_accepted` hook under the queue lock, because
    reset-after-submit races the worker (a test proves the naive order
    fails).
  - Real run (2026-10-23, yt-dlp 2026.10.21, yt-dlp-ejs 0.8.0, Node 24,
    ffmpeg 9.0.2): Big Buck Bunny (CC BY) looked up in 2.2 s, fetched in
    about 6 s; repeats of youtu.be/shorts/watch forms answered in under
    15 ms with no YouTube request. Nonexistent id gave the 502 with hint;
    over-length gave the 422. The best stream was AAC 5.1, so the
    orchestrator added the stereo downmix (`aformat=mono|stereo`) with a
    real-ffmpeg test that a centre-only 5.1 tone survives in both sides.
  - Contract for P2-T1d: `SongLinkRequest {url}`; 200 SongStatus, 422 plain
    `detail` (not a link, live or unknown length, too long), 502 with the
    yt-dlp text and update hint. A fetch `error` reads "what failed: why".
    `GET /audio` answers 409 for a link whose audio is gone until it is
    added again: treat that as "add again".
  - Follow-up: Node older than 22 (or Deno older than 2.3) is skipped by
    yt-dlp without a word, so the no-runtime note never shows. Probe
    `node --version` and log the yt-dlp version and runtime at start.
  - Follow-up: a crash mid-download leaves `<song>/.fetch/` until that
    song is fetched again; `recover_interrupted` could clear it.
  - Follow-up: a cache-hit re-add skips the lookup, so a lowered
    `ENCORE_MAX_SONG_S` does not apply to songs already cached.
  - Follow-up: song folders are named by case-sensitive video ids; on
    Windows two ids differing only in case would share a folder.
    Astronomically rare; revisit only if ids ever collide.
- [ ] **P2-T1c** (S) **Play a YouTube link inside the app. Owner priority.**
  No service needed. Design in `docs/ARCHITECTURE.md` (YouTube playback in
  the app). Start with a **spike**, recorded in this task's notes before
  any wiring: a throwaway page measuring (a) whether the embed loads from
  `http://localhost:5173` with `origin` set and `referrerpolicy=
  "strict-origin-when-cross-origin"` (error 153 otherwise), (b) the step
  size and jitter of `getCurrentTime()` against `performance.now()` over 60
  s, (c) what the player reports during a pre-roll ad, (d) owner-side, with
  speakers: whether Chrome's echo cancellation removes the embed's audio
  from the mic. Go/no-go from the numbers, written down.
  - **Spike done (2026-10-23): GO.** Page served by Vite on :5180, driven
    from the built-in browser. Embed loaded from `http://localhost` on
    both `www.youtube.com` and `www.youtube-nocookie.com` with `origin`
    set and a `strict-origin-when-cross-origin` referrer meta; no onError,
    no 153. The iframe posts its time about every 267 ms (224 to 304); the
    API wrapper extrapolates between posts, so `getCurrentTime()` changes
    on every call. Over 60 s on three runs the reported clock stayed
    within 9.8, 9.9 and 13.6 ms (p95) of a straight line at 0.9995 to
    0.9999 of wall rate, with a few sub-20 ms backward corrections a
    minute. One 20 s run (nocookie) had a single ~100 ms backward slip.
    State sequence: onReady 0.3 to 0.4 s after load, buffering, playing at
    0.6 to 0.8 s. Rates 0.25 to 2. No ad appeared (pane likely signed out),
    so ad behaviour is unobserved. Unmuted autoplay without a gesture
    played in the pane, which is not what stock Chrome does.
  - Caveat: the pane was hidden (requestAnimationFrame dead, timers not
    throttled), so the numbers are indicative. Still owner-side: re-run
    on a visible pane or stock Chrome; the speaker echo test; the constant
    offset between reported time and the sound; a real pre-roll ad;
    autoplay blocked in stock Chrome.
  - Decisions from the spike (now in `docs/ARCHITECTURE.md`): privacy
    host `youtube-nocookie.com`; read `getCurrentTime()` and guard it
    (hold small backward corrections, treat big jumps and stalls as a
    discontinuity); live pitch stamped to embed time, takes recorded in
    Embedded mode marked approximate until the owner-side numbers land;
    detect ads by video id and duration; start only on the Play press.
  Then build: a link box under the dropzone and a paste handler on the
  page; pure `parseYouTubeUrl` (watch, youtu.be, shorts, embed,
  music.youtube, `t=` start; anything else is null); a `Transport`
  interface extracted from `player.ts` (state, positionS, durationS, play,
  pause, seek) with the existing player and a new `YouTubeTransport` behind
  it, so `frameToSongTime`, the lane and recording read one clock. The
  YouTube transport reads `getCurrentTime()` with the guard described
  under "Embedded clock, as measured" (the spike showed the wrapper
  already extrapolates, so no interpolation of our own). The IFrame API
  script loads only when a link is used, so the app stays offline-clean.
  The player sits in its own pane at least 480 by 270, never covered, never
  hidden, and starts on the Play press (a user gesture). Errors 2, 5, 100,
  101, 150, 153 map to plain messages. Separate stored offset for the embed
  path (calibration measures only our output). The panel says what this
  mode gives (live pitch, recording) and what it does not (reference,
  scoring, stems) until P2-T1d. Tests: URL parser table, interpolation math
  on synthetic poll sequences with known answers, error mapping; one e2e
  with the API script stubbed through Playwright routing (tests never reach
  YouTube).
  Editing `src/` and `index.html` triggers a full reload on a running dev
  server; do it while the owner is not mid-test.
- [ ] **P2-T1d** (S) **Prepare a linked song for scoring. Owner priority.**
  Needs P2-T1 and P2-T1b. New `src/service/client.ts` (service URL from
  settings; typed wrappers `createSongFromUrl`, `getSong`, `fetchSongAudio`;
  poll with backoff). With the service reachable, a linked song shows a
  "Prepare for scoring" button, and a setting (off by default; preparing is
  opt-in, see the policy flag) posts it automatically on selection;
  progress shows in the song panel. When `fetch` is done, load
  `/songs/{id}/audio` into the audio engine and switch the clock and the
  sound to it: precise clock, calibrated latency, stems later. The embed
  stays visible, muted, and is re-synced by `seekTo` when it drifts more
  than 0.5 s (checked every 2 s; the API's playback rate is only a
  suggestion, so no rate nudging). A switch mid-song keeps the position.
  Service down says so and points at the README; embedded playback keeps
  working. Tests for the client against a stubbed `fetch` (progress,
  failure, cache hit, abort on a second load via `loadToken`) and for the
  drift rule; one e2e with the service routes stubbed.
  - Note (from P2-T1): a song interrupted by a service restart has one
    `failed` step and its later steps stay `queued` until it is added
    again. Polling must treat any `failed` step as settling the song (stop
    polling, show the error and an "Add again" action), not wait for every
    step to leave `queued`.
- [ ] **P2-T2** (S) Separation. Demucs (`htdemucs_ft`) producing
  `vocals.wav` and `no_vocals.wav`. Configurable model id. Honour
  `ENCORE_DEVICE` env (`cuda` default when available).
- [ ] **P2-T3** (S) Reference contour and notes. `torchcrepe` (full model) on
  `vocals.wav` at 10 ms hop with Viterbi decoding and a confidence gate.
  Median filter for octave errors. Segment into notes (`docs/COACHING.md`
  rules). Save `reference.json` using the contour and notes schemas.
  - Follow-up (from P2-T1b): when `vocals.wav` is near silent (a karaoke
    upload linked from YouTube), mark the step `skipped` with a reason the
    browser can show, not a flat contour. Today a runner can only finish
    (done) or raise (failed): add a `StepSkipped(reason)` exception that
    `pipeline._run_step` turns into `skipped` with that detail.
- [ ] **P2-T4** (S) Lyrics. WhisperX on `vocals.wav` for word-level
  timestamps, saved as `lyrics.json`. Language auto-detected. Degrade
  gracefully when no words are found (instrumental, rap flagged as
  unpitched).
- [ ] **P2-T5** (S) Browser integration. Extend `src/service/client.ts`
  (created in P2-T1d) with the rest of the status and stem fetches. On song load, upload to the service if
  reachable, show prep progress in the song panel, and swap in the stems:
  mix slider between original, karaoke, and vocal-only guide; reference
  contour drawn in the pitch lane; lyrics line with word highlight.
  - Note: `schemas.py` nests `Features` by group (`features.intonation.
    bias_cents`, `features.timing.onset_bias_s`, ...). Mirror those helper
    models (`MidiRange`, `SongSteps`, `Alignment`, `Evidence`, the
    `*Features` groups, `VowelFormants`) in `types.ts`.
- [ ] **P2-T6** (S) Live scoring. `src/analysis/score.ts`: per-frame cents
  error against the reference (octave-invariant option for singers in a
  different register), per-note accuracy, streaks, phrase stars. Pure
  functions with tests. The lane shows hit/okay/miss colouring from the skin.
- [ ] **P2-T7** (S) Report card v1. End-of-take overlay: overall score, notes
  in tune, best streak, worst phrase (with jump-to), using the skin's
  personality copy. Stored with the take.
  - Note: add a `newRecord` copy key (Arcade's flashing "NEW RECORD") to
    `COPY_KEYS` with a Studio line when the card needs it.
- [ ] **P2-T8** (F) Phase review and Phase 3 briefs.

## Phase 3: Coaching

Goal: recommendations that are measured, specific, and honest about limits.
Design in `docs/COACHING.md`.

- [ ] **P3-T1** (S) Take analysis endpoint. `POST /analyze` with take WAV,
  `song_id`, and latency offset. Runs `torchcrepe` on the take, DTW-aligns
  the take contour to the reference, and computes the feature set:
  intonation (bias, stability, scoop, drift), timing (onset deltas), vibrato
  (rate, extent, regularity), dynamics (RMS envelope, phrase-end fade), range
  (tessitura), timbre (centroid, HNR, F1/F2 via parselmouth). Returns the
  `TakeAnalysis` schema.
- [ ] **P3-T2** (S) Rules engine. `service/encore_service/coach/rules.py`:
  each rule maps features to a recommendation with evidence (which notes,
  how far off) in two modes, *general* (absolute) and *match* (vs reference).
  Deterministic, unit-tested against synthetic feature sets.
- [ ] **P3-T3** (S) Coaching UI. Report card v2 with a "Work on this" list,
  each item linking to the moments in the take, and a toggle between general
  and match modes. Trend chips across takes of the same song.
- [ ] **P3-T4** (S) Range and key. Estimate the singer's comfortable range
  from their takes, compare to the song's, and offer a transposition. Pitch
  shift the backing stem in the browser with a SoundTouch-style WSOLA
  implementation in an AudioWorklet (tested on sines), or server-side with
  rubberband if quality is insufficient.
- [ ] **P3-T5** (H) Personality copy for coaching. Each skin gets its own
  phrasing of every rule's message, same facts, different voice.
- [ ] **P3-T6** (F) Phase review and Phase 4 briefs.

## Phase 4: Duet

Goal: two singers, scored separately, with harmony detection. Design in
`docs/DUET.md`.

- [ ] **P4-T1** (S) Two-mic mode. Two input devices (or a two-channel
  interface split) each with their own tracker, lane ribbon colour, and
  score. Device assignment UI with names ("Singer A", "Singer B", editable).
- [ ] **P4-T2** (S) Enrollment. Each singer records a 15 s glide and a
  spoken sentence. Browser computes a range profile (p05, p50, p95 of f0);
  service computes a speaker embedding (`POST /duet/enroll`). Stored per
  singer profile.
- [ ] **P4-T3** (S) One-mic live assignment. Browser-side provisional
  assignment of each voiced frame to the nearer range profile with
  hysteresis, two-candidate f0 from the NSDF when two clear peaks exist.
  Low-confidence frames drawn muted and not scored.
- [ ] **P4-T4** (S) One-mic post-take assignment. Service diarises the take
  in 0.5 s windows by embedding similarity, runs multi-pitch on overlapped
  regions, assigns contours by range prior plus continuity (Viterbi), and
  returns two contours with per-frame confidence. Replaces the provisional
  live assignment in the stored take.
- [ ] **P4-T5** (S) Duet scoring and harmony. Each singer scored on their own
  lines (manual line assignment from the lyrics view, or both scored on the
  lead). Harmony detection: both voiced, interval stable at a 3rd, 5th, 6th,
  or octave for over 300 ms, awards a harmony bonus with skin FX.
- [ ] **P4-T6** (S) Duet report card. Side-by-side cards, shared harmony
  moments, "who nailed the chorus" highlight. Playful but factual.
- [ ] **P4-T7** (F) Phase review and Phase 5 briefs.

## Phase 5: Polish and flair

- [ ] **P5-T1** (S) Skin FX. Particle system in `src/render/fx.ts` driven by
  skin config: Studio none, Arcade sparks and screen shake on streaks,
  Dreamhouse sparkles, hearts on perfect notes, glitter trail. Respects
  `prefers-reduced-motion`.
- [ ] **P5-T2** (H) Two more skins (e.g. Lounge, Y2K) via the token contract.
- [ ] **P5-T2b** (H) Self-host the Arcade and Dreamhouse display fonts
  (`@fontsource/press-start-2p`, `@fontsource/pacifico`, `@fontsource/nunito`)
  so the app matches the no-cloud rule and renders offline without a blocking
  stylesheet request. Until then `index.html` uses Google Fonts with system
  fallbacks.
- [ ] **P5-T2c** (H) Run `npm run e2e` in CI: add
  `npx playwright install --with-deps chromium` to the web job. The suite
  and the pinned `@playwright/test` are ready.
- [ ] **P5-T3** (S) Settings panel: devices, calibration, skin, scoring
  tolerance, octave-invariant toggle, service URL.
- [ ] **P5-T4** (S) Export a report card as PNG for sharing.
- [ ] **P5-T5** (F) Retrospective; Phase 6 briefs.

## Phase 6: Packaging

Goal: one installable thing. Design constraints in `docs/ARCHITECTURE.md`.

- [ ] **P6-T1** (S) Tauri shell around the built front end; settings storage
  adapter backed by the app data directory; `tauri://localhost` CORS.
- [ ] **P6-T2** (S) Service as a sidecar: bundled Python environment or a
  first-run installer that creates it; health check and start/stop from the
  app; model weights downloaded to the app data directory on first use.
- [ ] **P6-T3** (S) Installer builds for Windows first (the owner's GPU
  machine), then macOS and Linux. CI produces artifacts on tag.
- [ ] **P6-T4** (F) Retrospective; decide whether in-process ONNX models
  replace the service for a GPU-less tier.
