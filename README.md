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

### Testing the mic

Claude Desktop's built-in browser pane blocks the microphone. To try the mic,
the level meter or the note guide, run `npm run dev` and open
`http://localhost:5173` in a normal browser (Chrome or Edge). Under the Devices
panel the meter shows where the room's noise floor sits and whether the mic is
hearing you; in speaker mode it also says if the mic seems to be hearing the
song through the speakers. Each take has Save WAV and Save JSON buttons for
handing a take over for analysis.

### Mic check

Under Latency, **Mic check** runs a 40-second guided check of your room and
mic: 5 s of quiet, 10 s of a test melody through your speakers while you stay
silent, 15 s singing along, and 10 s singing alone. It records like a take
(it is saved, with Save WAV and Save JSON) and then asks the service to
analyse it, so start the service first (`cd service && uv run uvicorn
encore_service.app:app --port 8765`; see `service/README.md`). The result card
lists what it found and the values it would change; **Use these settings**
stores them for the current microphone and output pair, and **Reset to
defaults** takes them back. Without the service the steps still run and the
recording is kept. It talks about the mic and the room only, never your
singing, and works in karaoke mode. To watch it quickly in a test build, open
the page with `?micCheckScale=0.2` to shorten every step to a fifth.

### Capture for learning

When the downloader cannot fetch a YouTube video (YouTube often answers
yt-dlp with a bot check), the song panel's **Capture for learning** records
the video's own sound from this tab instead. Press it, choose this tab in the
share dialog with "Share tab audio" on, and let the video play through once;
Stop is on offer once 90% has been heard. The sound is recorded as PCM (no
lossy step), placed by the video's clock so ads, buffering and pauses add
nothing, and sent to the local service, which prepares it like any linked song
for the melody and key. It needs Chrome or Edge and the service. It is opt-in
and in the same policy category as Prepare: it uses the video's audio beyond
YouTube's player, and the README makes no claim that it complies. A song that
was also downloaded keeps the download as its audio and stores the capture
beside it. The end-to-end run opens the page with `?captureFake`, which swaps
the tab share for a tone, since a headless browser cannot pick a tab.

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
(a pasted link always works, unless the video's owner blocks playing it
outside YouTube; Encore checks first and says so). YouTube's own results
include such videos; a key makes Search show only videos that play here.

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

### Lyrics

The song panel's Lyrics group looks a song up on [LRCLIB](https://lrclib.net)
(free, no key) by the title and artist it guesses from the file or video name,
which you can correct, or reads an `.lrc` file or plain text you paste or drop.
Only the title, artist and length are sent. Synced lines show over the lane and
follow the song (nudge 0.1 s either way if they run early or late); plain text
is shown without timing. The line is off by default on a Karaoke-badged video,
which usually shows lyrics already, and on for other songs once lines exist.
Lyrics are cached per song in this browser. LRCLIB is fine for personal use;
a public release needs a licence for lyrics (see Later, Public app in the
roadmap).

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
