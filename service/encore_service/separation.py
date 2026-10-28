"""The separation step: split a song into its voice and everything else.

`separate_vocals` is the runner registered for the `separation` step in
`pipeline.py`. It reads the song's source audio, has demucs split it into
stems, and installs `vocals.flac` and `no_vocals.flac` (the sum of every other
stem, which is the karaoke backing) in the song's folder as 24-bit FLAC. The
model is loaded on first use and kept in the service's model registry
(`registry.py`), which `GET /gpu` lists. Nothing here imports torch or demucs
until a song is separated, so this module loads, and the rest of the service
runs, without the `separation` extra: the step is then skipped with the
command that installs it. The model is reached through the `Separator`
protocol and `load_demucs`, which tests replace, so no test downloads weights.
The sums and scalings are plain numpy so they are tested without torch. See
"Models are loaded lazily" in docs/ARCHITECTURE.md.

The stems are the model's estimates, not an exact split of the song. The
models are trained on music, so they drop sound effects and put nothing above
about 16 kHz in either stem. Added back together, with the stem gain undone,
they differ from the song by a signal about 21 dB below it on a sung song and
only about 12 dB below it on a film soundtrack full of effects. So nothing may
take `vocals + no_vocals` to be the song, and whatever mixes the stems with
the song, or compares levels across songs, divides by the song's `stem_gain`
first (meta.json, or the X-Stem-Gain header). Nor can a global ratio of the
vocal's level to the song's say whether a song is sung: a few seconds of
animal calls or effects lift it on a film with no singing to near a sung
song's. The vocal stem's level, a second at a time and at the song's own
scale, can. The README's "Separation" section has the figures.
"""

import gc
import importlib
import logging
import math
import shutil
import subprocess
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from functools import partial
from pathlib import Path
from typing import Any, Protocol, TypeVar

import numpy as np
import soundfile as sf
from numpy.typing import NDArray

from encore_service import registry, youtube
from encore_service.config import Settings
from encore_service.errors import StepSkipped
from encore_service.store import STEM_FILES, SongStore

logger = logging.getLogger(__name__)

ResultT = TypeVar("ResultT")

# Float samples shaped (channels, samples), the layout torch and demucs use,
# so audio crosses to them without a copy.
Audio = NDArray[np.float32]
# Called with how far a step has got, from 0 to 1.
Report = Callable[[float], None]
# What demucs calls with each segment of a separation: a dict of its position.
ProgressEvent = Mapping[str, Any]

# Inside the song's folder, so the stems move into place on the same volume
# and the move is atomic.
WORK_DIR = ".separate"
# Where ffmpeg puts audio that libsndfile cannot read, inside WORK_DIR.
DECODED_NAME = "decoded.wav"
# The source demucs calls the voice; every other source is the backing.
VOCALS = "vocals"
NO_VOCALS = "no_vocals"
# This model family's prefix in `GET /gpu`'s `loaded_models`.
DEMUCS_FAMILY = "demucs"

# What the demucs command line does by default, which is what its published
# quality is measured with: one pass at a random time shift, and segments
# that overlap by a quarter.
SHIFTS = 1
OVERLAP = 0.25
# Share of the step the model's passes fill; saving the stems is the rest.
PROGRESS_CAP = 0.95
# The stems' peak may not pass this. A 24-bit file clips at 1.0, so this leaves
# room for the rounding.
CLIP_CEILING = 0.999
# Added to the standard deviation, so a silent song divides by something.
_STD_FLOOR = 1e-8
# libsndfile reads one or two channels directly; more go through ffmpeg.
_MAX_DIRECT_CHANNELS = 2

# ffmpeg decodes a 15-minute song in seconds; this only ends a hung process.
_FFMPEG_TIMEOUT_S = 600
_STDERR_TAIL_CHARS = 500

# Modules the separation needs, loaded together so one missing piece skips
# the step instead of failing it half way.
_BACKEND_MODULES = ("torch", "julius", "demucs.apply", "demucs.pretrained")
INSTALL_HINT = (
    "Install the separation extra: cd service && uv sync --extra separation "
    "(see service/README.md, GPU setup)"
)
OUT_OF_MEMORY = (
    "The GPU ran out of memory while separating. Close other programs using "
    "the GPU, or set ENCORE_DEVICE=cpu (much slower)."
)


class SeparationError(RuntimeError):
    """The separation step failed; the message says what failed and why."""


