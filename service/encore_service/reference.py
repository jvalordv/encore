"""The reference step: the melody of the song, taken from its vocal stem.

`extract_reference` is the runner registered for the `reference` step in
`pipeline.py`. It reads `vocals.flac`, decides whether anyone sings in it,
has a pitch model track the voice, and stores the `Reference` that
`melody.py` builds from the track as `reference.json`. The browser gets it
from `GET /songs/{id}/reference`.

Whether anyone sings is decided before any model is loaded: a karaoke upload
(or an instrumental) has an empty vocal stem, and drawing a contour from the
noise in it would show a melody that is not there. A global level against the
song cannot tell them apart (a few seconds of animal calls on a film
soundtrack lift it to a sung song's), so the test is on the vocal stem alone,
a second at a time: the share of 1 s windows whose level, at the song's own
scale (the stem divided by its `stem_gain`), is above PRESENCE_DBFS. Measured
on a film with no singing it is a few percent, on a sung song around four
fifths; below MIN_PRESENCE_SHARE the step is skipped with a reason the browser
shows.

The model is reached through the `PitchTracker` protocol and `load_crepe`,
which tests replace, so no test needs torchcrepe or its weights. Nothing here
imports torch or torchcrepe until a song is tracked, so the module loads, and
the rest of the service runs, without the `pitch` extra; a sung song is then
skipped with the command that installs it. The audio is read with soundfile
and handed over as a tensor, because torchcrepe's own loader needs torchcodec.
The model is run on 16 kHz audio with one frame every 10 ms, in chunks with a
second of context at each end so that its Viterbi decoding is not cut short at
a chunk's edge; frame `i` is at `i * 0.01` s whatever the stem's own rate.
"""

import importlib
import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Protocol, TypeVar

import numpy as np
import soundfile as sf
from numpy.typing import NDArray

from encore_service import registry
from encore_service.config import Settings
from encore_service.errors import StepSkipped
from encore_service.melody import HOP_S, NoMelodyError, build_reference
from encore_service.schemas import Reference
from encore_service.store import SongStore

logger = logging.getLogger(__name__)

ResultT = TypeVar("ResultT")

Audio = NDArray[np.float32]
Report = Callable[[float], None]

# This model family's prefix in `GET /gpu`'s `loaded_models`, and the size of
# the model (the full one; torchcrepe also has a tiny one).
PITCH_FAMILY = "crepe"
CREPE_MODEL = "full"
# The model works on 16 kHz audio; one frame per 10 ms is 160 samples of it.
CREPE_RATE = 16_000
HOP_SAMPLES = round(CREPE_RATE * HOP_S)
# The pitch the model may answer with, in Hz: the bottom of a bass voice to
# the top of a soprano's, which keeps a rumble or a whistle from being a note.
FMIN_HZ = 65.0
FMAX_HZ = 1100.0
# Frames decoded together, and the frames of context either side of them that
# are decoded and thrown away. A chunk with its context (800 frames) takes
# about 2 GB of GPU memory while it is decoded.
CHUNK_FRAMES = 600
CONTEXT_FRAMES = 100

# Is anyone singing: see the module docstring.
PRESENCE_WINDOW_S = 1.0
PRESENCE_DBFS = -40.0
MIN_PRESENCE_SHARE = 0.15
# A frame counts as sounding above this level, measured over 40 ms at the
# song's own scale. Below it the frame is given no pitch, whatever the model
# makes of it: a separated vocal is never quite silent between words (a real
# run left traces of the voice at about -60 dBFS that the model tracked with
# high confidence, as notes that were not sung), while singing is far above.
SOUNDING_DBFS = -50.0
_LEVEL_WINDOW_FRAMES = 4
_LEVEL_FLOOR = 1e-20

# Share of the step the setup (reading, the singing test) and the tracking fill.
SETUP_PROGRESS = 0.05
TRACKING_PROGRESS = 0.95

INSTALL_HINT = (
    "Install the pitch extra: cd service && uv sync --inexact --extra pitch "
    "(see service/README.md, GPU setup)"
)
_BACKEND_MODULES = ("torch", "torchcrepe")


class PitchError(RuntimeError):
    """The reference step failed; the message says what failed and why."""


class PitchTracker(Protocol):
    """A loaded pitch model, as the runner uses it."""

    def track(
        self, mono: Audio, samplerate: int, report: Report
    ) -> tuple[NDArray[np.float32], NDArray[np.float32]]:
        """The pitch of mono `mono` at `samplerate`, a frame every HOP_S.

        Returns (f0 in Hz, confidence from 0 to 1), one value of each per
        frame, frame `i` at `i * HOP_S` s; the f0 of a frame with no pitch is
        not defined. Progress goes to `report` from 0 to 1.
        """
        ...


@dataclass(frozen=True)
class Chunk:
    """Frames `core_start` to `core_end` of a track, decoded from `seg_*`."""

    core_start: int
    core_end: int
    seg_start: int
    seg_end: int


