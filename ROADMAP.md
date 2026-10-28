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

- **Last done:** **W3** (2026-10-28): learning mode (the header toggle,
  live hit / okay / miss colours, a report card stored with each take, tips
  on request, the karaoke-track notice). Before it W2 (search and the
  karaoke core) and W1 (the reference step and the browser seams); older
  work in `docs/HISTORY.md`.
- **In progress:** none.
- **Next:** the owner's test results (list below) if they have any: fix
  what they show first, as `W0: <summary>`. Then **W4**. Search needs the
  owner's YouTube Data API key (README, "Run it"; pasted into the app,
  never into chat).
- **Blockers:** none for W4. YouTube now answers yt-dlp with "Sign in to
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

## Waves

Each wave lists what to build, the files it owns, and when it is done.
Tracks inside a wave share no files and may run in parallel.

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
- [ ] **W4: Strict and Open scoring** (owner asked, 2026-10-28). Learning
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

## Estimates (corrected 2026-10-28 after W3, light pipeline)

W1 measured about 1 hour of wall time (two workers in parallel, then
one reviewer) and about 1.0 M subagent tokens. W2 measured 1 hour and
0.94 M (two workers one after the other, one reviewer, one small fix)
against an estimate of 2 hours and 1.1 M. W3 measured about 0.7 hours
and 0.53 M (one worker at 0.36 M, one reviewer at 0.17 M, a small fix)
against 0.8 and 0.7 M: one track with a detailed brief costs about half
of a two-track wave. The rest are left as they were.

| Wave | Agent hours | Subagent tokens | Owner |
|---|---|---|---|
| W1 Seams and reference (measured) | 1 | about 1.0 M | 10 min |
| W2 Search and karaoke core (measured) | 1 | 0.94 M | 20 min, an API key |
| W3 Learning mode (measured) | 0.7 | 0.53 M | 20 min |
| W4 Strict and Open scoring | 1 (0.7-1.8) | about 0.8 M | 20 min |
| W5 Two singers | 1 (0.7-1.8) | about 0.7 M | 30 min, a second person |
| W6 Synced lyrics | 0.4 (0.3-0.8) | about 0.3 M | 5 min |
| W7 Test and sweep | 0.8 (0.6-1.5) | about 0.6 M | 45 min |
| **Total** | **about 6 (5-9)** | **about 4.9 M** | **about 2.5 h** |

The full plan this replaces was about 126 hours and 60 M tokens. The
orchestrator's own reading adds about 100 to 200 thousand tokens per wave
if it reads outlines and diffs, not whole files.