class Separator(Protocol):
    """A loaded separation model, as the runner uses it."""

    # The rate its stems come out at, whatever the audio it is given.
    samplerate: int

    def separate(self, wav: Audio, samplerate: int, report: Report) -> dict[str, Audio]:
        """Split stereo `wav` at `samplerate` into named stems.

        The stems are stereo at `self.samplerate`. They are the model's
        estimates, so they add up to `wav` only roughly. Progress goes to
        `report` from 0 up to about PROGRESS_CAP.
        """
        ...


# --- the arithmetic on audio, which needs no torch ---------------------------


def as_stereo(wav: Audio) -> Audio:
    """Two channels from one or two; mono is put on both sides, unchanged."""
    channels = wav.shape[0]
    if channels == 2:
        return wav
    if channels == 1:
        return np.repeat(wav, 2, axis=0)
    raise ValueError(f"Expected one or two channels, got {channels}")


def normalise(wav: Audio) -> tuple[Audio, float, float]:
    """Centre and scale `wav` by its mono mix, as the demucs command does.

    The models were trained on audio set to zero mean and unit deviation, so
    a quiet or loud song is brought to that first. Returns the new audio with
    the mean and the standard deviation (floored) that `restore` undoes.
    """
    reference = wav.mean(axis=0)
    mean = float(reference.mean(dtype=np.float64))
    deviation = (
        float(reference.std(dtype=np.float64, ddof=1)) if reference.size > 1 else 0.0
    )
    std = deviation + _STD_FLOOR
    # Python floats keep the arithmetic in float32; a numpy scalar would not.
    return (wav - mean) / std, mean, std


def restore(stem: Audio, mean: float, std: float) -> Audio:
    """Undo `normalise` on one stem the model made from normalised audio.

    `mean` is the part of the song's mean that this stem is to carry, which
    `restore_sources` works out.
    """
    restored = stem * std
    restored += mean
    return restored


def restore_sources(
    estimates: Iterable[Audio], names: Sequence[str], mean: float, std: float
) -> dict[str, Audio]:
    """Undo `normalise` on every source a model made, keyed by its name.

    The song's mean goes back once in all, shared evenly between the sources.
    They are meant to add up to the song, so each carrying the whole mean
    would put it back once per source, and the voice and the backing would add
    up to the song plus its mean again for every source after the first. (The
    demucs command adds it to every source.)
    """
    count = len(names)
    return {
        name: restore(stem, mean / count, std)
        for name, stem in zip(names, estimates, strict=True)
    }


def check_sources(names: Sequence[str]) -> None:
    """Raise ValueError unless a model makes a voice and a backing to keep."""
    if VOCALS not in names:
        made = ", ".join(names) or "nothing"
        raise ValueError(f"the model makes no {VOCALS} source, only {made}")
    if len(names) < 2:
        raise ValueError(
            f"the model makes only a {VOCALS} source, so there is no backing"
        )


def combine_stems(sources: Mapping[str, Audio]) -> tuple[Audio, Audio]:
    """The voice and the sum of every other source, as (vocals, no_vocals).

    Raises ValueError for a model with no voice, or with nothing but one.
    """
    check_sources(list(sources))
    others = [stem for name, stem in sources.items() if name != VOCALS]
    backing = others[0].copy()
    for stem in others[1:]:
        backing += stem
    return sources[VOCALS], backing


def limit_stems(vocals: Audio, no_vocals: Audio) -> tuple[Audio, Audio, float]:
    """Scale both stems by one factor when either would clip.

    Returns (vocals, no_vocals, gain). Over CLIP_CEILING, both are multiplied
    by CLIP_CEILING over the larger peak: the same factor for both, so the
    balance between them and their sum stay what the model made, times that
    gain, and dividing by the gain gives them back. Otherwise they come back
    as they were, with a gain of 1.0. Raises ValueError for audio that holds
    NaN or infinity, which no file could keep.
    """
    # max and min rather than abs, which would copy a quarter hour of audio.
    peaks = [
        float(vocals.max()),
        -float(vocals.min()),
        float(no_vocals.max()),
        -float(no_vocals.min()),
    ]
    if not all(math.isfinite(peak) for peak in peaks):
        raise ValueError(
            "the separated audio holds values that are not numbers (NaN or infinity)"
        )
    peak = max(peaks)
    if peak <= CLIP_CEILING:
        return vocals, no_vocals, 1.0
    gain = CLIP_CEILING / peak
    return vocals * gain, no_vocals * gain, gain


