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

### Search for songs (YouTube API key)

The app opens on a search for the song to sing. To search inside the app you
need your own YouTube Data API key; without one, Search opens YouTube's own
results in a new tab and you paste the link of what you pick into the link box
(a pasted link always works).

1. In the [Google Cloud console](https://console.cloud.google.com/) create or
   pick a project and enable **YouTube Data API v3** for it (APIs & Services,
   Library).
2. Create an API key (APIs & Services, Credentials, Create credentials, API
   key).
3. Restrict it: under API restrictions choose **YouTube Data API v3** only, and
   under Application restrictions choose Websites with
   `http://localhost:5173/*` (the address `npm run dev` serves; add another
   only if you serve the app from somewhere else).
4. Paste the key into the **YouTube API key** field at the bottom of the
   search panel and press Save key. It is kept in this browser's storage and
   goes only to Google; it is never sent to the Python service or shared.

The free quota is 10,000 units a day and one search costs 101, so about 100
searches a day. When it is spent the panel says so and Search opens YouTube's
own page instead until the quota resets (midnight Pacific time).

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
