# Architecture

Two processes on one machine. The browser owns everything real-time; the
Python service owns everything that needs a GPU or a big model. The app is
useful with the service down (live pitch, recording, playback, YouTube in
the embedded player) and gets the instrumental, the reference melody and
so learning mode when it is up. Scoring and tips run in the browser.

```
 browser (Vite app, :5173)                    service (FastAPI, :8765)
 ┌──────────────────────────────┐             ┌──────────────────────────────┐
 │ player  ── AudioContext ──► out│             │ POST /songs      intake+hash │
 │ mic(s) ─► worklet pitch ─► bus│  upload mp3 │ POST /songs/url  yt-dlp fetch│
 │ bus ─► lane, recorder, score  │ ──────────► │  demucs ─► vocals/no_vocals  │
 │ learning: report card, tips   │ ◄────────── │  torchcrepe ─► reference.json│
 │ search (YouTube Data API, W2) │  status,    │                              │
 │ lyrics lookup (LRCLIB, W6)    │  json, flac │                              │
 │ skins                         │             │                              │
 └──────────────────────────────┘             └──────────────────────────────┘
          localStorage, IndexedDB                    service/cache/<hash>/
```

## Browser

- **Audio graph.** One `AudioContext` at 48 kHz. Song playback from decoded
  `AudioBuffer`s (original, or stems once prepared) through per-stem gains
  into a master gain. Mic `MediaStreamSource` into the pitch `AudioWorklet`
  and a recorder node. Mic is never routed to the output. The song reaches
  the singer through headphones, or through speakers in speaker mode (see
  Mic constraints).
- **Mic constraints.** Two modes, picked by the Monitoring toggle and saved
  as `monitor` in settings (`micConstraints` in `src/audio/mic.ts`).
  *Headphones*, the default, opens the mic raw: `echoCancellation`,
  `noiseSuppression`, and `autoGainControl` all `false`, the most accurate
  input. *Speakers* turns on `echoCancellation` alone. Chrome's canceller
  references the audio the page itself plays, so it takes the song out of
  the mic and leaves the voice, which lets someone practise without a
  headset. `noiseSuppression` and `autoGainControl` are `false` in both
  modes because they flatten dynamics and smear pitch onsets. The status bar
  says which mode is active and whether the browser honoured it
  (`describeMonitor` in `src/app/state.ts`). Switching reopens the mic and is
  refused while recording. Calibration always measures on a raw mic, since
  the canceller would remove the chirp too, and restores speaker mode
  afterwards. Every frame is also gated by level (W0): a running noise
  floor (a low percentile of the last five seconds, falling at once and
  rising slowly, never above -35 dB) and a frame must be voiced, clear and
  8 dB above it to count (`src/analysis/mic-level.ts`). The lane draws a gap
  for a frame that fails in either mode; in speaker mode such a frame is
  also made unvoiced before the take and the scorer see it, so residual
  bleed is not scored as singing. Headphone scoring is unchanged. In speaker
  mode, where the browser has the reference melody (a prepared song), it also
  compares the mic's pitch with the melody over five seconds and warns when
  it follows the song far more tightly than a singer does
  (`src/analysis/bleed.ts`); with the Karaoke stem alone the melody is not in
  the room and the check is off, and with no melody it says it cannot check.
  Phase 3 may add our own cancellation in the worklet from the known song
  signal and latency.
  The gate and bleed numbers are per-pair settings (`MicTuning` in
  `src/analysis/mic-tuning.ts`: draw margin, clarity, the bleed match window,
  share and median limit), stored as `micTuningByDevicePair` under the same
  key as the latency, clamped on load, and read by the gate
  (`isDrawable`), the take trace's gate reason and the bleed detector; a pair
  with no entry uses today's constants. The Mic check
  (`src/app/session/mic-check.ts`) is how they get tuned: it shelves the song
  in the audio player (`Player.loadTransient`), plays a synthesised 40 s
  track (`src/analysis/test-melody.ts`, whose f0 contour is the exact
  reference), records a take with `kind: 'mic-check'` and labelled sections in
  its trace (export version 3), restores the song, and posts the take to
  `POST /takes/analyse`. The service's recommended values are applied only on
  the singer's press of Use these settings.
- **Clock.** Song time is the master clock. Every mic frame is stamped with
  `context.currentTime` (the centre of its analysis window) and shifted by the
  calibrated round-trip latency so that what the singer heard at time *t* and
  what they sang at *t* line up. The shift is applied once, in
  `frameToSongTime` (`src/app/session/helpers.ts`): song time = song position
  now minus the frame's age minus the latency. A take's WAV is stored unshifted,
  with `startedAtSongS` and `latencyS` beside it, so a better calibration can
  re-align it later (`songTimeOfSample` in `src/audio/wav.ts`); its f0 frames
  are stored already on song time.