def bag_progress(
    report: Report, shifts: int = SHIFTS, cap: float = PROGRESS_CAP
) -> Callable[[ProgressEvent], None]:
    """A callback for demucs's `apply_model` that reports 0 to `cap`.

    demucs calls it as each segment of the audio starts and ends, saying which
    model of the bag, which shift and which segment (by its offset into
    `audio_length` samples) it is on. A bag runs its models one after another
    and each makes `shifts` passes over the audio, so the share done is the
    passes finished plus the part of the current one that its segments cover.
    Only the end of a segment counts, and it is the segment's start that is
    known, so progress runs one segment behind and never claims more than has
    been done. It never goes backwards, and an event that lacks what it needs
    is ignored: progress is cosmetic and must not fail a song.
    """
    best = 0.0

    def callback(event: ProgressEvent) -> None:
        nonlocal best
        if event.get("state") != "end":
            return
        try:
            models_in_bag = max(int(event["models"]), 1)
            model_index = int(event["model_idx_in_bag"])
            shift_index = int(event["shift_idx"])
            offset = int(event["segment_offset"])
            length = max(int(event["audio_length"]), 1)
        except (KeyError, TypeError, ValueError):
            return
        # A shifted pass is a little longer than the audio, so the last
        # offsets can pass its length.
        within = min(max(offset / length, 0.0), 1.0)
        finished = model_index * shifts + shift_index + within
        value = min(finished / (models_in_bag * shifts), 1.0) * cap
        if value > best:
            best = value
            report(value)

    return callback


# --- reading the song --------------------------------------------------------


def read_audio(path: Path, scratch: Path) -> tuple[Audio, int]:
    """The song's audio as stereo float samples, with its sample rate.

    libsndfile reads what it can (wav, flac, ogg, mp3). Anything else, such as
    m4a, or audio of more than two channels, is decoded by ffmpeg to a WAV in
    `scratch` first, folded down to at most stereo, and that is read instead.
    Mono is put on both sides. Raises ValueError for audio with no samples,
    and youtube.FfmpegError when ffmpeg is needed and cannot do it.
    """
    loaded = _read_with_libsndfile(path)
    if loaded is None:
        decoded = scratch / DECODED_NAME
        _decode_with_ffmpeg(path, decoded)
        try:
            loaded = _read_with_libsndfile(decoded)
        finally:
            # Only needed once read; a long song's WAV is hundreds of MB.
            decoded.unlink(missing_ok=True)
        if loaded is None:
            raise youtube.FfmpegError("ffmpeg wrote audio that could not be read back")
    wav, samplerate = loaded
    if wav.shape[1] == 0:
        raise ValueError("the file has no samples")
    return as_stereo(wav), samplerate


def _read_with_libsndfile(path: Path) -> tuple[Audio, int] | None:
    """The file as (channels, samples) floats, or None if ffmpeg must do it."""
    try:
        if sf.info(str(path)).channels > _MAX_DIRECT_CHANNELS:
            return None
        data, samplerate = sf.read(str(path), dtype="float32", always_2d=True)
    except RuntimeError:
        # libsndfile does not know the format, or cannot open the file;
        # soundfile raises its own subclass of RuntimeError for both.
        return None
    return np.ascontiguousarray(data.T), int(samplerate)


def _decode_with_ffmpeg(src: Path, dst: Path) -> None:
    """Decode `src` to a 24-bit WAV of at most two channels at `dst`.

    Raises youtube.FfmpegError, as youtube.to_flac does, when ffmpeg is
    missing, cannot start, times out or rejects the file.
    """
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise youtube.FfmpegError(youtube.FFMPEG_MISSING)
    # An argument list, never a shell string: nothing in a path is parsed.
    # Absolute paths, so one that starts with "-" is not read as an option.
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src.absolute()),
        "-vn",
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_s24le",
        # At most stereo, as when a link is fetched: a vocal in the centre
        # channel of 5.1 audio is folded into both sides, not dropped.
        "-af",
        "aformat=channel_layouts=mono|stereo",
        str(dst.absolute()),
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=_FFMPEG_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        dst.unlink(missing_ok=True)
        raise youtube.FfmpegError(
            f"ffmpeg did not finish within {_FFMPEG_TIMEOUT_S} s"
        ) from exc
    except OSError as exc:
        raise youtube.FfmpegError(f"ffmpeg could not be started: {exc}") from exc
    if result.returncode != 0:
        # A failed run can leave a stub that looks like a result.
        dst.unlink(missing_ok=True)
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        detail = f": {stderr[-_STDERR_TAIL_CHARS:]}" if stderr else ""
        raise youtube.FfmpegError(
            f"ffmpeg failed (exit status {result.returncode}){detail}"
        )


