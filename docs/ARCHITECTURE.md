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
  and a recorder node. Mic is never routed to the output (headphones carry
  the song; speaker bleed would poison the analysis).
- **Mic constraints.** `echoCancellation`, `noiseSuppression`, and
  `autoGainControl` are all `false`. Browser defaults flatten dynamics and
  smear pitch onsets.
- **Clock.** Song time is the master clock. Every mic frame is stamped with
  `context.currentTime` and shifted by the calibrated round-trip latency so
  that what the singer heard at time *t* and what they sang at *t* line up.
- **Live pitch.** McLeod Pitch Method (normalised square difference) in an
  AudioWorklet, 2048 window, 480 hop (10 ms), clarity gate at 0.9 for
  voiced. Hand-written and unit-tested; no DSP dependency. Accuracy target
  5 cents on clean tones. The service re-runs a stronger tracker after the
  take; the live one only has to be good enough for display and streaks.
- **Storage.** `localStorage` for settings, skin, calibration per device
  pair. IndexedDB for takes (WAV blob, f0 frames, scores, analysis). Songs
  are not stored in the browser; the file is re-dropped or re-read from the
  service cache by hash.
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
- **Cache.** `service/cache/<sha256-of-file>/` holds `source.<ext>`,
  `vocals.wav`, `no_vocals.wav`, `reference.json`, `lyrics.json`,
  `status.json`. Deleting the folder re-prepares the song. Never committed.
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
SongStatus   { song_id, steps: {separation|reference|lyrics:
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
- **Two trackers.** A light live tracker in the browser for immediacy and a
  heavy one in the service for truth. Scores shown live are provisional and
  replaced by the post-take analysis.
- **Rules before language models.** Recommendations come from deterministic
  rules over measured features so they are explainable and testable. Any
  natural-language layer later only rephrases rule output.
- **No cloud.** Everything runs on the owner's machine. Stems never leave it.
- **Vanilla TS.** Same stack as `4th-dimension`; cheapest for workers, no
  framework churn.
