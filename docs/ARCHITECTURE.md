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
  environment. CPU deps install everywhere (CI included); the `gpu` extra
  pulls torch with CUDA, demucs, torchcrepe, whisperx, speechbrain,
  praat-parselmouth. `ENCORE_DEVICE` selects `cuda` or `cpu`.
- **Jobs.** One worker thread, FIFO. A 4070 Ti (12 GB) handles demucs,
  crepe, and whisper comfortably one at a time, not concurrently. Status is
  polled; no websockets needed.
- **Cache.** `service/cache/<song_id>/` holds `source.<ext>`, `meta.json`
  (title, source, url, duration), `vocals.wav`, `no_vocals.wav`,
  `reference.json`, `lyrics.json`, `status.json`. Deleting the folder
  re-prepares the song. Never committed.
- **Song sources.** A song enters as an uploaded file or a YouTube link;
  everything after intake is identical.
  - *File:* `POST /songs`, id is the sha256 of the bytes.
  - *Link:* `POST /songs/url` with `{url}`. The route checks the host
    against an allow list (`youtube.com`, `www.`/`m.`/`music.youtube.com`,
    `youtu.be`; https only; a playlist link means its one video), asks
    yt-dlp for metadata without downloading (video id, title, duration,
    live flag), rejects live streams and anything longer than
    `ENCORE_MAX_SONG_S` (default 900), and answers with a `SongStatus`
    whose id is `yt-<video id>`. A repeat of the same video is a cache hit.
    The metadata lookup runs in the request (a second or two); the download
    is the first job in the queue.
  - *Fetch step:* `SongStatus.steps` gains `fetch` (`skipped` for uploads).
    yt-dlp takes the best audio stream and ffmpeg normalises it to
    `source.flac`: lossless from whatever YouTube served, decodable by every
    browser, about half the size of WAV. The browser polls one status for
    fetch, separation, reference and lyrics.
  - *Safety:* yt-dlp is driven through its Python API with a fixed option
    set, never options from the request. Output goes to
    `source.%(ext)s` inside the song's own cache folder, so titles never
    become paths. `noplaylist` is always on.
  - *Failure:* YouTube changes break yt-dlp every few weeks. Its message
    goes verbatim into the fetch step's `error` with the hint to update it
    (`uv lock --upgrade-package yt-dlp && uv sync`). Tests inject a fake
    extractor, so CI never touches the network.
  - *JS runtime:* recent yt-dlp releases may need an external JavaScript
    runtime to solve YouTube's player challenges. The owner's machine has
    Node, not Deno. The worker checks the installed yt-dlp's documentation,
    wires whichever runtime is on PATH, and fails with a plain message if
    there is none.
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
               {state: queued|running|done|failed|skipped, progress, error?}} }
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
  nothing is redistributed, the cache is never committed, and YouTube's
  terms restrict downloading, which `service/README.md` says plainly.
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
