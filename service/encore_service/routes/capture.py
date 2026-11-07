"""Capture upload: a YouTube song's audio recorded from the playing tab.

`POST /songs/url/{video_id}/capture` takes the WAV the browser recorded while
the embedded video played and stores it as song `yt-<video id>`, exactly where
the link route would put a fetched video, so separation, the reference melody
and the key run for it as for any prepared link. This is the route that works
when the downloader is blocked. A song whose audio is a download keeps it as
its source: lossless timing, no room or tab-volume effects. The capture is
stored beside it as `capture.wav` for a later cross-check, and the response
says so. A song whose audio is an earlier capture takes the new one instead,
and what was derived from the old one is made again.
Same policy category as Prepare (ROADMAP, Policy flag):
the browser only calls this after the singer opts in.
"""

import math
from pathlib import Path
from typing import Annotated

import soundfile as sf
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from encore_service import youtube
from encore_service.align_job import queue_capture_check
from encore_service.config import Settings
from encore_service.jobs import JobQueue
from encore_service.pipeline import initial_status, queue_preparation
from encore_service.routes.songs import _receive, _title_from
from encore_service.schemas import CaptureResponse, StepStatus
from encore_service.store import (
    KEY_FILE,
    REFERENCE_FILE,
    STEM_FILES,
    SongMeta,
    SongStore,
)

router = APIRouter(prefix="/songs", tags=["songs"])

CAPTURE_FILE = "capture.wav"
SOURCE_EXT = ".wav"
_SECONDS_PER_MINUTE = 60
BAD_AUDIO_MESSAGE = "The capture is not readable WAV audio, or it is empty."


def _read_wav(path: Path) -> float:
    """Length in seconds of a readable, non-empty WAV; HTTP 422 otherwise."""
    try:
        info = sf.info(str(path))
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=422, detail=BAD_AUDIO_MESSAGE) from exc
    if info.format != "WAV" or info.frames <= 0 or info.duration <= 0:
        raise HTTPException(status_code=422, detail=BAD_AUDIO_MESSAGE)
    return float(info.duration)


@router.post(
    "/url/{video_id}/capture",
    response_model=CaptureResponse,
    responses={
        400: {"description": "The uploaded file is empty."},
        413: {"description": "The file is larger than the upload limit."},
        422: {"description": "Not a video id, or the audio is not usable."},
    },
)
def capture_song(
    video_id: str,
    request: Request,
    audio: Annotated[UploadFile, File(description="The captured tab audio, WAV.")],
    title: Annotated[str | None, Form()] = None,
) -> CaptureResponse:
    """Store a tab capture as the song's audio and queue its preparation."""
    store: SongStore = request.app.state.store
    jobs: JobQueue = request.app.state.jobs
    settings: Settings = request.app.state.settings

    if not youtube.is_video_id(video_id):
        raise HTTPException(status_code=422, detail="Not a YouTube video id.")
    song_id = f"yt-{video_id}"

    part = store.incoming_path()
    try:
        _receive(audio.file, part)
        duration_s = _read_wav(part)
        if duration_s > settings.max_song_s:
            minutes = math.ceil(duration_s / _SECONDS_PER_MINUTE)
            limit = math.ceil(settings.max_song_s / _SECONDS_PER_MINUTE)
            raise HTTPException(
                status_code=422,
                detail=(
                    f"The capture is {minutes} min long; "
                    f"the limit is {limit} min (ENCORE_MAX_SONG_S)."
                ),
            )
        return _install(store, jobs, song_id, video_id, part, duration_s, title)
    finally:
        part.unlink(missing_ok=True)


def _install(
    store: SongStore,
    jobs: JobQueue,
    song_id: str,
    video_id: str,
    part: Path,
    duration_s: float,
    title: str | None,
) -> CaptureResponse:
    """Make the capture the song's audio, or keep it beside a download."""
    existing = store.read_status(song_id) if store.exists(song_id) else None
    if (
        existing is not None
        and existing.audio_source == "download"
        and store.source_path(song_id) is not None
    ):
        # The incoming folder is on the cache's volume, so the move is atomic.
        part.replace(store.song_dir(song_id) / CAPTURE_FILE)
        status = queue_preparation(store, jobs, song_id)
        queue_capture_check(store, jobs, song_id)
        return CaptureResponse(
            **status.model_dump(),
            alongside=True,
            message=(
                "The song already has audio, which stays the source; "
                "the capture is stored beside it."
            ),
        )

    if existing is not None and existing.audio_source == "capture":
        _forget_derived(store, song_id)

    meta = SongMeta(
        source="youtube",
        title=_title_from(title or "") or f"YouTube video {video_id}",
        url=youtube.canonical_url(video_id),
        duration_s=duration_s,
        video_id=video_id,
        audio_source="capture",
    )
    status = initial_status(song_id, meta)
    # The audio is here, so the fetch step has nothing left to do; marking it
    # done is what keeps the queue from downloading the video as well.
    status.steps.fetch = StepStatus(state="done", progress=1.0)
    store.add_link(song_id, meta, status)
    store.install_source(song_id, part, SOURCE_EXT)
    # A song another request created first keeps its own meta; this makes the
    # capture's origin and length the record either way.
    store.set_audio_source(song_id, "capture")
    store.set_duration(song_id, duration_s)
    # An existing link whose fetch failed or never ran has the step queued or
    # failed; with the audio in place that step is done.
    store.update_step(
        song_id, "fetch", state="done", progress=1.0, error=None, detail=None
    )
    result = queue_preparation(store, jobs, song_id)
    return CaptureResponse(
        **result.model_dump(),
        alongside=False,
        message="Capture stored as the song's audio; preparing it.",
    )


def _forget_derived(store: SongStore, song_id: str) -> None:
    """Drop what an earlier capture's audio made, so the steps run again.

    The stems and key leave files whose absence makes their steps not done;
    the reference leaves none that `_is_done` checks, so every step after the
    fetch is queued afresh as well.
    """
    folder = store.song_dir(song_id)
    for name in (*STEM_FILES.values(), KEY_FILE, REFERENCE_FILE):
        (folder / name).unlink(missing_ok=True)
    for step in ("separation", "key", "reference", "lyrics"):
        store.update_step(
            song_id, step, state="queued", progress=0.0, error=None, detail=None
        )
