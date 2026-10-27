# encore

Karaoke for one or two singers. Drop in an mp3 or paste a YouTube link (it plays in YouTube's own player inside the app), pick a mic, and sing to the instrumental with the melody on screen. Karaoke mode never judges; an opt-in learning mode says plainly where pitch and timing miss and gives tips on request. Three visual skins from utilitarian to Barbie Dreamhouse. Runs locally: a browser app plus a Python service that uses the local GPU to prepare songs.

## Status

See [ROADMAP.md](./ROADMAP.md) for what to do next.

## Run it

```
npm ci                 install front end
npm run dev            Vite dev server on :5173
npm run check          typecheck + unit tests (run before every commit)
npm run build          typecheck + production build
npm run e2e            Playwright smoke in headless Chromium (builds first; see below)
cd service && uv sync  install service (CPU deps); see service/README.md for GPU
```

### End-to-end run

`npm run e2e` builds the app, serves the production bundle and drives it in
headless Chromium with a fake microphone playing a 440 Hz tone. It proves the
audio worklets load from the built bundle and the tracker, recorder, transport
and calibration behave in a real browser. It is not part of `npm run check` or
CI yet. It needs Playwright's Chromium (`npx playwright install chromium`, once);
`@playwright/test` is pinned so that browser build stays the one installed.

## Design

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — system design and request/response schemas
- [COACHING.md](./docs/COACHING.md) — feedback rules and coaching logic
- [DUET.md](./docs/DUET.md) — two singers on two mics or taking turns on one
- [SKINS.md](./docs/SKINS.md) — visual themes and personality copy
- [SESSIONS.md](./docs/SESSIONS.md) — session planning and usage limits
- [HISTORY.md](./docs/HISTORY.md) — finished roadmap tasks and their notes

## Requirements

- Node 22
- Python 3.11
- `uv` (package manager for Python)
- `ffmpeg` (audio encoding and conversion)
- An NVIDIA GPU for preparing songs (Demucs, Crepe)
- Headphones or speakers; a laptop's own mic works
