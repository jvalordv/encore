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
audio fetched (see "YouTube links"), the vocal is separated from the rest
(`GET /songs/{id}/stems/{stem}`, see "Separation"), and `/health` and `/gpu`
work. The other preparation steps (reference pitch, lyrics) arrive in ROADMAP
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
   default, `htdemucs_ft`, is four models of 84 MB each, 336 MB; plain
   `htdemucs` (`ENCORE_DEMUCS_MODEL=htdemucs`) is 84 MB.

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
| `GET /songs/{id}/stems/{stem}` | One stem the separation step made, `vocals` or `no_vocals`, as 24-bit FLAC (`audio/flac`, with range requests) and the song's stem gain in the `X-Stem-Gain` header. 404 for an unknown id or any other stem name, 409 while the song has not been separated. See "Separation". |

Songs are prepared one at a time in a background queue, so two songs never
compete for GPU memory. `fetch` is `skipped` for uploads, which arrive with
their audio, and is the download for a link. A step whose model is not built
yet is `skipped` with a "Not built yet" detail naming the ROADMAP task; add
the song again after that task lands and the step runs. A step that cannot
run on this machine, such as separation without its extra installed, is
`skipped` too, with a detail that says what to do; the steps that need it are
`skipped` with "Needs <step>".

The cache is under `service/cache` (or `ENCORE_CACHE_DIR`), one folder per song:

```
<song_id>/source.<ext>      the audio, as uploaded; source.flac for a link
<song_id>/meta.json         title, duration, where it came from, stem gain
<song_id>/status.json       the state of each step
<song_id>/vocals.flac       the sung part, from the separation step
<song_id>/no_vocals.flac    everything else, from the separation step
<song_id>/.fetch/           a link's download while it is under way
<song_id>/.separate/        the separation's working files while it runs
.incoming/                  uploads still arriving
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

## Separation

The `separation` step splits a song into its voice and everything else with
[demucs](https://github.com/adefossez/demucs). The voice is the reference to
score a singer against, and the rest is the backing to sing over. It needs the
`separation` extra ("GPU setup", step 4), and ffmpeg for m4a and any other
file libsndfile cannot read. Without the extra the step is `skipped` with the
command that installs it, the steps that need it are skipped with "Needs
separation", and the song is still stored and playable.

**What it makes**, in the song's folder, and served by
`GET /songs/{id}/stems/vocals` and `GET /songs/{id}/stems/no_vocals`:

- `vocals.flac`: the sung part.
- `no_vocals.flac`: the sum of every other source the model makes (drums, bass
  and the rest), which is the karaoke backing.

Both are stereo 24-bit FLAC at the model's sample rate (44.1 kHz for the demucs
models), whatever the song's own. FLAC rather than WAV because it is lossless
at about half the size for music, and every browser decodes it. A mono song is
separated as two identical channels, and audio of more than two channels is
folded down to stereo first, so a vocal in the centre of 5.1 is kept. A song of
unknown length, such as an m4a upload, gets its length from the decoded audio.

**What the stems are.** The model's estimates of the voice and of the rest,
not an exact split of the song, so `vocals + no_vocals` is not the song and
nothing may treat it as that. The models learn from music: they drop sound
effects, and nothing above about 16 kHz comes out in either stem. With the
stem gain (below) undone, the difference between the song and the two stems
added back together is about 21 dB below the song's level on a sung Creative
Commons song, and only about 12 dB below it on a film soundtrack full of
effects (Big Buck Bunny), where 44% of the difference's energy falls in 8 of
its 634 seconds.

**Level.** If either stem would clip (a peak over 0.999), both are scaled by
the same factor, so the balance between them, and their sum, are the model's
own times that factor. The factor is stored as `stem_gain` in `meta.json`, 1.0
when nothing was scaled, and sent with each stem as the `X-Stem-Gain` response
header, which a page on an allowed origin may read. Divide a stem by it for its
level on the song's own scale, before comparing that level with the song's or
with another song's. A player that mixes the stems with the original should
multiply the original by it.

**A song with no singing** still has a vocal stem that is not silent: the
model hands it the odd animal call or effect. Over the whole song a few such
seconds make the vocal stem's RMS level, against the song's, look like
singing (-17 dB for the film, -10 dB for the sung song), so that global ratio
cannot tell the two apart. The vocal stem's RMS level a second at a time, with
the stem gain undone, can: the film's is above -40 dBFS in 3.5% of its 634
seconds (its 95th percentile is -42 dBFS), the sung song's in 81% of its 231,
and that song's median is -23 dBFS.

**The model** is `ENCORE_DEMUCS_MODEL`, default `htdemucs_ft`: four
fine-tuned htdemucs models, each run over the whole song and each kept for the
one source it is best at. That is about four times the work of plain `htdemucs`
for a slightly cleaner split. Any name demucs knows works, as long as the model
makes a `vocals` source, as `htdemucs`, `htdemucs_6s` (guitar and piano go into
the backing) and `mdx_extra` do; a model without one fails the step as it is
loaded, before any song is read. A name with a `/` in it, or one that starts
with `hf://`, is fetched from that Hugging Face user's repository, and the file
names the code that builds the model, so set one only for a repository you
trust. It runs as the demucs command does: the song is normalised by its mono
mix and cut into overlapping segments that are cross-faded, and the model is
run once at a random time shift, with the bag's models combined by their
weights. The random shift means two runs differ slightly.

