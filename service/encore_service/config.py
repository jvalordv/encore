"""Runtime settings for the encore service.

Read from environment variables when the app is created. A plain dataclass
keeps the dependency list short: nothing here needs pydantic-settings. The
compute device is resolved lazily so that importing this module never imports
torch, which keeps start-up fast and lets the service run without it.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Self

# Port the browser app expects the service on (docs/ARCHITECTURE.md).
DEFAULT_PORT = 8765
# The Vite dev server, by name and by loopback address, for CORS.
DEFAULT_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
# service/cache, next to the package rather than relative to the working
# directory, so the cache is the same wherever uvicorn is launched from.
DEFAULT_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"


def cuda_available() -> bool:
    """Return True when torch is importable and sees a CUDA device."""
    try:
        import torch
    except (ImportError, OSError):
        # OSError covers a broken CUDA runtime, which on Windows surfaces as
        # a DLL load failure at import time rather than an ImportError.
        return False
    return bool(torch.cuda.is_available())


@dataclass(frozen=True)
class Settings:
    """Service configuration; build it with `Settings.from_env()`."""

    device_override: str | None = None
    cache_dir: Path = DEFAULT_CACHE_DIR
    port: int = DEFAULT_PORT
    allowed_origins: tuple[str, ...] = DEFAULT_ORIGINS

    @cached_property
    def device(self) -> str:
        """ENCORE_DEVICE if set, else cuda when torch sees it, else cpu."""
        if self.device_override:
            return self.device_override
        return "cuda" if cuda_available() else "cpu"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Self:
        """Read ENCORE_* variables from `env` (default: the process env)."""
        env = os.environ if env is None else env

        device = env.get("ENCORE_DEVICE", "").strip().lower() or None

        cache_raw = env.get("ENCORE_CACHE_DIR", "").strip()
        cache_dir = Path(cache_raw).expanduser() if cache_raw else DEFAULT_CACHE_DIR

        port_raw = env.get("ENCORE_PORT", "").strip()
        try:
            port = int(port_raw) if port_raw else DEFAULT_PORT
        except ValueError:
            raise ValueError(
                f"ENCORE_PORT must be an integer, got {port_raw!r}"
            ) from None

        origins = tuple(
            o.strip()
            for o in env.get("ENCORE_ALLOWED_ORIGINS", "").split(",")
            if o.strip()
        )

        return cls(
            device_override=device,
            cache_dir=cache_dir,
            port=port,
            allowed_origins=origins or DEFAULT_ORIGINS,
        )