def plan_chunks(total: int, size: int, context: int) -> list[Chunk]:
    """Cut `total` frames into chunks of `size`, each with `context` either side.

    The cores tile the frames exactly; each segment is its core widened by
    `context` frames where there are any, which are decoded and dropped.
    """
    chunks: list[Chunk] = []
    for start in range(0, total, size):
        end = min(start + size, total)
        chunks.append(
            Chunk(start, end, max(start - context, 0), min(end + context, total))
        )
    return chunks


# --- is anyone singing --------------------------------------------------------


def vocal_presence(mono: Audio, samplerate: int, gain: float = 1.0) -> float:
    """The share of 1 s windows of `mono` that sound, from 0 to 1.

    A window sounds when its RMS level, once `mono` is divided by `gain` (the
    stem gain, which scaled the stems down so that neither clipped), is above
    PRESENCE_DBFS. A trailing part of a window is not counted; audio shorter
    than a window is one window.
    """
    size = round(PRESENCE_WINDOW_S * samplerate)
    whole = len(mono) // size
    blocks = mono[None, :] if whole == 0 else mono[: whole * size].reshape(whole, size)
    mean_square = np.einsum("ij,ij->i", blocks, blocks, dtype=np.float64)
    mean_square /= blocks.shape[1]
    level_db = 10.0 * np.log10(mean_square + _LEVEL_FLOOR) - 20.0 * math.log10(gain)
    return float(np.mean(level_db > PRESENCE_DBFS))


def frame_levels_db(
    mono: Audio, samplerate: int, frames: int, gain: float
) -> NDArray[np.float64]:
    """RMS level in dBFS, at the song's scale, around each of `frames` frames.

    Frame `i` is centred on `i * HOP_S` s and looks 40 ms wide, two hops each
    way. Frames past the end of the audio read as silence.
    """
    hop = round(samplerate * HOP_S)
    hops = max(math.ceil(len(mono) / hop), 1)
    padded = np.zeros(hops * hop, dtype=np.float32)
    padded[: len(mono)] = mono
    blocks = padded.reshape(hops, hop)
    energy = np.einsum("ij,ij->i", blocks, blocks, dtype=np.float64)
    # Hop k sits at k + before in `spread`, so frame i's window is the
    # _LEVEL_WINDOW_FRAMES entries from i on.
    before = _LEVEL_WINDOW_FRAMES // 2
    spread = np.zeros(frames + _LEVEL_WINDOW_FRAMES)
    usable = min(hops, frames + before)
    spread[before : before + usable] = energy[:usable]
    window = np.convolve(spread, np.ones(_LEVEL_WINDOW_FRAMES), mode="valid")[:frames]
    mean_square = window / (_LEVEL_WINDOW_FRAMES * hop)
    return 10.0 * np.log10(mean_square + _LEVEL_FLOOR) - 20.0 * math.log10(gain)


# --- torchcrepe --------------------------------------------------------------


class CrepeTracker:
    """torchcrepe on one device, as a `PitchTracker`."""

    def __init__(self, name: str, device: str) -> None:
        self._name = name
        self._device = device

    def track(
        self, mono: Audio, samplerate: int, report: Report
    ) -> tuple[NDArray[np.float32], NDArray[np.float32]]:
        """Track `mono` in chunks, with Viterbi decoding inside each."""
        import torch
        import torchcrepe

        audio = torch.from_numpy(np.ascontiguousarray(mono, dtype=np.float32))[None]
        if samplerate != CREPE_RATE:
            audio = torchcrepe.resample(audio, samplerate)
        samples = audio.shape[1]
        total = 1 + samples // HOP_SAMPLES
        f0 = np.zeros(total, dtype=np.float32)
        confidence = np.zeros(total, dtype=np.float32)
        chunks = plan_chunks(total, CHUNK_FRAMES, CONTEXT_FRAMES)
        try:
            for done, chunk in enumerate(chunks, start=1):
                # The last frame of the segment sits at the start of its final
                # hop, so the audio ends there: the model then returns
                # exactly the segment's frames.
                first = chunk.seg_start * HOP_SAMPLES
                last = min(samples, (chunk.seg_end - 1) * HOP_SAMPLES)
                pitch, periodicity = torchcrepe.predict(
                    audio[:, first:last],
                    CREPE_RATE,
                    HOP_SAMPLES,
                    fmin=FMIN_HZ,
                    fmax=FMAX_HZ,
                    model=self._name,
                    decoder=torchcrepe.decode.viterbi,
                    return_periodicity=True,
                    batch_size=None,
                    device=self._device,
                )
                low = chunk.core_start - chunk.seg_start
                high = low + chunk.core_end - chunk.core_start
                f0[chunk.core_start : chunk.core_end] = pitch[0, low:high].numpy()
                confidence[chunk.core_start : chunk.core_end] = periodicity[
                    0, low:high
                ].numpy()
                report(done / len(chunks))
        finally:
            # A chunk's activations are a gigabyte; the weights stay.
            if self._device.startswith("cuda"):
                torch.cuda.empty_cache()
        return f0, confidence


