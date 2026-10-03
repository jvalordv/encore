# encore service

The local half of encore. A FastAPI app that does the work the browser cannot:
vocal separation (demucs), reference pitch tracking (torchcrepe), word-level
lyrics (whisperx), take analysis, and speaker embeddings for duets. It runs on
your machine and your audio never leaves it. The browser app works without it
(live pitch, recording, playback); with it you also get the reference melody,
lyrics, scoring and coaching. See `../docs/ARCHITECTURE.md`.

Status: the skeleton is in place (`/health`, `/gpu`, the schemas, and stub
routes that answer 501). The models arrive in ROADMAP Phases 2 to 4.

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
