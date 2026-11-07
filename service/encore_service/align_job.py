"""The alignment jobs: a karaoke song to its original, a capture to its download.

Both run on the same single-worker queue as preparation, since they are CPU
work that should not overlap a model on the GPU. `queue_alignment` records
the alignment as queued in the karaoke song's status and queues the job;
`run_alignment` ends it `done` with the reference written, or `refused` with a
plain reason when the confidence is below the floor (nothing is written then),
or `failed`. `queue_capture_check` and `check_capture` measure how far a
tab capture sits from the download of the same video, with no key search.
"""

import logging
import tempfile
from collections.abc import Callable
from functools import partial
from pathlib import Path

import numpy as np

from encore_service import align
from encore_service.align_reference import map_key, map_reference
from encore_service.jobs import JobQueue
from encore_service.schemas import (
    AlignmentStatus,
    KeyMap,
    Reference,
    SongStatus,
    StepName,
)
from encore_service.separation import read_audio
from encore_service.store import SongStore

logger = logging.getLogger(__name__)

REFUSED_REASON = (
    "The arrangement differs too much from the original to follow its melody; "
    "Open scoring uses the key instead."
)
CAPTURE_FILE = "capture.wav"
# A capture's offset is only reported when it matched this well.
CAPTURE_CONFIDENCE_FLOOR = 0.6

Progress = Callable[[float], None]


def _chroma_of(path: Path) -> align.Chroma:
    """Chroma of a file's audio, mixed down to one channel.

    Read as the separation step reads it: ffmpeg decodes what libsndfile
    cannot (m4a, many channels) into a scratch folder that is then removed.
    """
    with tempfile.TemporaryDirectory(prefix="encore-align-") as scratch:
        wav, rate = read_audio(path, Path(scratch))
    return align.chroma(wav.mean(axis=0), rate)


def queue_alignment(
    store: SongStore, jobs: JobQueue, karaoke_id: str, original_id: str
) -> SongStatus:
    """Queue aligning `karaoke_id` to `original_id` and return the new status.

    A song already being aligned is left as it is. The caller has checked
    that both songs exist, have audio, and that the original has a reference.
    """
    jobs.submit(
        f"align:{karaoke_id}",
        partial(run_alignment, store, karaoke_id, original_id),
        on_accepted=lambda: store.update_status(
            karaoke_id,
            alignment=AlignmentStatus(state="queued", original_id=original_id),
        ),
    )
    status = store.read_status(karaoke_id)
    if status is None:
        raise FileNotFoundError(f"No status stored for song {karaoke_id}")
    return status


def _set(store: SongStore, song_id: str, original_id: str, **fields: object) -> None:
    store.update_status(
        song_id, alignment=AlignmentStatus(original_id=original_id, **fields)
    )


def run_alignment(store: SongStore, karaoke_id: str, original_id: str) -> None:
    """Do the alignment and record how it went; never raises."""

    def progress(value: float) -> None:
        _set(store, karaoke_id, original_id, state="running", progress=value)

    try:
        progress(0.0)
        _align(store, karaoke_id, original_id, progress)
    except Exception as exc:
        logger.exception("Aligning %s to %s failed", karaoke_id, original_id)
        _set(
            store,
            karaoke_id,
            original_id,
            state="failed",
            reason=str(exc) or type(exc).__name__,
        )


def _align(
    store: SongStore, karaoke_id: str, original_id: str, progress: Progress
) -> None:
    """The work of `run_alignment`; raises on anything unexpected."""
    karaoke_audio = store.source_path(karaoke_id)
    # The backing alone matches a karaoke track's instruments best; the full
    # mix is the fallback for an original that was never separated.
    original_audio = store.stem_path(original_id, "no_vocals") or store.source_path(
        original_id
    )
    ref_path = store.reference_path(original_id)
    if karaoke_audio is None or original_audio is None or ref_path is None:
        raise FileNotFoundError("A song's audio or the original's melody is missing.")
    karaoke = _chroma_of(karaoke_audio)
    original = _chroma_of(original_audio)
    progress(0.05)
    result = align.align(karaoke, original, report=lambda v: progress(0.05 + 0.9 * v))
    if result.confidence < align.CONFIDENCE_FLOOR:
        _set(
            store,
            karaoke_id,
            original_id,
            state="refused",
            key_offset=result.key_offset,
            confidence=result.confidence,
            reason=REFUSED_REASON,
        )
        return
    duration = len(karaoke.frames) * karaoke.hop_s
    reference = Reference.model_validate_json(ref_path.read_text(encoding="utf-8"))
    mapped = map_reference(
        reference,
        result.time_map,
        result.key_offset,
        original_id,
        result.confidence,
        duration,
    )
    # The karaoke's own key, measured from its backing, is direct evidence;
    # the original's shifted key only fills in when there is none.
    mapped_key: KeyMap | None = None
    original_key = store.key_path(original_id)
    if original_key is not None and store.key_path(karaoke_id) is None:
        key = KeyMap.model_validate_json(original_key.read_text(encoding="utf-8"))
        mapped_key = map_key(key, result.time_map, result.key_offset, duration)
    # Everything is built before anything is written, and the reference goes
    # last of the files: a failure never leaves a borrowed melody behind.
    if mapped_key is not None:
        store.write_key(karaoke_id, mapped_key)
        _settle_step(store, karaoke_id, "key")
    store.write_reference(karaoke_id, mapped)
    _settle_step(store, karaoke_id, "reference")
    _set(
        store,
        karaoke_id,
        original_id,
        state="done",
        progress=1.0,
        key_offset=result.key_offset,
        confidence=result.confidence,
    )


def _settle_step(store: SongStore, song_id: str, step: StepName) -> None:
    """Mark a step done, so a reload (and the next preparation) keeps its file."""
    store.update_step(
        song_id, step, state="done", progress=1.0, error=None, detail=None
    )


def queue_capture_check(store: SongStore, jobs: JobQueue, song_id: str) -> None:
    """Queue measuring a capture's offset from the song's download."""
    jobs.submit(f"capture-check:{song_id}", partial(check_capture, store, song_id))


def check_capture(store: SongStore, song_id: str) -> None:
    """Record `capture_offset_s`: how far the capture lags the download.

    Left None when either file is missing or the two do not match well, since
    an offset from a poor match would mislead the embed's timing.
    """
    source = store.source_path(song_id)
    capture = store.song_dir(song_id) / CAPTURE_FILE
    if source is None or not capture.is_file():
        return
    try:
        # A is the capture, so the map says where each capture second sits in
        # the download; the capture's lag is its time minus the download's.
        result = align.align(_chroma_of(capture), _chroma_of(source), search_key=False)
    except Exception:
        logger.exception("Capture check failed for %s", song_id)
        return
    offset: float | None = None
    if result.confidence >= CAPTURE_CONFIDENCE_FLOOR:
        tm = result.time_map
        offset = float(np.median(tm.from_s - tm.to_s))
    store.update_status(song_id, capture_offset_s=offset)