def write_flac(path: Path, wav: Audio, samplerate: int) -> None:
    """Write `wav`, shaped (channels, samples), to `path` as 24-bit FLAC."""
    sf.write(str(path), wav.T, samplerate, format="FLAC", subtype="PCM_24")


# --- demucs ------------------------------------------------------------------


class DemucsSeparator:
    """A demucs model, or bag of models, on one device, as a `Separator`."""

    def __init__(self, model: Any, device: str) -> None:
        self._model = model
        self._device = device
        self.samplerate = int(model.samplerate)

    def separate(self, wav: Audio, samplerate: int, report: Report) -> dict[str, Audio]:
        """Split stereo `wav` into the model's sources, at the model's rate.

        Resamples to the model's rate, normalises, runs the model as the demucs
        command does and undoes the normalisation. Raises SeparationError with
        advice when the GPU runs out of memory.
        """
        import julius
        import torch
        from demucs.apply import apply_model

        mix = torch.from_numpy(np.ascontiguousarray(wav))
        if samplerate != self.samplerate:
            # julius is the resampler the demucs command itself uses, so the
            # result matches it, and it comes with demucs. torchaudio would be
            # one more import for one call, and its releases have ended at 2.11.
            mix = julius.resample_frac(mix, samplerate, self.samplerate)
        normalised, mean, std = normalise(mix.numpy())
        del mix

        out_of_memory = False
        try:
            estimates = apply_model(
                self._model,
                torch.from_numpy(normalised)[None],
                shifts=SHIFTS,
                split=True,
                overlap=OVERLAP,
                device=self._device,
                num_workers=0,
                callback=bag_progress(report),
                callback_arg={"audio_length": normalised.shape[1]},
            )
        except Exception as exc:
            if not _out_of_gpu_memory(exc, self._device):
                raise
            out_of_memory = True
        if out_of_memory:
            # Out here, with the exception gone: its traceback holds the failed
            # pass's tensors, which the cache cannot give back while they live.
            _free_gpu_memory()
            raise SeparationError(OUT_OF_MEMORY)

        return restore_sources(estimates[0].numpy(), self._model.sources, mean, std)


def _out_of_gpu_memory(exc: BaseException, device: str) -> bool:
    """Whether `exc` is torch saying the GPU `device` has no memory left."""
    if not device.startswith("cuda"):
        return False
    import torch

    if isinstance(exc, torch.cuda.OutOfMemoryError):
        return True
    # An allocation that fails inside cuDNN or cuBLAS is a plain RuntimeError.
    return isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower()


def _free_gpu_memory() -> None:
    """Hand torch's CUDA cache back after an allocation that failed.

    Whatever the failed work allocated must be unreferenced by now, or the
    cache cannot release it.
    """
    import torch

    gc.collect()
    torch.cuda.empty_cache()


def load_demucs(name: str, device: str) -> Separator:
    """Load the demucs model `name` onto `device`; the first use downloads it.

    Raises StepSkipped, with the command that installs it, when torch or demucs
    cannot be imported, ValueError for a model that makes no voice to separate,
    and SeparationError with advice when the GPU has no room for the model.
    """
    _require_backend()
    from demucs.pretrained import get_model

    logger.info(
        "Loading demucs model %s on %s (a first use downloads its weights)",
        name,
        device,
    )
    model = get_model(name)
    # Before the model takes any GPU memory, and before a song is read: a name
    # that is no use here is found out now, not after minutes of separating.
    check_sources(model.sources)
    out_of_memory = False
    try:
        # Kept on the device between songs. A bag otherwise moves each of its
        # models there and back on every song, to save memory this much weight
        # (a few hundred MB) does not need saving.
        model.to(device)
    except Exception as exc:
        if not _out_of_gpu_memory(exc, device):
            raise
        out_of_memory = True
    if out_of_memory:
        # As in `DemucsSeparator.separate`, out of the handler; and the model,
        # which may be part way onto the GPU, is dropped before the cache is
        # emptied, or its share could not be given back.
        del model
        _free_gpu_memory()
        raise SeparationError(OUT_OF_MEMORY)
    return DemucsSeparator(model, device)


