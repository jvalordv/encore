"""Mic check analysis: `POST /takes/analyse`.

Takes the browser's take export (JSON, version 1 to 3) and optionally its WAV,
runs the same analysis as the `take_analysis` command and answers with the
findings and the settings it advises. The work is CPU-bound numpy, so the
route is a plain `def` and FastAPI runs it in its thread pool, off the event
loop. A file that cannot be read is a 422 with a plain `detail`.
"""

import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from encore_service.take_analysis.analyze import analyse_take
from encore_service.take_analysis.loader import TakeFileError, parse_take
from encore_service.take_analysis.mic_check import MicCheckAnalysis, build_mic_check
from encore_service.take_analysis.processing.tracker import Tracker, crepe_tracker
from encore_service.take_analysis.sections import SectionError

router = APIRouter(prefix="/takes", tags=["takes"])


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


@router.post("/analyse", response_model=MicCheckAnalysis)
def analyse_mic_check(
    take: Annotated[UploadFile, File(description="The take's JSON export.")],
    wav: Annotated[UploadFile | None, File(description="The take's WAV.")] = None,
    crepe: Annotated[bool, Form(description="Compare with torchcrepe.")] = True,
) -> MicCheckAnalysis:
    """Analyse a Mic check take and advise on the tunable settings."""
    try:
        text = take.file.read().decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _unprocessable("The take file is not UTF-8 text.") from exc
    name = take.filename or "take.json"
    try:
        parsed = parse_take(text, name)
    except TakeFileError as exc:
        raise _unprocessable(str(exc)) from exc
    tracker: Tracker | None = None
    note: str | None = None
    if crepe and wav is None:
        note = "The pitch comparison needs the WAV; none was sent."
    elif crepe:
        tracker, note = crepe_tracker()
    with tempfile.TemporaryDirectory() as folder:
        wav_path: Path | None = None
        if wav is not None:
            wav_path = Path(folder) / "take.wav"
            wav_path.write_bytes(wav.file.read())
        try:
            result = analyse_take(parsed, name, wav_path, None, 5.0, tracker, note)
        except (SectionError, RuntimeError, OSError) as exc:
            raise _unprocessable(f"The take cannot be analysed: {exc}") from exc
    out = build_mic_check(parsed, result)
    if note:
        out.notes.append(note)
    return out