def _require_backend() -> None:
    """Import everything pitch tracking needs, or skip the step saying how."""
    for module in _BACKEND_MODULES:
        try:
            importlib.import_module(module)
        except ImportError as exc:
            raise StepSkipped(INSTALL_HINT) from exc
        except OSError as exc:
            # A broken CUDA runtime fails at import time on Windows, as a
            # DLL that will not load rather than as a missing module.
            raise StepSkipped(
                f"{module} could not be loaded ({exc}). {INSTALL_HINT}"
            ) from exc


def load_crepe(name: str, device: str) -> PitchTracker:
    """Load the torchcrepe model `name` onto `device`; its weights ship with it.

    Raises StepSkipped, with the command that installs it, when torch or
    torchcrepe cannot be imported.
    """
    _require_backend()
    import torchcrepe

    logger.info("Loading torchcrepe model %s on %s", name, device)
    # torchcrepe loads its model on first use otherwise, into a module global
    # that nothing here could tell was loaded; doing it now puts it on the GPU
    # before the first song is read.
    torchcrepe.load.model(device, name)
    return CrepeTracker(name, device)


# --- the step ----------------------------------------------------------------


def extract_reference(store: SongStore, song_id: str, report: Report) -> None:
    """Make `reference.json` for a song from its vocal stem.

    Raises StepSkipped when nobody sings in the vocal, when the pitch extra is
    not installed, and when the track holds no steady pitch; and PitchError,
    reading "<what failed>: <why>", on any failure.
    """
    settings = Settings.from_env()
    vocals = store.stem_path(song_id, "vocals")
    if vocals is None:
        raise PitchError("Reading the vocal failed: the song has no vocal stem")
    meta = store.read_meta(song_id)
    gain = meta.stem_gain if meta is not None else 1.0
    started = time.monotonic()

    mono, samplerate = _attempt("Reading the vocal", partial(_read_mono, vocals))
    share = vocal_presence(mono, samplerate, gain)
    if share < MIN_PRESENCE_SHARE:
        raise StepSkipped(
            f"No singing found: the vocal is audible in only {share:.0%} of "
            "this track. It looks like a karaoke or instrumental version, so "
            "there is no melody to show."
        )
    report(SETUP_PROGRESS)

    tracker = _attempt(
        "Loading the pitch model",
        partial(
            registry.models.get,
            PITCH_FAMILY,
            CREPE_MODEL,
            settings.device,
            load_crepe,
        ),
    )

    def tracking(progress: float) -> None:
        report(SETUP_PROGRESS + (TRACKING_PROGRESS - SETUP_PROGRESS) * progress)

    f0, confidence = _attempt(
        "Tracking the pitch", partial(tracker.track, mono, samplerate, tracking)
    )
    reference = _attempt(
        "Building the melody",
        partial(_build, mono, samplerate, gain, f0, confidence),
    )
    _attempt("Saving the melody", partial(store.write_reference, song_id, reference))
    report(1.0)
    logger.info(
        "Tracked song %s (%.0f s of vocal, %.0f%% of it sounding) into %d notes "
        "in %.1f s on %s",
        song_id,
        len(mono) / samplerate,
        100 * share,
        len(reference.notes),
        time.monotonic() - started,
        settings.device,
    )


def _attempt(what: str, action: Callable[[], ResultT]) -> ResultT:
    """Run `action`; a failure becomes PitchError("<what> failed: <why>").

    A skip, and a failure already worded for the person, pass through as they
    are.
    """
    try:
        return action()
    except (StepSkipped, PitchError):
        raise
    except Exception as exc:
        raise PitchError(f"{what} failed: {str(exc) or type(exc).__name__}") from exc


def _read_mono(path: Path) -> tuple[Audio, int]:
    """The vocal stem as one channel (the mean of its channels) and its rate."""
    data, samplerate = sf.read(str(path), dtype="float32", always_2d=True)
    if data.shape[0] == 0:
        raise ValueError("the vocal stem has no samples")
    return np.ascontiguousarray(data.mean(axis=1, dtype=np.float32)), int(samplerate)


def _build(
    mono: Audio,
    samplerate: int,
    gain: float,
    f0: NDArray[np.float32],
    confidence: NDArray[np.float32],
) -> Reference:
    """The reference from the tracker's output; skips if it holds no note."""
    level_db = frame_levels_db(mono, samplerate, len(f0), gain)
    # Traces at the bottom of the stem have no pitch worth a note, though the
    # model will often give them one with some confidence.
    confidence = np.where(level_db < SOUNDING_DBFS, 0.0, confidence)
    try:
        return build_reference(
            f0.astype(np.float64),
            confidence.astype(np.float64),
            level_db >= SOUNDING_DBFS,
        )
    except NoMelodyError as exc:
        raise StepSkipped(
            "No melody found: nothing in the vocal holds a steady pitch."
        ) from exc
