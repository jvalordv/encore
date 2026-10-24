"""Song intake, preparation status and the cached audio.

`POST /songs` takes an uploaded audio file, names the song by the sha256 of
its bytes, stores it in the cache and queues its preparation. Adding the same
file again is a cache hit that queues whatever has not finished, and puts back
the audio if that has gone missing from the cache. `POST /songs/url` takes a
link to one YouTube video instead: it checks the link, asks YouTube what the
video is, and creates the song as `yt-<video id>` for the fetch step to fill.
`GET /songs/{id}` reports per-step progress for the browser to poll, and `GET
/songs/{id}/audio` serves the stored source so a song can be reloaded without
the original file. `GET /songs/{id}/stems/{stem}` serves the vocal or the
backing that the separation step made, with the level they were scaled by in
the `X-Stem-Gain` header. Storage lives in `store.py`, the queue in `jobs.py`,
the steps in `pipeline.py` and the YouTube access in `youtube.py`; this module
is the HTTP edge over them.
"""

import hashlib
import math
from pathlib import Path, PureWindowsPath
from typing import Annotated, BinaryIO

import soundfile as sf
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from encore_service import youtube
from encore_service.config import Settings
from encore_service.jobs import JobQueue
from encore_service.pipeline import initial_status, queue_preparation
from encore_service.schemas import SongLinkRequest, SongStatus
from encore_service.store import (
    AUDIO_MEDIA_TYPES,
    STEM_FILES,
    STEM_MEDIA_TYPE,
    SongMeta,
    SongStore,
)

router = APIRouter(prefix="/songs", tags=["songs"])

# Sent with each stem: what both stems were scaled by so that neither clips
# (1.0 if they were not), which the original must be scaled by to be mixed
# with them. A header rather than a field of the status, so the player gets it
# with the very file it belongs to. app.py lets a page on another origin read
# it.
STEM_GAIN_HEADER = "X-Stem-Gain"

_MIB = 1024 * 1024
# The service is local, so this only keeps a wrong file (a video, a disk
# image) from filling the cache. It is checked while the upload is copied into
# the cache, after the framework has received the whole body, so it does not
# spare the temp folder that the framework spools the body into.
MAX_UPLOAD_BYTES = 200 * _MIB
_CHUNK_BYTES = _MIB
_TITLE_MAX_CHARS = 200
_SECONDS_PER_MINUTE = 60

NOT_A_LINK_MESSAGE = (
    "Not a YouTube video link. Paste a link to one video "
    "(youtube.com/watch?v=..., youtu.be/..., or a Shorts link)."
)
LIVE_MESSAGE = "Live streams and premieres cannot be practised; pick a finished video."


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
        # A cached song with no audio goes through add_upload too, which keeps
        # the upload as the audio it lost.
        if not store.exists(song_id) or store.source_path(song_id) is None:
            meta = SongMeta(
                source="file",
                title=_title_from(name.stem),
                duration_s=_duration_s(part),
            )
            store.add_upload(song_id, part, ext, meta, initial_status(song_id, meta))
    finally:
        # Gone already after a successful move; this catches every error path
        # and the cache hit, which leaves the upload where it was streamed.
        part.unlink(missing_ok=True)

    # Idempotent: a repeat while the song is queued or running is ignored, and
    # a repeat after a failure retries the steps that did not finish.
    return queue_preparation(store, jobs, song_id)


@router.post(
    "/url",
    response_model=SongStatus,
    responses={
        422: {"description": "Not a link to one finished video, or too long."},
        502: {"description": "YouTube, or yt-dlp, could not answer."},
    },
)
def create_song_from_link(body: SongLinkRequest, request: Request) -> SongStatus:
    """Accept a link to one YouTube video, queue it, and return its status."""
    store: SongStore = request.app.state.store
    jobs: JobQueue = request.app.state.jobs
    settings: Settings = request.app.state.settings

    video_id = youtube.parse_youtube_url(body.url)
    if video_id is None:
        raise HTTPException(status_code=422, detail=NOT_A_LINK_MESSAGE)
    song_id = f"yt-{video_id}"

    # A repeat of a video needs no question to YouTube: the song is cached,
    # and adding it again retries whatever did not finish.
    if store.exists(song_id):
        return queue_preparation(store, jobs, song_id)

    try:
        info = youtube.lookup(video_id, settings)
    except youtube.YtDlpError as exc:
        raise HTTPException(
            status_code=502,
            detail=youtube.describe_failure("YouTube lookup failed", exc),
        ) from exc
    if info.is_live or info.duration_s is None:
        raise HTTPException(status_code=422, detail=LIVE_MESSAGE)
    if info.duration_s > settings.max_song_s:
        minutes = math.ceil(info.duration_s / _SECONDS_PER_MINUTE)
        limit = math.ceil(settings.max_song_s / _SECONDS_PER_MINUTE)
        raise HTTPException(
            status_code=422,
            detail=(
                f"This video is {minutes} min long; "
                f"the limit is {limit} min (ENCORE_MAX_SONG_S)."
            ),
        )

    meta = SongMeta(
        source="youtube",
        title=_title_from(info.title),
        url=youtube.canonical_url(video_id),
        duration_s=info.duration_s,
        video_id=video_id,
    )
    # If another request created the song since the check above, this keeps
    # its status and the preparation below is queued once either way.
    store.add_link(song_id, meta, initial_status(song_id, meta))
    return queue_preparation(store, jobs, song_id)


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


@router.get(
    "/{song_id}/stems/{stem}",
    response_class=FileResponse,
    responses={
        404: {"description": "No such song, or no such stem."},
        409: {"description": "The song has not been separated yet."},
    },
)
def get_song_stem(song_id: str, stem: str, request: Request) -> FileResponse:
    """Serve one stem of the song, `vocals` or `no_vocals`, as 24-bit FLAC.

    The stems are the model's estimates, not an exact split of the song. The
    response carries the song's stem gain in the X-Stem-Gain header: divide a
    stem by it for its level on the song's own scale.
    """
    store: SongStore = request.app.state.store
    if not store.exists(song_id):
        raise HTTPException(status_code=404, detail="No such song.")
    # A name that is no stem is told apart from a stem not made yet, which
    # stem_path alone could not do. The name is only ever a key into STEM_FILES,
    # so nothing in the request reaches the file system.
    if stem not in STEM_FILES:
        raise HTTPException(status_code=404, detail="No such stem.")
    path = store.stem_path(song_id, stem)
    if path is None:
        raise HTTPException(status_code=409, detail="Song not separated yet.")
    meta = store.read_meta(song_id)
    # Without a readable meta the gain is not known, and 1.0 is what a song
    # whose stems were not scaled records.
    gain = meta.stem_gain if meta is not None else 1.0
    return FileResponse(
        path, media_type=STEM_MEDIA_TYPE, headers={STEM_GAIN_HEADER: str(gain)}
    )
