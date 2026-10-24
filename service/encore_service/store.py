"""The on-disk song cache: its folder layout and every read and write of it.

A song lives in `<cache_dir>/<song_id>/` as `source.<ext>` (the audio),
`meta.json` (what the song is) and `status.json` (how far preparation has
got). Uploads stream into `<cache_dir>/.incoming/` first and are moved into
place once hashed. A linked song is created with no audio at all; its fetch
step works in a folder of its own and moves the finished file into place
(`install_source`). The routes, the job queue and the preparation steps all
reach the cache through `SongStore`, so this is the one module that builds a
path from an id, and the id check that guards against path traversal lives
here too.
"""

import logging
import os
import re
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from encore_service.schemas import (
    SongSource,
    SongStatus,
    SongSteps,
    StepName,
    StepStatus,
)

logger = logging.getLogger(__name__)

ModelT = TypeVar("ModelT", bound=BaseModel)

# Per-song JSON files; every write to them goes through _write_json.
STATUS_FILE = "status.json"
META_FILE = "meta.json"
# Under the cache root; uploads stream here before they are named by hash.
INCOMING_DIR = ".incoming"

# Extensions a source file may have, with the media type served for each.
AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
}

# Written to a step's error by recover_interrupted; shown to the user as is.
INTERRUPTED_MESSAGE = (
    "Interrupted: the service stopped while this step ran. Add the song again to retry."
)

# The sha256 of an uploaded file, or "yt-" and an 11-character YouTube id.
_ID_PATTERN = re.compile(r"[0-9a-f]{64}|yt-[A-Za-z0-9_-]{11}")

# On Windows a virus scanner, or a reader that has the target open, makes
# os.replace fail with PermissionError for a few milliseconds.
_REPLACE_ATTEMPTS = 5
_REPLACE_RETRY_S = 0.02


def is_valid_id(song_id: str) -> bool:
    """True when `song_id` is shaped like a file hash or a YouTube video id."""
    # fullmatch rather than anchors: `$` also matches before a trailing
    # newline, which would let "<hash>\n" through.
    return _ID_PATTERN.fullmatch(song_id) is not None


class SongMeta(BaseModel):
    """What a song is, persisted as meta.json; not part of the HTTP contract."""

    source: SongSource
    title: str | None = None
    url: str | None = None  # the link a youtube song came from; None for files
    duration_s: float | None = None
    video_id: str | None = None  # None for files


def _replace(src: Path, dst: Path) -> None:
    """os.replace that rides out a briefly locked target."""
    for attempt in range(1, _REPLACE_ATTEMPTS + 1):
        try:
            os.replace(src, dst)
        except PermissionError:
            if attempt == _REPLACE_ATTEMPTS:
                raise
            time.sleep(_REPLACE_RETRY_S * attempt)
        else:
            return


