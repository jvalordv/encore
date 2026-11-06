"""Reads a take's JSON export, and says plainly why it cannot.

Failures are `TakeFileError`s with a one-line message the command prints.
"""

import json
from pathlib import Path

from pydantic import ValidationError

from encore_service.take_analysis.schema import TakeFile

FORMAT = "encore-take"
SUPPORTED_VERSIONS = (1, 2)


class TakeFileError(Exception):
    """The take file cannot be analysed; the message says why."""


def load_take(path: Path) -> TakeFile:
    """Parse the export at `path` (version 1 or 2) into a `TakeFile`."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise TakeFileError(f"Cannot read {path}: {exc.strerror or exc}") from exc
    except ValueError as exc:
        raise TakeFileError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        raise TakeFileError(f"{path} is not an Encore take (format is not {FORMAT}).")
    version = raw.get("version")
    if version not in SUPPORTED_VERSIONS:
        raise TakeFileError(
            f"{path} is take version {version}; this reads versions 1 and 2."
        )
    try:
        take = TakeFile.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise TakeFileError(f"{path} has a bad field {where}: {first['msg']}") from exc
    if not take.frames:
        raise TakeFileError(f"{path} has no frames to analyse.")
    return take
