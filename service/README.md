# encore service

The local half of encore. A FastAPI app that does the work the browser cannot:
vocal separation (demucs), reference pitch tracking (torchcrepe), word-level
lyrics (whisperx), take analysis, and speaker embeddings for duets. It runs on
your machine and your audio never leaves it. The browser app works without it
(live pitch, recording, playback); with it you also get the reference melody,
lyrics, scoring and coaching. See `../docs/ARCHITECTURE.md`.

Status: songs can be added (`POST /songs`, `POST /songs/url`,
`GET /songs/{id}`, `GET /songs/{id}/audio`): uploads are hashed, cached and
queued for preparation, a link to a YouTube video is looked up, cached and its
audio fetched (see "YouTube links"), and `/health` and `/gpu` work. The other
preparation steps (separation, reference pitch, lyrics) arrive in ROADMAP
Phase 2, so for now each reports `skipped` with a "Not built yet" note.
`/analyze` and `/duet/*` are stubs that answer 501 until Phases 3 and 4.

## Setup

You need [uv](https://docs.astral.sh/uv/) and Python 3.11 (uv fetches the
Python for you if it is missing).

Install uv:

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

```sh
# Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then, from this folder:

```
uv sync
uv run pytest
```

`uv sync` installs the CPU dependencies, which is all the skeleton needs.
Adding a song from a YouTube link also needs ffmpeg and Node (or Deno) on
PATH, even without a GPU extra: see "YouTube links".

## GPU setup

Needed from Phase 2 on. The heavy models come as one extra per feature, so
each is installed when its ROADMAP task starts and nothing big is downloaded
before it is used. The target is an NVIDIA card such as the 4070 Ti with a
current driver.

| Extra | Holds | Needed by |
|---|---|---|
| `separation` | torch, torchaudio, demucs | P2-T2, vocal separation. The only one declared so far. |
| `pitch` | torch, torchcrepe | P2-T3, the reference melody. P3-T1 uses it on takes too. |
| `lyrics` | torch, torchaudio, whisperx | P2-T4, word-level lyrics. |
| `analysis` | praat-parselmouth, librosa | P3-T1, take analysis. |
| `speaker` | torch, torchaudio, speechbrain | P4-T2, speaker embeddings for duets. |

The task that needs an extra adds it to `pyproject.toml`, where a comment
lists what each will hold. Declaring them all now would make `uv lock` resolve
and pin every package today.

1. **ffmpeg.** demucs and whisperx call it to read audio, and so does the
   YouTube fetch step, to write the downloaded audio as FLAC. It must be on
   PATH. Windows: `winget install ffmpeg` (or download a build and add it to
   PATH). Linux: `sudo apt install ffmpeg` or your distro's equivalent. Check
   with `ffmpeg -version` in a new terminal.
2. **An NVIDIA driver, no CUDA toolkit.** The PyTorch wheels carry their own
   CUDA runtime. `nvidia-smi` prints the newest CUDA version the driver
   supports in its header (13.4 on the 4070 Ti machine). The build chosen in
   step 3, CUDA 12.8, needs 12.8 or newer.
3. **PyTorch CUDA wheels.** torch from PyPI is CPU-only on Windows, so
   `pyproject.toml` points torch and torchaudio at PyTorch's own index for
   CUDA 12.8, `https://download.pytorch.org/whl/cu128`, and holds both to
   2.11. They have to match: torchaudio's last release is 2.11.0 and its wheel
   does not say which torch it was built for, so uv would otherwise pair it
   with a newer torch unchecked. CUDA 12 rather than the newer cu130 because
   the lyrics step (P2-T4) will run Whisper through CTranslate2, which
   supports CUDA 12 only. On a driver that reports CUDA 12.8 or newer there is
   nothing to edit. On an older one, change `cu128` in the `[[tool.uv.index]]`
   URL to `cu126`, which carries the same 2.11 pair (the current list is at
   https://pytorch.org/get-started/locally/), then run `uv lock`. The same
   index serves Linux.
4. **Install the extras you need:**

   ```
   uv sync --extra separation
   ```

   When more extras exist, repeat the flag, as in
   `uv sync --extra separation --extra pitch`, or install every one with
   `uv sync --all-extras`. Name them every time. `uv sync` makes the
   environment match exactly what it is asked for, so a plain `uv sync`
   **removes** torch and every other extra. To refresh the base dependencies
   and keep the extras, use `uv sync --inexact`; `uv run` keeps them too.

   Sizes, measured on Windows 10 with Python 3.11: the download is about
   1.9 GB, almost all of it torch's wheel (the CUDA libraries are inside),
   and took about a minute. Installed, torch takes 2.6 GiB and the whole
   `.venv` 2.8 GiB. uv keeps one copy of each package in its cache and
   hard-links it into `.venv`, so the drive loses about 3 GiB, not twice that;
   this needs the project and uv's cache (`uv cache dir`) on the same drive.

   demucs is the PyPI release 4.1.0. It asks only for torch (torchaudio is in
   its training extra) and does not hold it back.
5. **Check it.** Start the service (below) and open
   <http://localhost:8765/gpu>. You want `"torch_available": true` and
   `"cuda_available": true` with your card's name and VRAM; the 4070 Ti
   reports `"device_name":"NVIDIA GeForce RTX 4070 Ti"` and
   `"vram_total_mb":12281`. If torch is available but CUDA is not, you got the
   CPU wheels: `uv pip list` should show `torch 2.11.0+cu128`, with the
   `+cu128`. Without it, revisit step 3.
6. **Model weights** are not part of the install. Each downloads the first
   time its model is used, then stays in a cache; your audio is never
   uploaded. demucs asks the Hugging Face hub first, so its weights land in
   that cache (`~/.cache/huggingface/hub`, or `HF_HOME`), and it falls back to
   PyTorch's hub cache (`~/.cache/torch/hub/checkpoints`, or `TORCH_HOME`) for
   the older model repository. On Windows `~` is your user folder. The
   default `htdemucs` is 84 MB; `htdemucs_ft`, the model ROADMAP P2-T2 names,
   is four of them, 336 MB.

## Run

```
uv run python -m encore_service
```

This serves on 127.0.0.1 at `ENCORE_PORT` (default 8765). For auto-reload
while developing:

```
uv run uvicorn encore_service.app:app --reload --port 8765
```

The interactive API docs are at <http://localhost:8765/docs>.

## Songs

The browser adds a song, then polls it while the service prepares it.

| Endpoint | What it does |
|---|---|
| `POST /songs` | Upload an audio file as the multipart field `file` (mp3, wav, flac, m4a, ogg or opus, up to 200 MiB). The song's id is the sha256 of its bytes, so adding the same file again is a cache hit that queues whatever has not finished. Answers with the song's status. |
| `POST /songs/url` | Add a YouTube video by link: a JSON body `{"url": "..."}`. The song's id is `yt-` and the video's id, so adding the same video again is a cache hit that asks YouTube nothing and queues whatever has not finished. Answers with the song's status. See "YouTube links". |
| `GET /songs/{id}` | The song's status: `title`, `duration_s`, and for each step (`fetch`, `separation`, `reference`, `lyrics`) a `state` (`queued`, `running`, `done`, `failed` or `skipped`), a `progress` from 0 to 1, an `error` when it failed and a `detail` saying why it was skipped. 404 for an unknown id. |
| `GET /songs/{id}/audio` | The stored source file, so the browser can reload a song without the original. 404 for an unknown id, 409 while the song has no source audio. |

Songs are prepared one at a time in a background queue, so two songs never
compete for GPU memory. `fetch` is `skipped` for uploads, which arrive with
their audio, and is the download for a link. A step whose model is not built
yet is `skipped` with a "Not built yet" detail naming the ROADMAP task; add
the song again after that task lands and the step runs.

The cache is under `service/cache` (or `ENCORE_CACHE_DIR`), one folder per song:

```
<song_id>/source.<ext>   the audio, as uploaded; source.flac for a link
<song_id>/meta.json      title, duration, where it came from
<song_id>/status.json    the state of each step
<song_id>/.fetch/        a link's download while it is under way
.incoming/               uploads still arriving
```

Deleting a song's folder makes the service forget it; add the file again to
prepare it afresh. If only the audio file is gone, adding the same file again
puts it back. If the service stops while a step is running, that step shows as
`failed` ("Interrupted ...") after the next start; add the song again to retry
it. A song that was still waiting in the queue when the service stopped is
queued again at the next start, so it is not left as `queued` for good. A song
with a `failed` step is never resumed on its own: add it again.

## YouTube links

`POST /songs/url` adds a song from a link to one YouTube video, so the
original recording can be practised without hunting for a file. Send
`{"url": "https://www.youtube.com/watch?v=..."}`. The service:

1. Reads the video id out of the link. It accepts `youtube.com`, `www.`,
   `m.` and `music.youtube.com`, `youtu.be` and `youtube-nocookie.com` links
   over https, with or without the scheme, to a watch, Shorts, embed, live or
   `/v/` page. Other parameters such as `list=` and `t=` are ignored, so a
   playlist link means its one video. Anything else (a playlist page, a
   channel, plain http, another site) is refused with 422. yt-dlp is never
   handed the text that was pasted, only `https://www.youtube.com/watch?v=<id>`.
2. Asks yt-dlp what the video is, without downloading it. A live stream, a
   premiere, a video of unknown length and a video longer than
   `ENCORE_MAX_SONG_S` (15 minutes by default) are refused with 422. If
   YouTube or yt-dlp cannot answer, the answer is 502 with yt-dlp's message.
3. Makes the song `yt-<video id>` and queues it. The first job is the `fetch`
   step: it downloads the best audio stream into the song's folder and has
   ffmpeg write it as `source.flac`, lossless from whatever YouTube served and
   decodable by every browser. Its progress shows in the `fetch` step. When
   it is done the song has its audio like an uploaded one, and the other steps
   follow.

Adding the same video again is a cache hit: nothing is asked of YouTube, and
every step that failed or did not finish is queued again. A failed fetch
keeps the reason in its `error`, in the form "what failed: why".

What the service needs on PATH, beyond `uv sync`:

- **ffmpeg**, installed as in "GPU setup", step 1. A link needs it even
  without a GPU extra. Without it the fetch step fails and says so.
- **A JavaScript runtime**: Node 22 or newer, or Deno 2.3 or newer. YouTube
  guards its stream addresses with challenges that yt-dlp solves by running
  YouTube's own player script in an external runtime, together with the
  `yt-dlp-ejs` package, which `uv sync` installs. The service passes yt-dlp
  whichever of Deno and Node it finds on PATH; yt-dlp prefers Deno. Without
  any, yt-dlp falls back to a reduced mode that it calls deprecated, in which
  some formats are missing, and a failure then says that no runtime was
  found. yt-dlp counts Node as less isolated than Deno, since it runs a
  script from the internet. It starts Node with its permission flag, which
  denies the script file and process access, but Deno is the safer choice.

When links stop working: YouTube changes break yt-dlp every few weeks. Update
it and restart the service (the error shown to the person says the same):

```
cd service
uv lock --upgrade-package yt-dlp
uv sync
```

With GPU extras installed, finish with `uv sync --inexact` instead: a plain
`uv sync` would remove them (see "GPU setup", step 4).

**Read this before you use it.** Preparing a link downloads the video's audio
and separates it into stems. YouTube's terms restrict downloading, and the
developer policies for its embedded player forbid downloading and caching its
content (III.E.1.a), separating its audio (III.I.7) and retrieving its data by
any means other than its API (III.I.14). That is why this path is opt-in in
the app: playing a link in the embedded player needs no service and downloads
nothing, and a song is prepared for scoring only when the person asks for it.
It exists for your own practice, on your own machine. Nothing is redistributed:
the cache is never committed and stems never leave the machine. Whether to use
it is your decision, and the service prepares only what it is asked to.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `ENCORE_DEVICE` | `cuda` if torch sees CUDA, else `cpu` | Device for the models. |
| `ENCORE_CACHE_DIR` | `service/cache` | Where songs and their stems are stored. For YouTube links the path must not hold a `$` that yt-dlp would expand, such as `$HOME`; the fetch step fails and says so. |
| `ENCORE_PORT` | `8765` | Port for `python -m encore_service`. |
| `ENCORE_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated origins allowed by CORS. |
| `ENCORE_MAX_SONG_S` | `900` | Longest YouTube video, in seconds, that `POST /songs/url` accepts. A positive whole number. |

PowerShell: `$env:ENCORE_DEVICE = "cpu"` before starting. Linux:
`ENCORE_DEVICE=cpu uv run python -m encore_service`.

## Checks

```
uv run ruff check . && uv run ruff format --check . && uv run pytest
```

They need no GPU extra and pass with or without one installed.