- **YouTube playback in the app.** Selecting a YouTube link plays the video
  in an embedded player (IFrame Player API) inside the app, with the singer's
  live pitch drawn as usual. It needs no service and downloads nothing.
  - *Two modes, one clock.* **Embedded:** the player supplies sound and
    picture and our song time follows its `getCurrentTime()`. **Prepared:**
    once the service holds a recording of the song's sound and has analysed
    it (P2-T1d, W10a), our audio engine supplies the sound and the clock, and the embed becomes a muted
    picture re-synced to it. Coaching wins ties (CLAUDE.md): the engine has a
    sample-accurate clock, a calibrated output latency, and stems; the
    embed's audio cannot be routed through Web Audio (cross-origin), cannot
    have its vocal removed, and `getCurrentTime()` has no documented
    accuracy, so scoring only ever runs on the engine clock.
  - *One transport interface.* `Transport` (state, positionS, durationS,
    play, pause, seek) has two implementations, the audio player and
    `YouTubeTransport`. Everything downstream (`frameToSongTime`, the lane,
    recording) reads the active transport.
  - *Embedded clock, as measured* (P2-T1c spike). The iframe posts its time
    about every 267 ms and the API wrapper extrapolates between posts, so
    `getCurrentTime()` is already smooth: steady-state p95 within about
    10 to 14 ms of a straight line, with occasional backward corrections
    under 20 ms and a rare stall of about 100 ms. `YouTubeTransport` reads
    it on every query and guards it: while playing, a backward step of up
    to 250 ms is held (position does not go backwards; it waits for the
    clock to catch up); a jump beyond 250 ms either way, or no advance for
    more than 300 ms of wall time while the state says playing, is a
    discontinuity, handled like a seek. Paused or buffering reports the
    raw value.
  - *What Embedded mode claims.* Live pitch is stamped to embed time. A
    take recorded in Embedded mode carries `clock: "embed"` and the UI
    calls its alignment approximate, until the owner-side timing on a
    visible page and the constant output offset are measured; then this
    line is revisited.
  - *Host (owner, 2026-11-06).* `https://www.youtube.com` (`EMBED_HOST`).
    It was `www.youtube-nocookie.com` (privacy-enhanced mode) until
    YouTube began asking this machine to "sign in to confirm you're not a
    bot". The no-cookie host never receives the youtube.com sign-in, so
    signing in looped back to the same check. The main host gets the
    sign-in and clears it; the cost is YouTube's usual cookies once a video
    plays.
  - *Latency.* Calibration measures our own output path with our chirp. The
    embed adds a path we cannot play a chirp through, so it gets its own
    setting, `embedOffsetS` (default 0, clamped to plus or minus 0.5 s),
    added to the calibrated latency in `frameToSongTime` only while the
    YouTube transport is active, with its own "YouTube video offset" field
    shown only then.
  - *Echo.* Whether Chrome's echo cancellation references the embed's audio
    in speaker mode is unverified; it needs the owner's real speakers
    before the mode is advertised for YouTube songs.
  - *Recording the song's sound* (WL3a: `src/audio/tab-capture.ts`,
    `src/audio/capture-assembler.ts`, `src/app/capture.ts`,
    `src/app/session/capture.ts`; service `routes/capture.py`; reached
    through the Song reference card, W9). Since W10a it is the only way a
    YouTube song gets a melody: Encore no longer asks the service to download
    a link (the owner, 2026-11-08, after YouTube's bot check kept blocking it).
    Opt-in: it starts on the singer's next Play or Record press (a user
    gesture) after Get the melody, or after the Settings switch armed it,
    which asks for a tab share (`getDisplayMedia`, audio on), drops the
    video track at once, seeks the embed to 0 and plays it once the share
    is answered, so the recording runs alongside the first take and no
    separate play-through is needed. It keeps recording while the video
    plays and ends with the video, or on Stop at 90% or more (also when a
    take ends with that much heard). The tab's audio runs through the
    capture worklet as PCM; each block is placed at its video
    time (the embed clock's position minus the block's age) only while the
    state is `playing`, so an ad, buffering or a pause adds nothing, and a
    seek writes at the new position. The assembler reports coverage and the
    largest gap; the video ending, or Stop at 90% or more, encodes a 16-bit
    WAV and posts it to `POST /songs/url/{id}/capture`, which stores it as
    `yt-<id>` with `audio_source: "capture"` and the fetch step done. The
    browser then reads that song back with `GET /songs/yt-<id>` and takes it
    over (below). A song that already had audio keeps it as the source and the
    capture is stored as `capture.wav` beside it (the response says
    `alongside`), for a later cross-check. The capture is the tab's output,
    not the mic, and is never routed to the speakers. Tests use
    `?captureFake` (a tone in place of the share).
  - *Prepared mode, as built* (P2-T1d, trimmed by W10a:
    `src/service/client.ts`, `src/app/prepare.ts`,
    `src/audio/embed-follower.ts`). The link is never sent to the service
    (`POST /songs/url` has no caller in the app; the route stays in the
    service, unused, and a ROADMAP follow-up deletes it). Loading a link sends
    only `GET /health` (no link data), and health is re-checked on focus, so
    starting the service enables the button without a reload. The prepared
    flow starts after a recording was uploaded: `adoptHeldSong` reads
    `GET /songs/yt-<id>`, polls with a backoff from 500 ms to a 2 s cap until
    the fetch step is done or any step has failed, and fetches the audio; the
    audio the service lost is reported at once, not asked for again. The
    switch waits for a take in progress or starting, and for the AudioContext
    clock to actually move (it can lag `resume()` by up to about a second;
    capped at 2 s), then makes the audio player the active
    transport at the embed's position, keyed `yt-<id>` so takes over the
    embed and over the prepared audio share one list (prepared takes carry
    `clock: "engine"`; `embedOffsetS` no longer applies). The embed is
    muted, stays visible, and follows: engine play, pause, seek, stop and
    loop are copied to it; every 2 s a drift over 0.5 s is corrected with
    `seekTo`; nothing in it feeds the engine clock. YouTube's own controls
    are copied back to the engine through the same guards as the app's,
    ignoring echoes of our own commands for 800 ms and the embed's own loop
    wraps. The picture starts when the sound's clock moves, and a picture
    already running is joined, not pulled back. With the sound now in the
    AudioContext, speaker mode's echo cancellation references it.
  - *Lifecycle, as built* (`src/audio/youtube-transport.ts`). A link is
    cued, not autoplayed. A seek on a cued player would start playback, so
    the transport re-cues at the new position instead. A video that cannot
    play here fails 150 to 250 ms after `onReady` with the state still
    unstarted, so a load is only "ready" after a short settle window. A new
    link replaces the current song only once it has loaded; a failed link
    keeps the old song and says so. Starting the video from YouTube's own
    controls goes through the same guards as the app's Play (no playback
    during calibration, the saved mic reopened). The player sits in
    `#stage` above the pitch lane and is torn down (player, listeners,
    timers) when a file is dropped.
  - *Player rules we follow* (YouTube's required minimum functionality): at
    least 480 by 270, never covered by overlays, never hidden while playing,
    started by a user gesture, one auto-playing player per page. The IFrame
    script loads only when a link is used.
  - *Embed failures.* Error 153 means no Referer reached YouTube, so the
    page keeps a referrer policy of `strict-origin-when-cross-origin`, the
    iframe sets `origin`, and a desktop shell must serve the app from a
    scheme that sends a Referer (unverified for Tauri's custom scheme;
    check in P6-T1). Errors 101 and 150 come both from videos whose owner
    disables embedding and, as the live check showed, from ids that do not
    exist, so the message says either may be the cause. P2-T1d offers
    Prepared mode for them when the service is up.
  - *Ads.* A pre-roll ad plays inside the embed. No ad appeared in the
    spike, so its reporting is unobserved: the transport treats
    `getVideoData().video_id` differing from the requested id, or the
    duration changing mid-play, as an ad. During one it reports state `ad`
    (not playing): nothing is stamped or recorded, and the lane says so.
  - *Autoplay.* Playback starts only on the Play press (a user gesture);
    `onAutoplayBlocked` gets a plain message. The spike's pane allowed
    unmuted autoplay, which stock Chrome does not, so nothing relies on it.
- **Live pitch.** McLeod Pitch Method (normalised square difference) in an
  AudioWorklet, 2048 window, 480 hop (10 ms), clarity gate at 0.85 for
  voiced, search floor 90 Hz, behind a 120 Hz high-pass that only the
  tracker hears (the recorder stays raw). Frames within 0.1 of the gate
  keep their pitch as `faintF0` and are drawn as a pale trace on the lane
  (never scored, graded or stored in the take). Hand-written and unit-tested; no DSP dependency. Accuracy target
  5 cents on clean tones. The service re-runs a stronger tracker after the
  take; the live one only has to be good enough for display and streaks.
- **Storage.** `localStorage` for settings, skin, calibration per device
  pair: one JSON object under `encore.settings` (devices, service URL,
  clarity gate, `latencyByDevicePair`) and the skin id under `encore.skin`.
  IndexedDB database `encore`, store `takes`, for takes (WAV blob, f0 frames,
  alignment fields, later scores and analysis). Songs are not stored in the
  browser; the file is re-dropped, or re-read from the service cache by song
  id (`GET /songs/{id}/audio`).
  Both stores sit behind adapters and fall back to memory when the browser
  refuses them.
  *Singer profiles (W8).* The list lives under its own key, `encore.profiles`
  (`{ list: [{ id, name, colour }], activeId, secondId, legacyId }`), behind
  the same key-value interface, not inside `settings`, so a settings reset
  keeps the singers. A take records `profileId` (singer A) and, for a duet,
  `profileIdB` and `voicedFramesB` at the top level of the record (they
  survive a re-score, and a karaoke-mode duet take has no `duet` part to
  carry them). A take without `profileId` is the profile in `legacyId`, the
  one the first run made, so no stored take is rewritten; a Mic check take
  is the mic's and nobody's. Progress, the streak (`daysSung`), stars,
  personal bests and the range estimate read `takesOfProfile(takes, id,
  legacyId)` (`src/app/profiles.ts`), which for a duet take reads B's
  report and B's voiced frames for B. Deleting a profile either removes the
  takes it sang as singer A through `TakeStore.remove` or, when the singer
  chooses to keep them, rewrites those takes' `profileId` to the reserved
  `NO_SINGER` (`'none'`) through `TakeStore.setSingers`; B's side of any
  duet take of the deleted singer is marked the same way in `profileIdB`.
  The marker is an explicit "nobody", distinct from the absent field (which
  is `legacyId`'s): `ownerOf` gives such a take no owner, so it is on no
  profile's list, Progress, streak, stars, bests or range, and only the
  takes list's "All singers" shows it, named "No singer". No profile can
  have the id `'none'` (`sanitizeList` drops one). The first
  run builds the list from the W5 `settings.duet` names and colours;
  afterwards `duet.names` and `duet.colours` are only a mirror of the two
  slots' profiles.
- **Testing.** Vitest covers the DSP and logic against synthetic signals.
  `npm run e2e` drives the built app in headless Chromium with a fake mic
  (see `e2e/`); it is the only test that runs the worklets for real.
- **Rendering.** Canvas 2D for the pitch lane and FX. DOM for everything
  else. Skins are CSS custom properties plus a TS personality object
  (`docs/SKINS.md`).
- **Session and controllers.** `Session` (`src/app/session.ts`) is the only
  thing the UI calls, and stays a thin facade: every intent delegates to one
  controller in `src/app/session/`. They share a `SessionCore` (`core.ts`)
  that is built from injected parts: the `StateStore`, the settings storage
  and object, the audio parts (`buildParts` in `parts.ts` makes the real
  ones, tests hand in fakes, see `test/session-harness.ts`), the take store,
  the lane and the frame bus. The controllers reach each other through the
  core (`core.songs`, `core.takes`, ...):
  - `songs.ts`, `SongController`: load a file or a link, the active
    transport, the embed lifecycle and the load token (a newer load wins),
    copying the transport into the store and lane, the ad notice.
  - `playback.ts`, `PlaybackController`: play, pause, stop, seek, nudge and
    the loop A/B controls, each a guard over the active transport.
  - `prepare.ts`, `PrepareController`: the service probe, taking over the
    uploaded recording of the linked video and the switch to prepared audio,
    with the embed follower. After the switch it hands the song's status to
    `stems.follow`. It never sends a link to the service.
  - `ingest.ts`, `IngestController`: songs dropped or chosen together
    (below, "Songs dropped together"). The pure queue and its words are in
    `src/app/ingest.ts`; the panel under the drop zone is
    `panels/ingest.ts`.
  - `stems.ts`, `StemsController`: the karaoke track of the song in use. A
    dropped file is sent to `POST /songs` once it has loaded (after a health
    check, in the background; with the service away the song plays as before
    and the panel says so in one line, and a return to the window asks
    again), a prepared recording is followed from its status. Either way it
    polls through separation, downloads and decodes both stems into the mix,
    polls through the reference step and puts the melody on the lane. One
    run belongs to one song: a newer song taking over (`reset`) aborts the
    upload and the polling through their `AbortSignal`, and a late result is
    turned away by `isCurrent` (epoch, signal and the Player's song key). A
    load that fails leaves the old song and its track as they were.
  - `mix.ts`, `MixController`: the stems it put into the Player and which of
    them are heard. See Stems and the mix, below.
  - `input.ts`, `InputController`: the mic, headphone or speaker mode, the
    tracker connection, and turning tracker frames into song-time frames.
  - `devices.ts`, `DeviceController`: device lists, the output choice.
  - `latency.ts`, `LatencyController`: calibration, stored latency, the
    embed offset.
  - `takes.ts`, `TakeController`: record, save, replay (under the song, or
    by itself under a video) and delete.
  - `scoring.ts`, `ScoringController`: learning mode in the session. It
    owns the practice mode (`setMode`), the melody scored against, the live
    scorer on the frame bus, and the report a finished take gets. See
    Learning mode, below.
  - `loop.ts`, `TickLoop`: the per-frame loop that moves the lane and writes
    position, level and tracker health.
  Pure helpers (frame-to-song-time, loop button maths, replay indexing) are
  in `helpers.ts`. A controller owns its state; what another controller
  needs of it is a public field or method with a doc line, never a reach
  into a private.
- **Frame bus.** `FrameBus` (`session/frame-bus.ts`) is where a pitch frame,
  once on song time, is announced as `{ singer, frame }` (singer 0 until a
  second mic exists). The input controller publishes; subscribers are called
  in subscription order. Today the take recorder (collecting the frames saved
  with a take) and the live scorer (`LiveScorer`, below) subscribe; the scorer
  grades each frame and feeds the pitch lane (unless a take is replaying and
  owns the lane). A second mic (W5) subscribes here and adds nothing to the
  input controller. `AppState.singers` holds one entry per singer (its mic
  state, mirrored from `input` for singer 0), and `AppState.mode` mirrors the
  `mode` setting (`'karaoke'` by default, or `'learning'`).
  `AppState.profiles` is the singer list, singer A (the active singer, whose
  progress every view shows) and B's slot; `AppState.profileDialog` says
  which in-app singer dialog is open. `ProfilesController`
  (`session/profiles.ts`) owns them: it mirrors the two slots into `duet`,
  refuses changes while recording, and the Library and key controllers
  re-read the active singer's numbers when `profiles` changes. The header
  and Singers panel dropdowns share `panels/profile-select.ts`; the dialogs
  are `panels/profile-dialog.ts`; Progress is a right-edge drawer
  (`panels/progress.ts`, dismissal rules in `app/drawer.ts`).
  *Hover help (W8b).* `src/app/hover-help.ts` is one document-level
  listener: any element with `data-help="..."` gets a styled popup after
  about 400 ms of mouse rest or keyboard focus, hidden by leave, blur,
  Escape, a press or a scroll, placed beside the element and clamped into
  the viewport (`stepHelp` and `placeHelp` are pure and tested). The text is
  attached with `aria-describedby` on entering, so a screen reader hears it
  without the delay. It replaces native `title` tooltips, which the app no
  longer uses for help. `settings.hoverHelp` (default on, mirrored in
  `AppState.hoverHelp`, in the settings file, and turned back on by Reset)
  switches it off; aria-labels are untouched. The popup uses existing skin
  tokens (`--color-text` on `--color-bg`, `--color-accent`, `--radius`,
  `--shadow`), so no token was added. It never says anything about the
  singing; "tips" stays the name for learning-mode coaching.
- **Left panel chrome (W11).** `src/app/panels/left-panel.ts` adds two
  things to markup other files own. (1) A title with `data-info` and
  `data-help` gets an (i) button and an inline note with the same words
  (one open at a time, Escape or a second press closes, works with Hover
  help off); a panel changes the words by changing `data-help`, and an empty
  one hides the button (the Song reference title in karaoke mode). (2) The
  `#panel-resizer` separator in the gap beside `#song-panel` resizes the
  panel by pointer capture (rAF-throttled) or keys, and folds it into the
  `#panel-rail` icon strip. The width reaches CSS as `--panel-w` on `#app`
  (the grid's first column), so the stage fills the rest and `PitchLane`'s own
  ResizeObserver re-measures the canvas. The limits, drag threshold, key steps
  and stored-text parsing are pure in `src/app/panel-layout.ts`. The layout
  lives under `encore.panel`, outside the state store (it is a per-screen
  view choice, like the skin); since W12 it is also carried by the settings
  export (`get`, `set` and `reset` on the mounted panel), so Reset all and an
  import restore it. Colours come from existing skin tokens.
- **Remembered panel choices (W12).** The small choices a singer makes in
  the panels (the Library's list, All singers switch and open song rows, the
  Takes list's singer filter, the Progress picker, whether the search key
  box is open, the Mic check's voice range, the backing notes toggle and
  Save with backing) are one typed record, `UiChoices` in
  `src/app/ui-choices.ts`, stored as `encore.ui` through the Session's
  settings store and mirrored in `state.ui`. It is validated on read field by
  field, so a damaged or older value falls back to its default alone. The
  Session's `UiChoicesController` writes it (`session.setUiChoices`); panels
  read `state.ui` and keep no copy, so Reset all and an import move the
  panels without help. The Library's list and the backing toggle also live in
  their controllers' state; those controllers write the record and
  `UiChoicesController.replace` applies it back to them. Transient on
  purpose: an open drawer or dialog, a playing replay, a pending delete
  confirmation, the search text and results, the open (i) note, the mix
  choice (per song) and the search chips (derived from the practice mode).
- **What the settings export carries (W12).** `src/app/settings-io.ts`:
  the `Settings` object, the skin, the auto-advance choice, the singer
  profiles, the song panel's layout and the `UiChoices`; no takes, library,
  lyrics or song data, and the search key only when asked. Import reads only
  known fields, keeps what a file lacks (an older file has no `layout` or
  `ui`), ignores unknown fields inside them, and Reset all puts all of it
  back to the defaults except the profiles.
- **Library Replay (W12).** Replay of a take whose song is not loaded opens
  that song through the same loaders as Open (a file back from the service
  by its id, a link as a video), keeping the drawer up, and plays the take
  when it is ready (`LibraryController.replayTake`); a song that cannot be
  loaded leaves the song in use and says so in one line.
- **Pitch lane layers.** `PitchLane` (`src/render/pitch-lane.ts`) owns the
  canvas, the resize and skin listeners and the redraw loop, and composes
  layers back to front, each a function over a `LaneView` and a `LaneStyle`:
  `lane-grid.ts` (rows, octave lines, piano gutter; cached offscreen),
  `lane-reference.ts` (the reference melody, below), `lane-ribbon.ts` (one
  call per singer), `lane-overlay.ts` (notice or invitation, playhead, and in learning mode
  the hit, okay and miss colours painted over the ribbon from each frame's
  optional `grade`, with the skin's `--color-hit`, `--color-okay` and
  `--color-miss`). Pure arithmetic is in `lane-geometry.ts`, the redraw
  loop and pixel-ratio watcher in `lane-clock.ts`, the skin colours in
  `lane-style.ts`. `pitch-lane.ts` re-exports the pure helpers.
- **Stems and the mix** (W2b). The service's stems are the song times a
  factor `g` (`X-Stem-Gain`, at most 1, so they cannot clip). The Player
  holds the original (its `original` stem) and, once they arrive,
  `no_vocals` and `vocals`, all playing in step from the same anchor. A mix is
  only a level per stem (`mixLevels` in `src/app/mix.ts`, pure and tested):
  *Original* plays the original at `g`; *Karaoke* the instrumental at unity;
  *Karaoke with a vocal guide* adds the vocal at the slider's level
  (`guideLevel` in settings, through `sanitizeSettings`). The stems are never
  scaled up, and the original is brought down to their level, so a mix change
  does not change the loudness. Karaoke becomes the selection when the stems
  arrive, also mid-song: they are added silent (`Player.addStem` takes a
  level), then raised as the original falls, both starting `STEM_LEAD_S` from
  now, so the song carries on at the same position with no restart and no
  step. A switch of mix is a gain move smoothed over 10 ms. A take replayed
  over the song lowers the whole mix (`MixController.setDucked`) instead of
  only the original, so it works in every mix; loop, seek and recording act
  on the transport and never see the mix. `AppState` carries `karaoke` (the
  phase of the track, the upload's progress and the service's steps),
  `mix` (`available`, `choice`, `guideLevel`) and `reference` (`phase`,
  `notes`, `message`); the karaoke panel draws them through the pure
  `describeKaraoke`.
- **The reference melody on the lane.** `laneReferenceOf`
  (`src/app/reference.ts`) turns the service's `Reference` into a
  `LaneReference`: the contour, the notes (`onsetS`, `offsetS`, `midi`) and
  the unpitched regions, the last two sorted. `drawReference` paints, back to
  front: a quiet tint of the muted text colour across the lane's height over
  each unpitched region (sound with no note sung), the contour as a soft
  band, and the notes as bars (3 px at the narrowest, 70% of a semitone row
  high) in the skin's reference colour. The in-view notes and regions are
  found by a binary search (`overlappingRange`), and the bar and tint
  rectangles come from `noteRect` and `regionRect`, all pure. Loading a
  melody fits the lane's rows to it, and removing it puts the rows back.
  A skipped reference leaves the lane without targets and the panel shows
  its `detail`. Nothing here depends on the singing: karaoke mode draws no
  scores, colours or misses, and learning mode's hit colours are the overlay
  layer's.
- **Panels.** New UI is a panel in `src/app/panels/<name>.ts` exporting a
  mount function `(host, deps) => dispose` (the types are in
  `panels/panel.ts`); `ui.ts` only composes panels. Existing UI stays in
  `ui.ts` until a wave has reason to move it. The first is the karaoke
  panel (`panels/karaoke.ts`, mounted on `#karaoke` in the song panel): the
  upload and step progress lines, the one line that says what is missing when
  the service is away, the melody line, the mix buttons and the guide slider.
  The search panel is below. Learning mode adds three: the mode toggle
  (`panels/mode.ts`, in the header), the takes list (`panels/takes.ts`, moved
  out of `ui.ts`, with a Report button in learning mode) and the learning
  panel (`panels/report.ts`, on `#report` in the song panel).
- **Learning mode** (W3). Karaoke mode computes, stores and shows nothing
  about the singing; everything below runs only when `settings.mode` is
  `'learning'`.
  - *Measurement* is pure and lives in `src/analysis/`. `phrases.ts` is the
    one phrase splitter (a rest of 0.6 s or more starts a phrase; W4 and W5
    reuse it). `take-notes.ts` segments a take into sung notes by the same
    rule as the service's `melody.py`, on a 10 ms grid. `score.ts` grades a
    frame against the reference note under it (error in cents, folded into
    +-600 c when `octaveInvariant` is on; hit within 25 c, okay within 50 c,
    else miss; frames outside any note or inside an unpitched region are not
    scored), `LiveScorer` does that for each frame on the bus, and
    `reportTake` measures a whole take: per reference note the mean and
    spread of the error, the scoop, the onset delta against the sung note
    that overlaps it most, and the held length; per take the in-tune rate
    (share of the notes sung, those with at least 50 ms of voiced frames
    inside, whose mean error is within 50 c), the timing bias (median onset
    delta), the worst three phrases (mean absolute error over 25 c, at least
    200 ms scored) and the song and sung ranges (p10 to p90). Frames on the
    bus are already on song time with the latency taken off, so nothing here
    shifts time.
  - *Tips* are `src/coach/tips.ts`: one pure rule per tip over the report,
    every threshold in `TIP_THRESHOLDS`, wording from COACHING.md, at most
    three, strongest first (how far past its threshold), each with evidence
    and a jump-to.
  - *The session* (`session/scoring.ts`) gives the lane its frames (graded
    in learning mode, ungraded otherwise), sets the mode (and the search chip
    with it), and attaches `report` to a take as it is saved, when there is a
    melody and the song is not a karaoke track. `TakeSummary.report` is
    optional, so takes saved before W3 still load. `AppState` carries `mode`,
    `reportTakeId` (the open card) and `pickedResult` (the search result that
    became the song, whose Karaoke badge makes it a karaoke track; so does a
    reference skipped for "No singing found").
  - *The screen* is `src/app/learning.ts` (karaoke-track rule, the notice,
    which card is open) and `src/app/report.ts` (the card's sentences), both
    pure and tested; `panels/report.ts` draws them. The card's Jump seeks the
    song, Replay plays the take from there (`playTake(id, fromS)`).
- **Song search** (W2a: `src/search/`, `src/app/search.ts`,
  `src/app/session/search.ts`, `src/app/panels/search.ts`). The provider seam:
  a `SearchProvider` takes `{text, filter}` (`'karaoke'` or `'original'`) and
  an abort signal and returns a `SearchOutcome`, either `{ok: true, results}`
  or `{ok: false, error: {code, message}}`; it never throws. Codes: `no-key`,
  `bad-key`, `restricted` (a referrer or API block), `quota`, `network`,
  `failed` and `aborted`, each with a sentence in plain words that never holds
  the key. `createSearchProvider(settings)` in `src/search/index.ts` is the
  only reader of the `searchProvider` setting (today only `'youtube'`); a
  provider that calls a server holding the key, for a public app, is one more
  case there and nothing else changes. The YouTube provider calls the Data API
  v3 straight from the page with the key in `youtubeApiKey`: `search.list`
  (`part=snippet`, `type=video`, `videoEmbeddable=true`, `maxResults=12`; 100
  units), then one `videos.list` (`part=contentDetails`; 1 unit) for the
  lengths, which are a nicety, so a failure there only drops the numbers. The
  pure pieces are tested on their own: ISO 8601 durations, the karaoke or
  original classifier (title and channel words, known karaoke channels), the
  query for the chip (Karaoke versions adds "karaoke"; Originals adds
  `-karaoke`, unless the words ask for it), `findOriginalQuery` (a karaoke
  title without its karaoke words, bracketed tags, `|` tag lines and the
  channel's name, keeping an "Originally performed by" artist), the key's
  shape, error reading and HTML entities in titles. The state is
  `AppState.search` (`open`, `filter`, `query`, `phase`, `results`,
  `errorCode`, `message`, `hasKey`, `quotaSpent`, `originalOf`) written by the
  Session's `SearchController` through `searchSongs`, `setSearchFilter`,
  `setSearchOpen`, `setSearchKey`, `pickResult` and `findOriginal`; the panel
  only draws it. With no key, or once the quota is spent (`quotaExceeded`,
  `dailyLimitExceeded`; remembered until the page reloads or a key is saved),
  `searchSongs` opens `https://www.youtube.com/results?search_query=...` with
  `window.open(url, '_blank', 'noopener')`, before anything is awaited so it
  stays inside the click. A pick goes down `loadLink`, the path of a pasted
  link. The search is what `#stage` shows with no song and on request with one
  (the Search button in the song panel); the lane stays under it at a fixed
  height so the mic and the pitch readout work before a song is picked. The
  key is kept in the settings blob through the storage adapter, shown nowhere
  once saved, and goes only to Google. `Session.findOriginal({title, channel})`
  is what W3's learning mode calls for a karaoke track.
- **Service client additions** (W2b). `ServiceClient` gains `uploadSong`
  (XMLHttpRequest in `src/service/upload.ts`, because `fetch` has no upload
  progress), `fetchStem` (bytes and the gain from the header, which the
  service lets a page on another origin read) and `fetchReference`
  (checked by `isReference` in `src/service/wire.ts` before the lane sees
  it), all abortable. `pollSong` takes `through: <step>` and then ends when
  every step up to it is done, skipped or failed (`settledThrough`; a failure
  ends the wait early since the steps after it stay queued), instead of at
  the fetch. `types.ts` mirrors `Reference`, `Contour` and `Note`; the
  lyrics step stays in the types but no panel line names it.

## Service

- **Stack.** Python 3.11, FastAPI, uvicorn, pydantic v2. `uv` manages the
  environment. CPU deps install everywhere (CI included). The heavy models
  come in one extra per feature, each declared and installed by the task
  that needs it, so nothing is downloaded before it is used: `separation`
  (torch, torchaudio, demucs, julius; P2-T2) and `pitch` (torch, torchaudio,
  torchcrepe; W1a).
  Extras for Whisper lyrics, take analysis and speaker embeddings are
  Later. torch and torchaudio come from PyTorch's
  CUDA 12.8 index (cu128) and are held to 2.11: torchaudio stopped at 2.11.0,
  and CUDA 12 is what CTranslate2 (Whisper, if it comes) supports. Install with
  `uv sync --extra separation` (name every extra; a plain `uv sync` removes
  them, `uv sync --inexact` keeps them). torchaudio 2.11's own load and save
  need torchcodec, which is not installed: read and write audio with
  soundfile and hand tensors to the models. `ENCORE_DEVICE` selects `cuda`
  or `cpu`.
- **Jobs.** One worker thread, FIFO. A 4070 Ti (12 GB) handles demucs and
  crepe comfortably one at a time, not concurrently. Status is
  polled; no websockets needed. `jobs.py` is the queue (idempotent per song,
  survives a job that raises or exits), `pipeline.py` the steps (a runner
  registry; a step with no runner reads "skipped: Not built yet (ROADMAP
  ...)"), `store.py` the cache. On start the service marks steps a crash
  left `running` as failed ("Add the song again to retry") and resumes songs
  that were queued but never reached; a failed song is never auto-resumed,
  so a file that crashes a step cannot crash-loop the service.
- **Cache.** `service/cache/<song_id>/` holds `source.<ext>`, `meta.json`
  (title, source, url, duration, `stem_gain`), `vocals.flac`,
  `no_vocals.flac`, `key.json`, `reference.json`, `lyrics.json`,
  `status.json`.
  Deleting the folder re-prepares the song. Never committed. Uploads stream
  into `service/cache/.incoming/` and are moved into place once hashed; JSON
  is written atomically and `status.json` last, so a half-made folder is not
  a song. Only a finished `source.<ext>` from a fixed list is ever served,
  and only the two stem names are served from `GET /songs/{id}/stems/{stem}`.
  Scratch folders (`.fetch/`, `.separate/`) live inside the song's folder
  and are removed whatever happens.
- **Separation** (P2-T2, `separation.py`). demucs `htdemucs_ft`
  (`ENCORE_DEMUCS_MODEL`) through its Python API, normalised and segmented
  as the demucs command does; audio in and out with soundfile, ffmpeg only
  to decode what libsndfile cannot. Stems are 24-bit FLAC at the model's
  44.1 kHz (the source may be 48 kHz: downstream timing uses each file's
  own rate and frame count). `vocals` is the model's vocal source,
  `no_vocals` the sum of the rest. If their joint peak would clip, both are
  scaled by one factor, `stem_gain` in meta.json and the `X-Stem-Gain`
  header: divide a stem by it for the song's own level. Stems are model
  estimates, not an exact split: on a sung song they add back to the mix
  within about -21 dB, but sound effects and content above about 16 kHz are
  dropped (-12 dB on a film soundtrack). Without the `separation` extra the
  step is skipped with the install hint (`StepSkipped`, which any runner
  can raise). On the 4070 Ti: about 14 times real time, 1.4 GB VRAM peak,
  about 0.6 GB RAM per minute of audio.
- **Reference** (W1a, `reference.py` and `melody.py`). Reads `vocals.flac`
  (mono mix), and first asks whether anyone sings: the share of 1 s windows
  above -40 dBFS once divided by `stem_gain` (see Karaoke uploads below);
  under 15% the step skips with a reason, before any model is loaded. Then
  torchcrepe (full, weights bundled) tracks the pitch at 16 kHz, a frame per
  10 ms, Viterbi decoded in chunks of 6 s with 1 s of context; frame `i` is
  at `i * 0.01` s. `melody.py` (plain numpy, tested on synthetic tracks)
  gates frames under 0.3 confidence, median-filters (5 frames), mends brief
  octave slips, segments notes by the rule in `docs/COACHING.md`, and finds
  the range and the unpitched regions (sounding, no note). Written whole as
  compact `reference.json`, served by `GET /songs/{id}/reference` (409 when
  there is none). The model sits behind a `PitchTracker` protocol, so unit
  tests never load it. Without the `pitch` extra a sung song is skipped with
  the install hint. The `lyrics` step is a runner that always skips: "Lyrics
  come from a lookup in the app".
  The `key` step (`key.py`, numpy, before the reference) estimates the
  song's key from `no_vocals` for every song: a tuning offset, chroma over
  8 s windows against the 24 Krumhansl-Kessler profiles, Viterbi smoothing,
  and a confidence gate under which a segment is "key unclear". Written as
  `key.json` (`KeyMap`), served by `GET /songs/{id}/key`.
- **Song sources.** A song enters as an uploaded file or a YouTube link;
  everything after intake is identical.
  - *File:* `POST /songs`, id is the sha256 of the bytes.
  - *Link:* `POST /songs/url` with `{url}`. `youtube.parse_youtube_url`
    takes https or scheme-less links on exactly `youtube.com`,
    `www.`/`m.`/`music.youtube.com`, `youtu.be` and
    `www.youtube-nocookie.com` (ASCII hosts, no userinfo, no port), with
    `/watch?v=`, `/shorts/`, `/embed/`, `/live/`, `/v/` or a youtu.be path;
    a playlist link means its one video. Only the rebuilt
    `https://www.youtube.com/watch?v=<id>` ever reaches yt-dlp, so no other
    extractor or host can be reached. The route asks yt-dlp for metadata
    without downloading, rejects live, upcoming and unknown-length videos
    and anything longer than `ENCORE_MAX_SONG_S` (default 900) with a 422,
    answers yt-dlp failures with a 502, and returns a `SongStatus` whose id
    is `yt-<video id>`. A repeat of the same video is a cache hit with no
    lookup. The lookup runs in the request (about 2 s); the download is the
    first job in the queue. `src/audio/youtube-url.ts` applies the same
    rules in the browser (P2-T1c), checked against the same table.
  - *Fetch step:* `SongStatus.steps` gains `fetch` (`skipped` for uploads).
    `fetch.py` downloads the best audio stream into `<song>/.fetch/` as
    `download.<ext>`, has ffmpeg write 16-bit FLAC there, and moves it into
    place as `source.flac` in one step; `.fetch` is removed whatever
    happens. ffmpeg folds anything over two channels down to stereo
    (`aformat=channel_layouts=mono|stereo`): YouTube's best stream can be
    5.1, with the vocal in the centre channel that keeping two channels
    would drop. A 10.6 min video fetched in about 6 s. The browser polls one
    status for fetch, separation, key, reference and lyrics; progress is 0 to
    0.85 downloading, 0.95 converted, 1.0 saved.
  - *Safety:* yt-dlp is driven through its Python API with a fixed option
    set, never options from the request; `noplaylist` is always on; titles
    never become paths. ffmpeg runs from an argument list, never a shell.
    yt-dlp expands `$NAME` in output paths, so a cache folder with a `$` in
    it is refused with a message rather than written elsewhere.
  - *Failure:* YouTube changes break yt-dlp every few weeks. Its message
    goes into the fetch step's `error` as "<what failed>: <why>" with the
    hint to update it (`uv lock --upgrade-package yt-dlp && uv sync
    --inexact`, which keeps the installed model extras). Tests
    inject fakes, so CI never touches the network.
  - *JS runtime (checked against yt-dlp 2026.10.21):* full YouTube support
    needs `yt-dlp-ejs` plus a JavaScript runtime (Deno, Node, Bun or
    QuickJS). The dependency is `yt-dlp[default]`, which pins a matching
    `yt-dlp-ejs`, and the service passes whichever of Deno and Node is on
    PATH (Node here). Without one yt-dlp falls back to a reduced mode that
    still worked for the test video but offers fewer formats; failures then
    carry a note saying no runtime was found.
  - *Align step* (WL3b: `align.py`, `align_reference.py`, `align_job.py`,
    `routes/align.py`; browser `src/app/align.ts`, `src/app/session/align.ts`).
    Not a preparation step but a job on the same queue, run on request:
    `POST /songs/{karaoke_id}/align` with `{original_id}` (422 with a plain
    reason when a song has no audio or the original no melody). `align.py` is
    numpy only: 12-bin chroma (STFT window 186 ms, hop 46 ms, band 65 Hz to
    2.1 kHz, log-compressed, unit length per frame, silence flat), a search
    of the 12 circular key shifts at about 1200 frames, then banded DTW
    (Sakoe-Chiba, half width 20 % of the longer side, +0.2 on non-diagonal
    steps, free start and end on either axis, filled by anti-diagonals so
    it is vectorised; inputs over 6000 frames are pooled) at full resolution
    for the winning shift. The result is a monotone time map karaoke seconds
    to original seconds, `key_offset` (semitones to raise the original,
    -6..5) and a confidence: fit (mean frame cost, 0.3 good to 0.7 bad)
    times tempo (share of 10 s windows with slope in 0.8 to 1.25, 0.6 for
    full marks) times coverage (0.6 of the karaoke for full marks). The floor
    is 0.5. `align_reference.py` maps the original's contour (resampled onto
    the karaoke clock, unvoiced outside the map), notes, regions and range
    through the map, shifts pitches by the offset, and rotates the key map's
    tonics (written only when the karaoke song has no key of its own).
    `SongStatus.alignment` (`queued|running|done|refused|failed`, progress,
    `original_id`, `key_offset`, `confidence`, `reason`) is what the browser
    polls (`pollAlignment`); on `done` it fetches the reference again and
    `state.reference.alignedFrom` makes the track one to score
    (`isKaraokeTrack`). A refusal writes nothing.
  - *Capture cross-check* (WL3b). When a song has `source.*` and
    `capture.wav`, `check_capture` runs the same chroma alignment (no key
    search) as a job queued by the capture route and records
    `capture_offset_s` in the status: the median of capture time minus
    download time, set only at confidence 0.6 or more. The browser does not
    use it yet; it is there for suggesting an `embedOffsetS`.
  - *Karaoke uploads* download fine but contain no vocal. The reference
    step reports `skipped` with a reason when `vocals.flac` holds no
    singing (the reference step) instead of drawing a flat contour. Measured: a global
    vocals-to-mix level ratio cannot tell (-17 dB on a film with no
    singing, -10 dB on a sung song); the share of 1 s windows with the
    vocal stem above -40 dBFS can (3.5% versus 81%).
- **Models are loaded lazily** on first use and kept resident, in the one
  registry in `registry.py` (family, name, device). A `/gpu` endpoint
  reports device, VRAM, and which models are loaded as `family:name@device`
  (`demucs:htdemucs_ft@cuda`, `crepe:full@cuda`).

## Shared schemas

The service defines these as pydantic models; `src/service/types.ts` mirrors
them by hand (small enough that codegen is not worth a dependency).

```
Contour      { hop_s: 0.01, t0_s: number, f0_hz: number[],  // 0 = unvoiced
               confidence: number[] }
Note         { onset_s, offset_s, midi: number,              // fractional
               cents_mean, cents_std, scoop_cents, vibrato?: Vibrato }
Vibrato      { rate_hz, extent_cents, regularity }
Reference    { contour: Contour, notes: Note[], range: {low_midi, high_midi},
               unpitched_regions: [start_s, end_s][],
               aligned_from?, key_offset?, confidence? }  // WL3b: borrowed
KeyMap       { tuning_cents: number,         // [-50, 50): the instrumental's
                                               // offset from A=440 equal temperament
               segments: KeySegment[] }       // time order, contiguous, 0 to the
                                              // stem's duration; neighbours differ
KeySegment   { start_s, end_s, tonic: 0..11 | null,  // C = 0, C# = 1 ... B = 11;
               mode: major|minor | null,             // null = key unclear (both)
               confidence: 0..1 }            // always present; the service has
                                             // applied its gate, so null tonic
                                             // means under it
Lyrics       { lines: {start_s, text}[], source: lrclib|pasted }  // W6,
               browser only
SongStatus   { song_id, title?, duration_s?, source: file|youtube,
               audio_source?, steps: {fetch|separation|key|reference|lyrics:
               {state: queued|running|done|failed|skipped, progress, error?,
                detail?}},                        // detail: why it skipped
               alignment?: {state: queued|running|done|refused|failed,
               progress, original_id, key_offset?, confidence?, reason?},
               capture_offset_s? }                // WL3b
```

`TakeAnalysis`, `Features`, `Recommendation` and `DuetSplit` were planned
for service-side take analysis and voice-split duets; both are Later
(`ROADMAP.md`). `schemas.py` still defines them; nothing in the browser
mirrors them. The `lyrics` step stays in `SongStatus` as a stub that
always skips.

## Decisions

- **Separation over karaoke videos.** Demucs on the owner's own mp3 gives a
  backing track and the reference vocal in one step. Karaoke videos give
  neither a reference nor analysable audio.
- **YouTube links are a first-class source.** Dropping an mp3 is not the
  only way in: pasting a link to the original recording must work and run
  the same pipeline (owner priority, "very important"). Link the original
  track, not a karaoke upload: separation needs a real vocal to produce the
  reference. It is for the owner's own practice on their own machine:
  nothing is redistributed and the cache is never committed.
  - *Two paths, kept separable.* Playing a link in the embedded player is
    the ordinary use of YouTube's player. Preparing a link (yt-dlp, then
    separation) is not: YouTube's developer policies for the embedded
    player forbid downloading or caching its content (III.E.1.a),
    separating its audio (III.I.7), and retrieving its data by means other
    than the API (III.I.14), and its general terms restrict downloading.
    Preparing is therefore opt-in, labelled as such in the UI and in
    `service/README.md`, and the embedded path never depends on it.
    Since W10a the app does not download at all: the download was the part that
    YouTube's bot check kept refusing and that the policies above forbid
    most plainly, so it was removed from the app (the owner, 2026-11-08: "if
    this doesn't work at all, then I don't see any reason to keep it as an
    option"). What remains is the singer's own recording of the song's sound.
    Opting in is one early, clear choice (W9, owner 2026-11-08), the
    **Song reference** card in the song panel (`src/app/song-reference.ts`,
    `src/app/panels/song-reference.ts`, `src/app/session/song-reference.ts`).
    It states what Encore has for the song (melody: none, from this video,
    from the original; key: none, from the song, from the singing) and
    what that means for learning mode, with one button, "Get the melody".
    The button arms the recording of the song's sound for the next Play or
    Record press and says so in plain words ("Encore will record the song's
    sound while you sing your first take"); nothing is downloaded and no
    service text is shown. In learning mode a YouTube song with no melody
    opens the card with a prompt ("Get the melody so learning mode can
    score you?", Not now, Do this for every song). That checkbox is the
    Settings switch "Get the song reference automatically" (off by default,
    saved and exported with the settings); with it on, loading a song in
    learning mode arms the recording without the prompt, so the first Play or
    Record asks for the share. A browser that cannot share a tab's sound is
    told so and asked nothing. "Not now" is kept per song for the session.
    Karaoke mode never prompts and never arms by itself; the button is there
    if the singer wants the karaoke track. When the melody arrives (recording,
    or an aligned original), earlier learning takes whose report had no melody
    are scored again from their stored frames; when only the song's key
    arrives, earlier learning takes whose voice was not judged on the song's
    key are scored again against it (karaoke takes have no report and stay
    as they are). The Library marks each song Melody, Key or Backing.
    "Find the original" no longer offers to use a video as the original (that
    needed the service to download it); it still searches for the original so
    it can be loaded as a song of its own.
    Shipping the recording in one distributed app is a decision for the owner;
    for personal use on their own machine it is the owner's to make.
- **Songs dropped together (W10a, owner 2026-11-08).** The song panel runs
  top to bottom: Search for a song, Add a YouTube link, then the drop zone for
  audio files. The drop zone and the file picker take several files. Each
  audio file is added to the Library, and with the service running it is
  uploaded and analysed up front (separation into stems, key, melody), one
  file at a time, so a song is ready before it is opened. The first file of a
  drop loads and plays at once, as one dropped file always has, and its
  analysis is the stems controller's own; the rest are analysed in the
  background without touching the song in use, and files dropped while the
  queue runs join its end. ONE bar and one line under the drop zone
  ("Analysing 2 of 5: name (separating)") show the whole queue; a song that
  fails is named with a plain reason and the others go on, and a file that is
  not audio is skipped with a line. With no service the songs are still added
  and the bar says once that the analysis needs it. Each finished song gets its
  Melody, Key or Backing badge. The queue's rules are pure
  (`src/app/ingest.ts`, `test/ingest.test.ts`).
- **Takes per song in the Library (W10b, owner 2026-11-08).**
  `state.library.takes` holds the summaries of every song take (never the WAVs), read by the
  Library controller when the drawer opens, a take is saved, deleted or
  re-scored, or the singer changes. `src/app/song-takes.ts` is the pure
  part (whose takes count, grouping by song, the "N takes · last sung"
  line, a take's learning-mode share and stars); the panel's Replay,
  Open and Delete call the takes controller's own replay and delete and
  the Library's load, and karaoke mode never asks for the figures.
- **Two modes (owner, 2026-10-27; note guide added 2026-11-05).** Karaoke
  mode is the default and shows no scores, misses or tips; it judges nothing
  unless the singer turns the note guide on. The note guide is an opt-in,
  neutral readout (the nearest note and how many cents sharp or flat, against
  the song's key where there is one, chromatic otherwise, smoothed): no
  colour, no grade, nothing stored with a take
  (`src/analysis/note-guide.ts`). Learning mode is opt-in, scores against the
  reference and is direct about misses; tips appear on request. Scoring may
  run in both modes, but nothing from it renders in karaoke mode.
- **One tracker for scoring (2026-10-27, replaces "two trackers").** The
  browser's live tracker scores the take, aligned by the calibrated
  latency. Its scores are final. A heavier service re-analysis (crepe on
  the take, DTW) is Later; the cost of building it outweighed what it
  adds for this goal.
- **A frame bus.** The tracker publishes `{ singer, frame }`; the recorder,
  the live scorer (which feeds the lane) and a second mic subscribe. New consumers never edit
  the session controllers.
- **Duets without voice recognition (2026-10-27).** Two mics when there
  are two; on one mic the app assigns phrases to singers (`docs/DUET.md`).
  Enrollment and voice splitting are Later.
- **Lyrics by lookup, not transcription (2026-10-27).** Line-synced lyrics
  from LRCLIB on request, or pasted. Whisper is Later: its stack conflicts
  with our torch (`ROADMAP.md`, Later).
- **Rules before language models.** Recommendations come from deterministic
  rules over measured features so they are explainable and testable. Any
  natural-language layer later only rephrases rule output.
- **No cloud.** Everything runs on the owner's machine. Stems and takes
  never leave it. Two lookups send only what the user typed or the song's
  title and artist, and only when asked: YouTube search (W2) and lyrics
  (LRCLIB, W6).
- **Search through YouTube's official API (owner, 2026-10-27).** The
  browser calls the YouTube Data API v3 with the owner's own key from
  settings; the free quota is about 100 searches a day. Without a key a
  button opens YouTube's search in a tab and a pasted link still works.
  No keyless backend for now (Later: yt-dlp search through the service).
  Search sits behind a provider interface, so a public app can send it to
  a server that holds the key instead (`ROADMAP.md`, Later, Public app).
- **Karaoke videos sing, originals teach.** A karaoke track has no vocal,
  so there is nothing to take a reference melody from. Karaoke mode plays
  any video, karaoke versions best. Learning mode needs the original
  recording: picking a karaoke track there says the singer is on their own
  and offers to find the original, which is then sung over its own
  separated instrumental. Scoring against an original while following the
  karaoke video needs alignment and is Later.
- **Vanilla TS.** Same stack as `4th-dimension`; cheapest for workers, no
  framework churn.
- **Built to become an app.** The target shell is Tauri (Windows, macOS,
  Linux) wrapping this front end, with the Python service launched as a
  sidecar or replaced module by module with in-process ONNX models. Mobile
  is out of scope while the service needs a desktop GPU. Constraints that
  apply from Phase 1 on:
  - Web platform APIs only, feature-detected. `setSinkId` and AudioWorklet
    are Chromium/WebView2 features; degrade, do not crash, on WebKit.
  - The service is optional. Every feature that needs it checks
    reachability and says what is missing; nothing blocks on it.
  - Service URL, device ids, and calibration live in one settings object
    with a storage adapter, so a native shell can own storage later. The skin
    sits beside it under its own key because `index.html` applies it before
    any script runs.
  - CORS allow list includes `tauri://localhost` and `http://tauri.localhost`.
  - Model weights are downloaded at first use into a user data directory,
    never bundled.
  - No Node-only or Vite-only runtime assumptions in `src/`; build-time
    helpers (`?worker&url`) are fine.
