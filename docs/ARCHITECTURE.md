# Architecture

Two processes on one machine. The browser owns everything real-time; the
Python service owns everything that needs a GPU or a big model. The app is
useful with the service down (live pitch, recording, playback) and gets
reference melody, lyrics, scoring, and coaching when it is up.

```
 browser (Vite app, :5173)                    service (FastAPI, :8765)
 ┌──────────────────────────────┐             ┌──────────────────────────────┐
 │ player  ── AudioContext ──► out│             │ POST /songs      intake+hash │
 │ mic(s) ─► worklet pitch ─► lane│  upload mp3 │  demucs ─► vocals/no_vocals  │
 │ recorder ─► WAV + f0 frames   │ ──────────► │  torchcrepe ─► reference.json│
 │ score (live, vs reference)    │ ◄────────── │  whisperx ─► lyrics.json     │
 │ report card / coaching UI     │  status,    │ POST /analyze   take features│
 │ skins, FX                     │  json, wavs │ POST /duet/*    enroll, split│
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
  afterwards. In speaker mode Phase 2 (P2-T6) gates scored frames by mic
  level above the noise floor measured at mic open, so residual bleed is not
  scored as singing, and Phase 3 may add our own cancellation in the
  worklet from the known song signal and latency.
- **Clock.** Song time is the master clock. Every mic frame is stamped with
  `context.currentTime` (the centre of its analysis window) and shifted by the
  calibrated round-trip latency so that what the singer heard at time *t* and
  what they sang at *t* line up. The shift is applied once, in
  `frameToSongTime` (`src/app/session.ts`): song time = song position now
  minus the frame's age minus the latency. A take's WAV is stored unshifted,
  with `startedAtSongS` and `latencyS` beside it, so a better calibration can
  re-align it later (`songTimeOfSample` in `src/audio/wav.ts`); its f0 frames
  are stored already on song time.
- **YouTube playback in the app.** Selecting a YouTube link plays the video
  in an embedded player (IFrame Player API) inside the app, with the singer's
  live pitch drawn as usual. It needs no service and downloads nothing.
  - *Two modes, one clock.* **Embedded:** the player supplies sound and
    picture and our song time follows its `getCurrentTime()`. **Prepared:**
    once the service has fetched and analysed the song (P2-T1d), our audio
    engine supplies the sound and the clock, and the embed becomes a muted
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
  - *Host.* `https://www.youtube-nocookie.com` (privacy-enhanced mode):
    it loads from localhost like the main host and sets no cookies until
    playback, which suits a local-first app.
  - *Latency.* Calibration measures our own output path with our chirp. The
    embed adds a path we cannot play a chirp through, so it gets its own
    setting, `embedOffsetS` (default 0, clamped to plus or minus 0.5 s),
    added to the calibrated latency in `frameToSongTime` only while the
    YouTube transport is active, with its own "YouTube video offset" field
    shown only then.
  - *Echo.* Whether Chrome's echo cancellation references the embed's audio
    in speaker mode is unverified; it needs the owner's real speakers
    before the mode is advertised for YouTube songs.
  - *Prepared mode, as built* (P2-T1d: `src/service/client.ts`,
    `src/app/prepare.ts`, `src/audio/embed-follower.ts`). Opt-in: loading
    a link sends only `GET /health` (no link data); the link goes to
    `POST /songs/url` only on the Prepare press or with
    `autoPrepareLinks` on (default off). Health is re-checked on focus, so
    starting the service enables Prepare without a reload. Polling backs off
    from 500 ms to a 2 s cap and settles when fetch is done or any step has
    failed. The switch waits for a take in progress or starting, and for
    the AudioContext clock to actually move (it can lag `resume()` by up to
    about a second; capped at 2 s), then makes the audio player the active
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
  AudioWorklet, 2048 window, 480 hop (10 ms), clarity gate at 0.9 for
  voiced. Hand-written and unit-tested; no DSP dependency. Accuracy target
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
- **Testing.** Vitest covers the DSP and logic against synthetic signals.
  `npm run e2e` drives the built app in headless Chromium with a fake mic
  (see `e2e/`); it is the only test that runs the worklets for real.
