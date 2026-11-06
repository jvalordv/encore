"""Reads a take's JSON export, and says plainly why it cannot.

Failures are `TakeFileError`s with a one-line message the command prints and
the endpoint returns as a 422.
"""

import json
from pathlib import Path

from pydantic import ValidationError

from encore_service.take_analysis.schema import TakeFile

FORMAT = "encore-take"
SUPPORTED_VERSIONS = (1, 2, 3)


class TakeFileError(Exception):
    """The take file cannot be analysed; the message says why."""


def load_take(path: Path) -> TakeFile:
    """Parse the export at `path` (version 1 to 3) into a `TakeFile`."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise TakeFileError(f"Cannot read {path}: {exc.strerror or exc}") from exc
    return parse_take(text, str(path))


def parse_take(text: str, label: str) -> TakeFile:
    """Parse export text; `label` names the source in the error messages."""
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise TakeFileError(f"{label} is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        raise TakeFileError(f"{label} is not an Encore take (format is not {FORMAT}).")
    version = raw.get("version")
    if version not in SUPPORTED_VERSIONS:
        raise TakeFileError(
            f"{label} is take version {version}; this reads versions 1 to 3."
        )
    try:
        take = TakeFile.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise TakeFileError(f"{label} has a bad field {where}: {first['msg']}") from exc
    if not take.frames:
        raise TakeFileError(f"{label} has no frames to analyse.")
    return take