**Weights** are not part of the install. The first song downloads them (84 MB
for `htdemucs`, 336 MB for `htdemucs_ft`) into the cache described in "GPU
setup", step 6, and the model then stays loaded until the service stops, which
`GET /gpu` shows under `loaded_models`, as `demucs:htdemucs_ft@cuda`. A first
song therefore takes longer, and fails with the reason if the download cannot
be made.

**Device.** `ENCORE_DEVICE` picks it: `cuda` when torch sees a GPU, otherwise
`cpu`. A CPU is much slower.

**Time and memory**, measured on the RTX 4070 Ti with `htdemucs_ft` and real
weights (2026-10-24). A 10.6-minute track separated in about 44 s once the
model was loaded, about 14 times faster than real time; a 3.9-minute song took
about 26 s while another program was also using the GPU. The first song of a
fresh install spent about 16 s more downloading and loading the weights. GPU
memory peaked about 1.4 GB above what the machine used before, and about
1.3 GB stays in use afterwards while the model is loaded. Writing both stems
of a four-minute song takes under 2 s. RAM is the larger cost: the song is held
as 32-bit floats in several copies at once, about 0.6 GB per minute of audio
at the peak on top of about 1 GB for the service (a stand-in run of a
10-minute song peaked at 6.5 GiB), so a 15-minute link, the longest allowed,
needs about 10 GB. On the CPU the same work runs about 12 times slower than on
this GPU (about 45 s per minute of audio in a stand-in run). The stems of the
10.6-minute track came to 43 MB (vocals) and 94 MB (backing).

**When it fails**, the step's `error` says what and why, as for the fetch step.
Running out of GPU memory, while loading the model or while separating, is
told apart: the message says to close other programs that use the GPU, or to
set `ENCORE_DEVICE=cpu`. Stems are written to `<song_id>/.separate/` first and
moved in only when both are whole, so a stem that is served is never
half-written, and the folder is removed whatever happens. If the move itself
fails, neither stem is left, so the two are never a mismatched pair. Add the
song again to retry. That also runs a finished separation again when its stems
have gone from the song's folder.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `ENCORE_DEVICE` | `cuda` if torch sees CUDA, else `cpu` | Device for the models. |
| `ENCORE_DEMUCS_MODEL` | `htdemucs_ft` | The demucs model that separates the vocal (see "Separation"). Any name demucs knows; blank means the default. |
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

They need no GPU extra and pass with or without one installed. The tests that
run demucs itself (`tests/test_separation_torch.py`) use small models with
random weights, download nothing, and are skipped where torch is absent, as in
CI; the CUDA ones are skipped where there is no GPU.
