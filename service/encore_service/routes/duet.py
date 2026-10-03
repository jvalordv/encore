"""Duet support: singer enrollment and one-mic take splitting.

Stubs: enrollment answers 501 until ROADMAP P4-T2 and splitting until P4-T4.
The signatures and response models are already the contract.
"""

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from encore_service.schemas import DuetSplit

router = APIRouter(prefix="/duet", tags=["duet"])


class EnrollResult(BaseModel):
    """Outcome of enrolling one singer.

    Route-local on purpose: it is not part of the shared schema block, because
    the browser only needs to know the enrollment was stored.
    """

    singer_id: str
    embedding_dim: int


@router.post("/enroll", response_model=EnrollResult)
async def enroll_singer(
    singer_id: Annotated[str, Form(description="Id for this singer's profile.")],
    audio: Annotated[UploadFile, File(description="Glide and spoken sentence.")],
) -> EnrollResult:
    """Compute and store a speaker embedding for one singer."""
    raise HTTPException(
        status_code=501, detail="Not implemented: enrollment is ROADMAP P4-T2."
    )


@router.post("/split", response_model=DuetSplit)
async def split_take(
    take: Annotated[UploadFile, File(description="One-mic duet take as WAV.")],
    song_id: Annotated[str, Form(description="Song the take was sung against.")],
    singer_ids: Annotated[list[str], Form(description="Enrolled singers to assign.")],
) -> DuetSplit:
    """Assign each frame of a one-mic take to an enrolled singer."""
    raise HTTPException(
        status_code=501, detail="Not implemented: take splitting is ROADMAP P4-T4."
    )
