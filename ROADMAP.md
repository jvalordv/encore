# Roadmap

Each task is sized for one worker session and ends in one commit. Tier is the
model that should do it (S = Sonnet, H = Haiku, F = orchestrator). "Done when"
is the acceptance test; "Verify" is the command that proves it. Follow the
resume protocol in `CLAUDE.md`.

## Current state

- **Last done:** Phase 0 complete (P0-T1 to P0-T5). Front end: 21 tests,
  build green. Service: 25 tests, ruff clean. CI runs both on push.
- **In progress:** nothing.
- **Blockers:** none. Owner-side checks pending (see below); they do not
  block P1-T1.
- **Next:** P1-T1 (audio engine core). Start after the owner's usage reset
  (`docs/SESSIONS.md`).
- **Owner-side, when convenient:**
  - Run `npm run dev` and flip through Studio, Arcade, Dreamhouse. Nothing
    visual has been seen by a human yet: check the lane gutter, Dreamhouse
    key colours, Arcade scanlines, and that a saved non-Studio skin does
    not flash dark on reload.
  - On the GPU machine: install uv and ffmpeg, `uv sync` in `service/`,
    then follow `service/README.md` to enable the PyTorch CUDA index and
    `uv sync --extra gpu`. Confirm `GET /gpu` shows `cuda_available: true`.
    The gpu extra has never been resolved; torch pins across demucs,
    whisperx and speechbrain may need loosening.

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

- [ ] **P1-T1** (S) Audio engine core. `src/audio/engine.ts`: one
  `AudioContext` at 48 kHz, master gain, output device selection via
  `setSinkId` where supported. `src/audio/player.ts`: drag-and-drop or file
  picker for mp3/wav/flac, decode to `AudioBuffer`, transport (play, pause,
  seek, loop region), position in seconds exposed through the state store.
  Tests for transport math (seek clamping, loop wrap).
- [ ] **P1-T2** (S) Mic capture. `src/audio/mic.ts`: enumerate input devices,
  open the chosen one with `echoCancellation`, `noiseSuppression`, and
  `autoGainControl` all `false`, channel count 1 or 2, surface the live
  `MediaStream` and an input-level meter. Device list refreshes on
  `devicechange`. Permission errors shown in the status bar, not the console.
- [ ] **P1-T3** (S) Latency calibration. `src/audio/latency.ts`: play a short
  chirp through the output, record the mic, cross-correlate to find the
  round-trip delay, repeat three times, take the median, store per
  (output, input) device pair in `localStorage`. UI: a "Calibrate" button
  with the measured value shown. Tests: synthetic signal with a known delay
  recovers it within one hop.
- [ ] **P1-T4** (S) Live pitch tracker. `src/analysis/pitch-worklet.ts`
  (AudioWorklet) implementing McLeod Pitch Method on 2048-sample windows with
  a 480-sample hop (10 ms at 48 kHz), with clarity threshold for voicing.
  Posts `{t, f0, clarity}` frames to the main thread. `src/analysis/pitch.ts`
  holds the pure functions so they are unit-testable: NSDF, peak picking,
  parabolic interpolation, Hz to MIDI to cents. Tests: synthetic sines,
  sawtooth, and a vibrato tone recover frequency within 5 cents; silence
  reports unvoiced.
- [ ] **P1-T5** (S) Pitch lane renderer. `src/render/pitch-lane.ts`: canvas
  that scrolls with song time, draws the live f0 trace as a ribbon coloured
  by the active skin, with a piano-key gutter, octave lines, and a playhead.
  Reference contour overlay slot (empty until Phase 2). Sized to its container
  with `ResizeObserver` and device pixel ratio.
  - Note: the P0 placeholder lane does not redraw on a bare
    `devicePixelRatio` change (window dragged between monitors). Add a
    `matchMedia('(resolution: ...)')` listener here.
- [ ] **P1-T6** (S) Take recording. `src/audio/recorder.ts`: record the mic to
  a WAV blob aligned to song time with the latency offset applied. Takes
  stored in IndexedDB with song hash, date, duration, and the live f0 frames.
  Take list UI with playback of your own take mixed under the song.
- [ ] **P1-T7** (S) State store and shell wiring. `src/app/state.ts`: typed
  event store (same shape as `4th-dimension`'s `StateStore`). Wire song,
  mic, calibration, tracker, lane, takes, and skin together. Keyboard
  shortcuts: space play/pause, R record, arrows seek. Status bar shows
  device names, latency, and tracker health.
- [ ] **P1-T8** (F) Phase review. Orchestrator reads the diff of Phase 1,
  smoke-tests with a real mp3 and mic on the owner's machine (owner runs,
  reports), writes follow-ups into Phase 5, confirms Phase 2 briefs.

## Phase 2: Song preparation and scoring

Goal: the service isolates the vocal, the app shows the reference melody and
lyrics, and scores each take against it.

- [ ] **P2-T1** (S) Song intake. Service `POST /songs` accepts an audio file,
  hashes it, stores under `service/cache/<hash>/`, returns `song_id`.
  `GET /songs/{id}` reports status per step (separation, reference analysis,
  lyrics) with progress. Work runs in a background task queue, one job at a
  time to protect VRAM.
- [ ] **P2-T2** (S) Separation. Demucs (`htdemucs_ft`) producing
  `vocals.wav` and `no_vocals.wav`. Configurable model id. Honour
  `ENCORE_DEVICE` env (`cuda` default when available).
- [ ] **P2-T3** (S) Reference contour and notes. `torchcrepe` (full model) on
  `vocals.wav` at 10 ms hop with Viterbi decoding and a confidence gate.
  Median filter for octave errors. Segment into notes (`docs/COACHING.md`
  rules). Save `reference.json` using the contour and notes schemas.
- [ ] **P2-T4** (S) Lyrics. WhisperX on `vocals.wav` for word-level
  timestamps, saved as `lyrics.json`. Language auto-detected. Degrade
  gracefully when no words are found (instrumental, rap flagged as
  unpitched).
- [ ] **P2-T5** (S) Browser integration. `src/service/client.ts` typed
  fetch wrappers with status polling. On song load, upload to the service if
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
- [ ] **P5-T3** (S) Settings panel: devices, calibration, skin, scoring
  tolerance, octave-invariant toggle, service URL.
- [ ] **P5-T4** (S) Export a report card as PNG for sharing.
- [ ] **P5-T5** (S) Optional desktop wrapper (Tauri) that launches the service
  and the app together. Only if the two-process setup proves annoying.
- [ ] **P5-T6** (F) Retrospective; next roadmap.
