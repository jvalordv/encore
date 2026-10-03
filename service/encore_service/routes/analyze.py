"""Take analysis.

Stub: answers 501 until ROADMAP P3-T1 adds pitch tracking, alignment and the
feature set. The signature and response model are already the contract.
"""

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from encore_service.schemas import TakeAnalysis

router = APIRouter(tags=["analyze"])


@router.post("/analyze", response_model=TakeAnalysis)
async def analyze_take(
    take: Annotated[UploadFile, File(description="The recorded take as WAV.")],
    song_id: Annotated[str, Form(description="Song the take was sung against.")],
    latency_s: Annotated[
        float, Form(description="Calibrated round-trip latency to remove.")
    ] = 0.0,
) -> TakeAnalysis:
    """Analyse a take against its song's reference."""
    raise HTTPException(
        status_code=501, detail="Not implemented: take analysis is ROADMAP P3-T1."
    )
