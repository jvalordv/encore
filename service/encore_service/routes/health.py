"""GET /health: liveness probe the browser uses to detect the service."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from encore_service import __version__

router = APIRouter(tags=["health"])


class HealthStatus(BaseModel):
    """Liveness response."""

    status: Literal["ok"]
    version: str


@router.get("/health", response_model=HealthStatus)
def get_health() -> HealthStatus:
    """Report that the service is up and which version it is."""
    return HealthStatus(status="ok", version=__version__)
