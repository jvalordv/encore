"""`POST /songs/{karaoke_id}/align`: borrow an original's melody for a karaoke song.

Queues the alignment job and answers with the karaoke song's status, whose
`alignment` the browser polls through `GET /songs/{id}`. Both songs must
exist and have audio, and the original must have a reference melody; the
reasons it cannot be done are 422s, so the browser gets the plain `detail`.
"""

from fastapi import APIRouter, HTTPException, Request

from encore_service.align_job import queue_alignment
from encore_service.jobs import JobQueue
from encore_service.schemas import AlignRequest, SongStatus
from encore_service.store import SongStore

router = APIRouter(prefix="/songs", tags=["songs"])


@router.post(
    "/{karaoke_id}/align",
    response_model=SongStatus,
    responses={
        404: {"description": "One of the songs is unknown."},
        422: {
            "description": (
                "The songs cannot be aligned: one has no audio, the original "
                "has no melody, the karaoke song is still being prepared, or "
                "they are the same song."
            )
        },
    },
)
def align_song(karaoke_id: str, body: AlignRequest, request: Request) -> SongStatus:
    """Queue aligning the karaoke song to the original's melody."""
    store: SongStore = request.app.state.store
    jobs: JobQueue = request.app.state.jobs
    original_id = body.original_id
    if karaoke_id == original_id:
        raise HTTPException(status_code=422, detail="A song cannot follow itself.")
    if not store.exists(karaoke_id) or not store.exists(original_id):
        raise HTTPException(status_code=404, detail="No such song.")
    if store.source_path(karaoke_id) is None:
        raise HTTPException(status_code=422, detail="The karaoke song has no audio.")
    status = store.read_status(karaoke_id)
    steps = status.steps if status is not None else None
    # The preparation may still overwrite the reference alignment writes (or
    # be about to find a vocal in it), so the song must have settled first.
    if steps is None or any(
        getattr(steps, name).state in ("queued", "running")
        for name in ("separation", "reference")
    ):
        raise HTTPException(
            status_code=422, detail="The karaoke song is still being prepared."
        )
    if store.source_path(original_id) is None:
        raise HTTPException(status_code=422, detail="The original has no audio.")
    if store.reference_path(original_id) is None:
        raise HTTPException(
            status_code=422, detail="The original has no melody to follow yet."
        )
    return queue_alignment(store, jobs, karaoke_id, original_id)