def _require_backend() -> None:
    """Import everything separation needs, or skip the step saying how."""
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


# --- the step ----------------------------------------------------------------


def separate_vocals(store: SongStore, song_id: str, report: Report) -> None:
    """Separate a song into `vocals.flac` and `no_vocals.flac`.

    Raises StepSkipped when the separation extra is not installed, and
    SeparationError, reading "<what failed>: <why>", on any failure. Whatever
    happens the scratch folder is gone, and the stems route serves a stem only
    whole and only as one of a pair: a failure to install them leaves neither.
    A song whose length was not known (an m4a upload) has it recorded from the
    decoded audio.
    """
    settings = Settings.from_env()
    source = store.source_path(song_id)
    if source is None:
        raise SeparationError("Reading the audio failed: the song has no source audio")
    work = store.song_dir(song_id) / WORK_DIR
    started = time.monotonic()
    try:
        # First, so a missing extra skips the step before any audio is read,
        # and a model that will not load fails it before any is decoded.
        separator = _attempt(
            "Loading the separation model",
            partial(
                registry.models.get,
                DEMUCS_FAMILY,
                settings.demucs_model,
                settings.device,
                load_demucs,
            ),
        )
        _attempt("Preparing the separation folder", partial(_fresh_dir, work))
        wav, samplerate = _attempt(
            "Reading the audio", partial(read_audio, source, work)
        )
        duration_s = wav.shape[1] / samplerate
        _attempt(
            "Recording the song's length",
            partial(_record_duration, store, song_id, duration_s),
        )
        sources = _attempt(
            "Separating the vocal", partial(separator.separate, wav, samplerate, report)
        )
        # Free before the stems are built, as a quarter hour of audio is
        # hundreds of MB.
        del wav
        _attempt(
            "Saving the stems",
            partial(_save_stems, store, song_id, sources, separator.samplerate, work),
        )
        report(1.0)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    logger.info(
        "Separated song %s (%.0f s of audio) in %.1f s with %s on %s",
        song_id,
        duration_s,
        time.monotonic() - started,
        settings.demucs_model,
        settings.device,
    )


def _attempt(what: str, action: Callable[[], ResultT]) -> ResultT:
    """Run `action`; a failure becomes SeparationError("<what> failed: <why>").

    A skip, and a failure already worded for the person, pass through as they
    are.
    """
    try:
        return action()
    except (StepSkipped, SeparationError):
        raise
    except Exception as exc:
        raise SeparationError(
            f"{what} failed: {str(exc) or type(exc).__name__}"
        ) from exc


def _fresh_dir(path: Path) -> None:
    """Make `path` an empty folder, clearing what a crashed run left in it."""
    if path.exists():
        shutil.rmtree(path)
    path.mkdir()


def _record_duration(store: SongStore, song_id: str, duration_s: float) -> None:
    """Store the song's length if it was not known, as for an m4a upload."""
    meta = store.read_meta(song_id)
    if meta is None or meta.duration_s is None:
        store.set_duration(song_id, duration_s)


def _save_stems(
    store: SongStore,
    song_id: str,
    sources: Mapping[str, Audio],
    samplerate: int,
    work: Path,
) -> None:
    """Write the two stems into `work`, then move each into the song's folder.

    The gain goes into meta.json before the stems are installed, so the file
    that says how the stems were scaled is never older than they are. If a
    stem cannot be moved in, both are taken out again: the new voice beside
    the backing of an earlier run, or either stem alone, would be served as if
    it were a pair, with a gain that fits only part of it.
    """
    vocals, no_vocals, gain = limit_stems(*combine_stems(sources))
    written: dict[str, Path] = {}
    for stem, wav in ((VOCALS, vocals), (NO_VOCALS, no_vocals)):
        written[stem] = work / STEM_FILES[stem]
        write_flac(written[stem], wav, samplerate)
    store.set_stem_gain(song_id, gain)
    try:
        for stem, path in written.items():
            store.install_stem(song_id, stem, path)
    except BaseException:
        _remove_stems(store, song_id)
        raise


def _remove_stems(store: SongStore, song_id: str) -> None:
    """Delete whichever of the song's stems exist.

    Best effort, because it runs while the error that called for it is on its
    way out and must not hide it: on Windows a stem that the browser is
    reading cannot be deleted, and the log then says which one stayed.
    """
    for stem in STEM_FILES:
        path = store.stem_path(song_id, stem)
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove %s after a failed install", path)
