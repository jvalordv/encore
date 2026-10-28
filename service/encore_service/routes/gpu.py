"""GET /gpu: report what torch and the GPU look like from the service.

This is the first thing to check after setup (README.md). It must work
without torch installed, so torch is imported inside the handler. The models
the service holds in memory come from the registry in `registry.py`, which
is plain bookkeeping and needs no torch either.
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from encore_service import registry

router = APIRouter(tags=["gpu"])

_MIB = 1024 * 1024


class GpuStatus(BaseModel):
    """Device and VRAM report; unavailable values are null."""

    torch_available: bool
    cuda_available: bool
    device: str  # the device the service will use (ENCORE_DEVICE or auto)
    device_name: str | None = None
    vram_total_mb: int | None = None
    vram_free_mb: int | None = None
    # The models held in memory, as `family:name@device`: the first use of a
    # model loads it, so this is empty until a song has been prepared.
    loaded_models: list[str] = Field(default_factory=list)


@router.get("/gpu", response_model=GpuStatus)
def get_gpu(request: Request) -> GpuStatus:
    """Report torch and CUDA status without failing when torch is absent."""
    device = request.app.state.settings.device
    loaded = registry.loaded_models()
    try:
        import torch
    except (ImportError, OSError):
        # OSError: a broken CUDA runtime fails at import time on Windows.
        return GpuStatus(
            torch_available=False,
            cuda_available=False,
            device=device,
            loaded_models=loaded,
        )

    if not torch.cuda.is_available():
        return GpuStatus(
            torch_available=True,
            cuda_available=False,
            device=device,
            loaded_models=loaded,
        )

    free_bytes, total_bytes = torch.cuda.mem_get_info()
    return GpuStatus(
        torch_available=True,
        cuda_available=True,
        device=device,
        device_name=torch.cuda.get_device_name(torch.cuda.current_device()),
        vram_total_mb=total_bytes // _MIB,
        vram_free_mb=free_bytes // _MIB,
        loaded_models=loaded,
    )
