"""The backing step: the song's instrumental written out as notes.

`transcribe_backing` is the runner registered for the `backing` step in
`pipeline.py`. It has a polyphonic transcription model (Basic Pitch) listen
to `no_vocals.flac` and stores the notes it hears as `backing.json`, which the
browser gets from `GET /songs/{id}/backing` and draws in grey behind the
melody. Chords come out as overlapping notes.

The model is reached through the `Transcriber` callable and `load_transcriber`,
which tests replace, so no test needs the model. Nothing here imports
basic_pitch until a song is transcribed: the module loads, and the rest of the
service runs, without Basic Pitch installed, and the step is then skipped
with the command that installs it.

Accuracy is rough on a dense mix (drums and vocals leak into the stem, and
many instruments share a register), so the notes are a guide to the harmony,
not a score. Two gates keep the worst of the noise out: a note shorter than
MIN_NOTE_S is dropped, and so is a note whose model amplitude is under
MIN_AMPLITUDE. Velocity is that amplitude on MIDI's 1..127 scale.
"""

import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

from encore_service.errors import StepSkipped
from encore_service.schemas import BackingNote, BackingNotes
from encore_service.store import SongStore

logger = logging.getLogger(__name__)

Report = Callable[[float], None]

# Notes shorter than this are the model's flicker, not music.
MIN_NOTE_S = 0.03
# The model's own 0..1 strength for a note; below this it is mostly guessing.
MIN_AMPLITUDE = 0.25

INSTALL_HINT = (
    "Backing notes need Basic Pitch, which is not installed: it would "
    "downgrade numpy for the other steps (see service/README.md, "
    '"Backing notes").'
)
READ_PROGRESS = 0.05


@dataclass(frozen=True)
class RawNote:
    """A note as the model reports it, before the gates."""

    start_s: float
    end_s: float
    midi: int
    amplitude: float


# Turns an audio file into the model's notes.
Transcriber = Callable[[Path], list[RawNote]]


class BackingError(RuntimeError):
    """The backing step failed; the message reads "<what failed>: <why>"."""


def filter_notes(raw: Iterable[RawNote]) -> BackingNotes:
    """Gate the model's notes and put them in onset order as `BackingNotes`."""
    kept: list[BackingNote] = []
    for note in raw:
        if note.end_s - note.start_s < MIN_NOTE_S or note.amplitude < MIN_AMPLITUDE:
            continue
        if not 0 <= note.midi <= 127:
            continue
        kept.append(
            BackingNote(
                onset_s=round(max(note.start_s, 0.0), 3),
                offset_s=round(note.end_s, 3),
                midi=int(note.midi),
                velocity=min(max(round(note.amplitude * 127), 1), 127),
            )
        )
    kept.sort(key=lambda n: (n.onset_s, n.midi))
    return BackingNotes(notes=kept)


def load_transcriber() -> Transcriber:
    """Basic Pitch as a `Transcriber`; skips the step when it is not installed."""
    try:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model, predict
    except ImportError as exc:
        raise StepSkipped(INSTALL_HINT) from exc
    model = Model(ICASSP_2022_MODEL_PATH)

    def transcribe(path: Path) -> list[RawNote]:
        _, _, events = predict(str(path), model)
        # Each event is (start, end, pitch, amplitude, pitch bends).
        return [
            RawNote(float(e[0]), float(e[1]), int(e[2]), float(e[3])) for e in events
        ]

    return transcribe


def transcribe_backing(
    store: SongStore,
    song_id: str,
    report: Report,
    *,
    loader: Callable[[], Transcriber] | None = None,
) -> None:
    """Make `backing.json` for a song from its instrumental stem.

    Raises StepSkipped when the extra is missing and BackingError, reading
    "<what failed>: <why>", on any other failure.
    """
    path = store.stem_path(song_id, "no_vocals")
    if path is None:
        raise BackingError(
            "Reading the instrumental failed: the song has no instrumental stem"
        )
    transcriber = (loader or load_transcriber)()
    started = time.monotonic()
    report(READ_PROGRESS)
    try:
        raw = transcriber(path)
    except StepSkipped:
        raise
    except Exception as exc:
        raise BackingError(
            f"Transcribing the instrumental failed: {str(exc) or type(exc).__name__}"
        ) from exc
    backing = filter_notes(raw)
    store.write_backing(song_id, backing)
    report(1.0)
    logger.info(
        "Transcribed song %s: %d of %d notes kept, in %.1f s",
        song_id,
        len(backing.notes),
        len(raw),
        time.monotonic() - started,
    )
