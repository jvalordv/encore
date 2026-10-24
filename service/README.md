# encore service

The local half of encore. A FastAPI app that does the work the browser cannot:
vocal separation (demucs), reference pitch tracking (torchcrepe), word-level
lyrics (whisperx), take analysis, and speaker embeddings for duets. It runs on
your machine and your audio never leaves it. The browser app works without it
(live pitch, recording, playback); with it you also get the reference melody,
lyrics, scoring and coaching. See `../docs/ARCHITECTURE.md`.

Status: songs can be added (`POST /songs`, `GET /songs/{id}`,
`GET /songs/{id}/audio`): uploads are hashed, cached and queued for
preparation, and `/health` and `/gpu` work. The preparation steps themselves
(separation, reference pitch, lyrics) arrive in ROADMAP Phase 2, so for now
each reports `skipped` with a "Not built yet" note. `/analyze` and `/duet/*`
are stubs that answer 501 until Phases 3 and 4.

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

## GPU setup

Needed from Phase 2 on (separation, pitch tracking, lyrics). The target is an
NVIDIA card such as the 4070 Ti with a current driver.

1. **ffmpeg.** demucs and whisperx call it to read audio. It must be on PATH.
   Windows: `winget install ffmpeg` (or download a build and add it to PATH).
   Linux: `sudo apt install ffmpeg` or your distro's equivalent. Check with
   `ffmpeg -version` in a new terminal.
2. **PyTorch CUDA wheels (Windows).** torch from PyPI is CPU-only on Windows,
   so open `pyproject.toml`, uncomment the `[[tool.uv.index]]` and
   `[tool.uv.sources]` blocks, and replace `XXX` in the URL with the CUDA
   version that suits your driver. Which versions exist and which driver they
   need changes over time: pick from https://pytorch.org/get-started/locally/
   and check `nvidia-smi` for the driver's CUDA version. On Linux, PyPI's
   torch already ships CUDA, so you can usually skip this step; use the same
   block if you want a specific CUDA version.
3. **Install the extra:**

   ```
   uv sync --extra gpu
   ```

   This is a multi-gigabyte download. The pins of whisperx, demucs and
   speechbrain on torch move between releases; if the resolver complains,
   read its message for the conflicting version rather than forcing it.
4. **Check it.** Start the service (below) and open
   <http://localhost:8765/gpu>. You want `"torch_available": true` and
   `"cuda_available": true` with your card's name and VRAM. If torch is
   available but CUDA is not, you got the CPU wheels: revisit step 2.

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
| `GET /songs/{id}` | The song's status: `title`, `duration_s`, and for each step (`fetch`, `separation`, `reference`, `lyrics`) a `state` (`queued`, `running`, `done`, `failed` or `skipped`), a `progress` from 0 to 1, an `error` when it failed and a `detail` saying why it was skipped. 404 for an unknown id. |
| `GET /songs/{id}/audio` | The stored source file, so the browser can reload a song without the original. 404 for an unknown id, 409 while the song has no source audio. |

Songs are prepared one at a time in a background queue, so two songs never
compete for GPU memory. `fetch` is always `skipped` for uploads. A step whose
model is not built yet is `skipped` with a "Not built yet" detail naming the
ROADMAP task; add the song again after that task lands and the step runs.

The cache is under `service/cache` (or `ENCORE_CACHE_DIR`), one folder per song:

```
<song_id>/source.<ext>   the audio, as uploaded
<song_id>/meta.json      title, duration, where it came from
<song_id>/status.json    the state of each step
.incoming/               uploads still arriving
```

Deleting a song's folder makes the service forget it; add the file again to
prepare it afresh. If only the audio file is gone, adding the same file again
puts it back. If the service stops while a step is running, that step shows as
`failed` ("Interrupted ...") after the next start; add the song again to retry
it. A song that was still waiting in the queue when the service stopped is
queued again at the next start, so it is not left as `queued` for good. A song
with a `failed` step is never resumed on its own: add it again.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `ENCORE_DEVICE` | `cuda` if torch sees CUDA, else `cpu` | Device for the models. |
| `ENCORE_CACHE_DIR` | `service/cache` | Where songs and their stems are stored. |
| `ENCORE_PORT` | `8765` | Port for `python -m encore_service`. |
| `ENCORE_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated origins allowed by CORS. |

PowerShell: `$env:ENCORE_DEVICE = "cpu"` before starting. Linux:
`ENCORE_DEVICE=cpu uv run python -m encore_service`.

## Checks

```
uv run ruff check . && uv run ruff format --check . && uv run pytest
```