def _write_json(path: Path, model: BaseModel) -> None:
    """Write `model` to `path` atomically; the caller holds the store lock."""
    tmp = path.with_name(path.name + ".tmp")
    try:
        # Bytes, not text mode, so Windows does not turn newlines into CRLF.
        tmp.write_bytes(model.model_dump_json(indent=2).encode("utf-8"))
        _replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _load(path: Path, model: type[ModelT]) -> ModelT | None:
    """Read `path` as `model`; None when missing or unreadable."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    try:
        return model.model_validate_json(raw)
    except ValueError:
        # Hand-edited or damaged. Treating it as missing lets adding the song
        # again repair it, where raising would fail every poll of that song.
        logger.warning("Ignoring unreadable %s", path)
        return None


class SongStore:
    """Reads and writes the song cache; safe to share between threads."""

    def __init__(self, root: Path) -> None:
        self.root = root
        # One lock for every JSON file. The request thread and the worker both
        # write status.json, and a reader must not open it mid-replace: on
        # Windows that can fail the replace.
        self._lock = threading.Lock()

    def song_dir(self, song_id: str) -> Path:
        """Path of a song's folder; raises ValueError for an invalid id."""
        if not is_valid_id(song_id):
            raise ValueError(f"Invalid song id: {song_id!r}")
        return self.root / song_id

    def exists(self, song_id: str) -> bool:
        """True when the song is cached; unknown and invalid ids are not."""
        # status.json is written last, so a folder that a crash left half
        # made does not count as a song.
        return self.read_status(song_id) is not None

    def read_status(self, song_id: str) -> SongStatus | None:
        """The stored status; None for an unknown or invalid id."""
        if not is_valid_id(song_id):
            return None
        with self._lock:
            return _load(self.root / song_id / STATUS_FILE, SongStatus)

    def write_status(self, song_id: str, status: SongStatus) -> None:
        """Replace a song's status.json; the song's folder must exist."""
        folder = self.song_dir(song_id)
        if status.song_id != song_id:
            raise ValueError(f"Status is for {status.song_id!r}, not {song_id!r}")
        with self._lock:
            _write_json(folder / STATUS_FILE, status)

    def update_step(self, song_id: str, step: StepName, **changes: Any) -> SongStatus:
        """Merge `changes` into one step's status as a locked read-modify-write.

        Returns the new status. Raises ValueError for an unknown step or field
        or an invalid value, and FileNotFoundError when the song has no status.
        """
        folder = self.song_dir(song_id)
        if step not in SongSteps.model_fields:
            raise ValueError(f"Unknown step: {step!r}")
        unknown = changes.keys() - StepStatus.model_fields.keys()
        if unknown:
            raise ValueError(f"Unknown step fields: {sorted(unknown)}")
        with self._lock:
            status = _load(folder / STATUS_FILE, SongStatus)
            if status is None:
                raise FileNotFoundError(f"No status stored for song {song_id}")
            current: StepStatus = getattr(status.steps, step)
            # Validate the merge: model_copy(update=...) would let a bad
            # progress value into the file, to fail every later read.
            merged = StepStatus.model_validate({**current.model_dump(), **changes})
            setattr(status.steps, step, merged)
            _write_json(folder / STATUS_FILE, status)
            return status

    def read_meta(self, song_id: str) -> SongMeta | None:
        """The stored meta; None for an unknown or invalid id."""
        if not is_valid_id(song_id):
            return None
        with self._lock:
            return _load(self.root / song_id / META_FILE, SongMeta)

    def write_meta(self, song_id: str, meta: SongMeta) -> None:
        """Replace a song's meta.json; the song's folder must exist."""
        folder = self.song_dir(song_id)
        with self._lock:
            _write_json(folder / META_FILE, meta)

    def source_path(self, song_id: str) -> Path | None:
        """The finished source audio file, or None if there is none yet."""
        if not is_valid_id(song_id):
            return None
        folder = self.root / song_id
        # A whitelist of names, so a half-written download is never served.
        for ext in sorted(AUDIO_MEDIA_TYPES):
            candidate = folder / f"source{ext}"
            if candidate.is_file():
                return candidate
        return None

    def incoming_path(self) -> Path:
        """A fresh path to stream one upload into; the file is not created."""
        folder = self.root / INCOMING_DIR
        folder.mkdir(parents=True, exist_ok=True)
        return folder / f"{uuid.uuid4()}.part"

    def add_upload(
        self,
        song_id: str,
        part: Path,
        ext: str,
        meta: SongMeta,
        status: SongStatus,
    ) -> SongStatus:
        """Move a hashed upload into the cache as a new song.

        Returns the stored status: `status` for a new song, or the existing
        one when the song is already cached, in which case `part` is deleted,
        unless the cached song has lost its audio and `part` becomes it. The
        status is written last so a crash part-way leaves no song behind.
        """
        if ext not in AUDIO_MEDIA_TYPES:
            raise ValueError(f"Unsupported source extension: {ext!r}")
        folder = self.song_dir(song_id)
        if status.song_id != song_id:
            raise ValueError(f"Status is for {status.song_id!r}, not {song_id!r}")
        # Held across the whole creation so two identical uploads arriving
        # together cannot interleave their writes.
        with self._lock:
            existing = _load(folder / STATUS_FILE, SongStatus)
            if existing is not None:
                if self.source_path(song_id) is None:
                    # The id is the hash of the audio, so these bytes are the
                    # audio that went missing; keeping them is the only way
                    # adding the file again can mend the song.
                    _replace(part, folder / f"source{ext}")
                else:
                    part.unlink(missing_ok=True)
                return existing
            folder.mkdir(parents=True, exist_ok=True)
            _replace(part, folder / f"source{ext}")
            _write_json(folder / META_FILE, meta)
            _write_json(folder / STATUS_FILE, status)
            return status

    def add_link(self, song_id: str, meta: SongMeta, status: SongStatus) -> SongStatus:
        """Create a linked song that has no audio yet.

        Like `add_upload` without a part file: returns the stored status,
        `status` for a new song or the existing one when another request
        created the song first, and writes the status last so a crash
        part-way leaves no song behind.
        """
        folder = self.song_dir(song_id)
        if status.song_id != song_id:
            raise ValueError(f"Status is for {status.song_id!r}, not {song_id!r}")
        # Held across the whole creation, as in add_upload, so two requests
        # for the same video cannot interleave their writes.
        with self._lock:
            existing = _load(folder / STATUS_FILE, SongStatus)
            if existing is not None:
                return existing
            folder.mkdir(parents=True, exist_ok=True)
            _write_json(folder / META_FILE, meta)
            _write_json(folder / STATUS_FILE, status)
            return status

    def install_source(self, song_id: str, finished: Path, ext: str) -> Path:
        """Move a finished audio file into the song's folder as `source<ext>`.

        The move is atomic, so `source<ext>` is either absent or whole and a
        half-written download is never served. `finished` should be on the
        same volume as the cache, which a file in the song's own folder is.
        """
        if ext not in AUDIO_MEDIA_TYPES:
            raise ValueError(f"Unsupported source extension: {ext!r}")
        target = self.song_dir(song_id) / f"source{ext}"
        with self._lock:
            _replace(finished, target)
        return target

    def set_duration(self, song_id: str, duration_s: float) -> SongStatus:
        """Record a song's measured length in meta.json and status.json.

        Both files change under one hold of the lock, so no reader sees them
        disagree. Returns the new status; raises FileNotFoundError when the
        song has no status.
        """
        folder = self.song_dir(song_id)
        with self._lock:
            status = _load(folder / STATUS_FILE, SongStatus)
            if status is None:
                raise FileNotFoundError(f"No status stored for song {song_id}")
            meta = _load(folder / META_FILE, SongMeta)
            if meta is not None:
                meta.duration_s = duration_s
                _write_json(folder / META_FILE, meta)
            status.duration_s = duration_s
            _write_json(folder / STATUS_FILE, status)
            return status

    def recover_interrupted(self) -> list[str]:
        """Fail every step a stopped service left running; returns song ids.

        Called once at startup, before the queue starts, so a "running" step
        in a status file always belongs to a process that no longer exists.
        """
        recovered: list[str] = []
        for song_id in self._song_ids():
            path = self.root / song_id / STATUS_FILE
            with self._lock:
                status = _load(path, SongStatus)
                if status is None:
                    continue
                changed = False
                for name in SongSteps.model_fields:
                    step: StepStatus = getattr(status.steps, name)
                    if step.state != "running":
                        continue
                    setattr(
                        status.steps,
                        name,
                        step.model_copy(
                            update={
                                "state": "failed",
                                "error": INTERRUPTED_MESSAGE,
                                "detail": None,
                            }
                        ),
                    )
                    changed = True
                if changed:
                    _write_json(path, status)
                    recovered.append(song_id)
        return recovered

    def ids_waiting_to_run(self) -> list[str]:
        """Ids of songs whose preparation was queued but never got its turn.

        A song counts when a step is still `queued` and none has `failed`. A
        failure, such as the one recover_interrupted records, is left for the
        person to retry by adding the song again: resuming it here would run
        the step that may have stopped the service, over and over. Call it
        after recover_interrupted, so no step is left "running".
        """
        waiting: list[str] = []
        for song_id in self._song_ids():
            with self._lock:
                status = _load(self.root / song_id / STATUS_FILE, SongStatus)
            if status is None:
                continue
            states = {
                getattr(status.steps, name).state for name in SongSteps.model_fields
            }
            if "queued" in states and "failed" not in states:
                waiting.append(song_id)
        return waiting

    def clear_incoming(self) -> int:
        """Delete part files an interrupted upload left; returns how many.

        Called once at startup, when no upload can be in flight.
        """
        folder = self.root / INCOMING_DIR
        if not folder.is_dir():
            return 0
        removed = 0
        for part in folder.glob("*.part"):
            part.unlink(missing_ok=True)
            removed += 1
        return removed

    def _song_ids(self) -> Iterator[str]:
        """Ids of the song folders on disk, in name order."""
        if not self.root.is_dir():
            return
        for entry in sorted(self.root.iterdir()):
            if entry.is_dir() and is_valid_id(entry.name):
                yield entry.name
