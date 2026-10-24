"""Song intake, preparation status and the cached audio.

`POST /songs` takes an uploaded audio file, names the song by the sha256 of
its bytes, stores it in the cache and queues its preparation. Adding the same
file again is a cache hit that queues whatever has not finished, and puts back
the audio if that has gone missing from the cache. `GET
/songs/{id}` reports per-step progress for the browser to poll, and `GET
/songs/{id}/audio` serves the stored source so a song can be reloaded without
the original file. Storage lives in `store.py`, the queue in `jobs.py` and the
steps in `pipeline.py`; this module is the HTTP edge over them.
"""

import hashlib
from functools import partial
from pathlib import Path, PureWindowsPath
from typing import Annotated, BinaryIO

import soundfile as sf
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from encore_service.jobs import JobQueue
from encore_service.pipeline import initial_status, prepare
from encore_service.schemas import SongStatus
from encore_service.store import AUDIO_MEDIA_TYPES, SongMeta, SongStore

router = APIRouter(prefix="/songs", tags=["songs"])

_MIB = 1024 * 1024
# The service is local, so this only keeps a wrong file (a video, a disk
# image) from filling the cache. It is checked while the upload is copied into
# the cache, after the framework has received the whole body, so it does not
# spare the temp folder that the framework spools the body into.
MAX_UPLOAD_BYTES = 200 * _MIB
_CHUNK_BYTES = _MIB
_TITLE_MAX_CHARS = 200


def _receive(source: BinaryIO, part: Path) -> str:
    """Copy an upload into `part` and return its sha256; enforces the limits."""
    digest = hashlib.sha256()
    size = 0
    with part.open("wb") as out:
        while chunk := source.read(_CHUNK_BYTES):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                limit = MAX_UPLOAD_BYTES // _MIB
                raise HTTPException(
                    status_code=413, detail=f"The file is over the {limit} MiB limit."
                )
            digest.update(chunk)
            out.write(chunk)
    if size == 0:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    return digest.hexdigest()


def _duration_s(path: Path) -> float | None:
    """Length of the audio in seconds; None where libsndfile cannot read it."""
    # It cannot read m4a, for one. The duration is a nicety, so a song it
    # cannot measure is still accepted.
    try:
        return float(sf.info(str(path)).duration)
    except (RuntimeError, OSError):
        return None


def _title_from(stem: str) -> str | None:
    """A display title from a file name without its extension."""
    return stem.strip()[:_TITLE_MAX_CHARS].rstrip() or None


@router.post(
    "",
    response_model=SongStatus,
    responses={
        400: {"description": "The uploaded file is empty."},
        413: {"description": "The file is larger than the upload limit."},
        415: {"description": "Not one of the accepted audio file types."},
    },
)
def create_song(
    request: Request,
    file: Annotated[
        UploadFile,
        File(description="Song audio: mp3, wav, flac, m4a, ogg or opus."),
    ],
) -> SongStatus:
    """Accept a song, queue its preparation, and return its status."""
    store: SongStore = request.app.state.store
    jobs: JobQueue = request.app.state.jobs

    # PureWindowsPath splits on both kinds of slash, whatever the client sent.
    name = PureWindowsPath(file.filename or "")
    ext = name.suffix.lower()
    if ext not in AUDIO_MEDIA_TYPES:
        accepted = ", ".join(AUDIO_MEDIA_TYPES)
        raise HTTPException(
            status_code=415, detail=f"Unsupported audio file. Accepted: {accepted}."
        )

    part = store.incoming_path()
    try:
        song_id = _receive(file.file, part)
        status = store.read_status(song_id)
        # A cached song with no audio goes through add_upload too, which keeps
        # the upload as the audio it lost.
        if status is None or store.source_path(song_id) is None:
            meta = SongMeta(
                source="file",
                title=_title_from(name.stem),
                duration_s=_duration_s(part),
            )
            status = store.add_upload(
                song_id, part, ext, meta, initial_status(song_id, meta)
            )
    finally:
        # Gone already after a successful move; this catches every error path
        # and the cache hit, which leaves the upload where it was streamed.
        part.unlink(missing_ok=True)

    # Idempotent: a repeat while the song is queued or running is ignored, and
    # a repeat after a failure retries the steps that did not finish.
    jobs.submit(song_id, partial(prepare, store, song_id))
    return status


@router.get(
    "/{song_id}",
    response_model=SongStatus,
    responses={404: {"description": "No such song."}},
)
def get_song(song_id: str, request: Request) -> SongStatus:
    """Report per-step preparation status for a song."""
    store: SongStore = request.app.state.store
    # read_status answers None for an invalid id too, so a malformed id and an
    # unknown one get the same 404.
    status = store.read_status(song_id)
    if status is None:
        raise HTTPException(status_code=404, detail="No such song.")
    return status


@router.get(
    "/{song_id}/audio",
    response_class=FileResponse,
    responses={
        404: {"description": "No such song."},
        409: {"description": "The song has no source audio yet."},
    },
)
def get_song_audio(song_id: str, request: Request) -> FileResponse:
    """Serve the song's source audio from the cache."""
    store: SongStore = request.app.state.store
    if not store.exists(song_id):
        raise HTTPException(status_code=404, detail="No such song.")
    source = store.source_path(song_id)
    if source is None:
        raise HTTPException(status_code=409, detail="Song not fetched yet.")
    return FileResponse(source, media_type=AUDIO_MEDIA_TYPES[source.suffix])