- **Rendering.** Canvas 2D for the pitch lane and FX. DOM for everything
  else. Skins are CSS custom properties plus a TS personality object
  (`docs/SKINS.md`).

## Service

- **Stack.** Python 3.11, FastAPI, uvicorn, pydantic v2. `uv` manages the
  environment. CPU deps install everywhere (CI included). The heavy models
  come in one extra per feature, each declared and installed by the task
  that needs it, so nothing is downloaded before it is used: `separation`
  (torch, torchaudio, demucs; P2-T2) now, then `pitch` (torchcrepe, P2-T3),
  `lyrics` (P2-T4), `analysis` (praat-parselmouth, librosa, P3-T1) and
  `speaker` (speechbrain, P4-T2). torch and torchaudio come from PyTorch's
  CUDA 12.8 index (cu128) and are held to 2.11: torchaudio stopped at 2.11.0,
  and CUDA 12 is what CTranslate2 (Whisper, P2-T4) supports. Install with
  `uv sync --extra separation` (name every extra; a plain `uv sync` removes
  them, `uv sync --inexact` keeps them). torchaudio 2.11's own load and save
  need torchcodec, which is not installed: read and write audio with
  soundfile and hand tensors to the models. `ENCORE_DEVICE` selects `cuda`
  or `cpu`.
- **Jobs.** One worker thread, FIFO. A 4070 Ti (12 GB) handles demucs,
  crepe, and whisper comfortably one at a time, not concurrently. Status is
  polled; no websockets needed. `jobs.py` is the queue (idempotent per song,
  survives a job that raises or exits), `pipeline.py` the steps (a runner
  registry; a step with no runner reads "skipped: Not built yet (ROADMAP
  ...)"), `store.py` the cache. On start the service marks steps a crash
  left `running` as failed ("Add the song again to retry") and resumes songs
  that were queued but never reached; a failed song is never auto-resumed,
  so a file that crashes a step cannot crash-loop the service.
- **Cache.** `service/cache/<song_id>/` holds `source.<ext>`, `meta.json`
  (title, source, url, duration), `vocals.wav`, `no_vocals.wav`,
  `reference.json`, `lyrics.json`, `status.json`. Deleting the folder
  re-prepares the song. Never committed. Uploads stream into
  `service/cache/.incoming/` and are moved into place once hashed; JSON is
  written atomically and `status.json` last, so a half-made folder is not a
  song. Only a finished `source.<ext>` from a fixed list is ever served.
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
    status for fetch, separation, reference and lyrics; progress is 0 to
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
  - *Karaoke uploads* download fine but contain no vocal. The reference
    step reports `skipped` with a reason when `vocals.wav` is near silent
    (P2-T3 follow-up) instead of drawing a flat contour.
- **Models are loaded lazily** on first use and kept resident. A `/gpu`
  endpoint reports device, VRAM, and which models are loaded.

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
               unpitched_regions: [start_s, end_s][] }
Lyrics       { words: {start_s, end_s, text, line: number}[], language }
SongStatus   { song_id, title?, duration_s?, source: file|youtube,
               steps: {fetch|separation|reference|lyrics:
               {state: queued|running|done|failed|skipped, progress, error?,
                detail?}} }                       // detail: why it skipped
TakeAnalysis { contour, notes, alignment: {offset_s, dtw_path?},
               features: Features, recommendations: Recommendation[] }
Features     see docs/COACHING.md
Recommendation { rule_id, mode: general|match, severity, message_key,
               evidence: {note_indices, value, reference_value?} }
DuetSplit    { singers: {id, contour, confidence: number[]}[],
               harmony: {start_s, end_s, interval_semitones}[] }
```

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
    Shipping both in one distributed app is a decision for the owner; for
    personal use on their own machine they are the owner's to make.
- **Two trackers.** A light live tracker in the browser for immediacy and a
  heavy one in the service for truth. Scores shown live are provisional and
  replaced by the post-take analysis.
- **Rules before language models.** Recommendations come from deterministic
  rules over measured features so they are explainable and testable. Any
  natural-language layer later only rephrases rule output.
- **No cloud.** Everything runs on the owner's machine. Stems never leave it.
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
