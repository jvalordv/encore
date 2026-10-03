"""Song intake and preparation status.

Stub: both endpoints answer 501 until ROADMAP P2-T1 builds the cache, hash
and job queue. The signatures and response models are already the contract.
"""

from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile

from encore_service.schemas import SongStatus

router = APIRouter(prefix="/songs", tags=["songs"])


@router.post("", response_model=SongStatus)
async def create_song(
    file: Annotated[UploadFile, File(description="Song audio: mp3, wav or flac.")],
) -> SongStatus:
    """Accept a song, queue its preparation, and return its status."""
    raise HTTPException(
        status_code=501, detail="Not implemented: song intake is ROADMAP P2-T1."
    )


@router.get("/{song_id}", response_model=SongStatus)
async def get_song(song_id: str) -> SongStatus:
    """Report per-step preparation status for a song."""
    raise HTTPException(
        status_code=501, detail="Not implemented: song status is ROADMAP P2-T1."
    )
