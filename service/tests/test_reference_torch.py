"""Tests of the reference step's pitch model: real torchcrepe, real weights.

The weights ship inside the torchcrepe package, so nothing is downloaded. The
audio is a synthetic voice (a sine with its overtones, faded in and out) at
known pitches, so what the model should find is known: that it follows the
notes at the right pitch and time, and that tracking in chunks gives what
tracking in one piece does. The file is skipped where torch or torchcrepe is
not installed, as in CI. The rest of the step is in `test_reference.py`.
"""

import numpy as np
import pytest

from encore_service import reference
from encore_service.melody import build_reference
from encore_service.reference import frame_levels_db
from tests.fakes import REAL_LOAD_CREPE

torch = pytest.importorskip("torch")
pytest.importorskip("torchcrepe")

RATE = 44_100
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# (midi or None for a rest, seconds)
MELODY = [(None, 0.3), (57, 0.6), (None, 0.2), (60, 0.6), (64, 0.6), (None, 0.3)]


def voice(notes: list[tuple[int | None, float]]) -> np.ndarray:
    """Mono audio: each note a sine with overtones of falling strength."""
    parts = []
    for midi, seconds in notes:
        t = np.arange(round(seconds * RATE)) / RATE
        if midi is None:
            parts.append(np.zeros_like(t))
            continue
        hz = 440 * 2 ** ((midi - 69) / 12)
        wave = sum(np.sin(2 * np.pi * h * hz * t) / h for h in range(1, 8))
        fade = np.minimum(1, np.minimum(t / 0.03, (seconds - t) / 0.03))
        parts.append(0.2 * wave * fade)
    return np.concatenate(parts).astype(np.float32)


def track(wav: np.ndarray):
    tracker = REAL_LOAD_CREPE("full", DEVICE)
    progress: list[float] = []
    f0, confidence = tracker.track(wav, RATE, progress.append)
    return f0, confidence, progress


def test_the_model_follows_known_notes_at_their_pitch_and_time() -> None:
    wav = voice(MELODY)
    f0, confidence, progress = track(wav)
    loud = frame_levels_db(wav, RATE, len(f0), 1.0) >= -50

    result = build_reference(f0.astype(float), confidence.astype(float), loud)

    assert len(f0) == 1 + len(wav) * 100 // RATE
    assert progress[-1] == 1.0
    assert len(result.notes) == 3
    starts = [0.3, 1.1, 1.7]
    for note, midi, start in zip(result.notes, (57, 60, 64), starts, strict=True):
        assert note.midi == pytest.approx(midi, abs=0.25)
        assert note.onset_s == pytest.approx(start, abs=0.05)
    assert result.range.low_midi == pytest.approx(57, abs=0.25)
    assert result.range.high_midi == pytest.approx(64, abs=0.25)


def test_tracking_in_chunks_gives_what_tracking_in_one_piece_does(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wav = voice(MELODY + MELODY)
    whole_f0, whole_confidence, _ = track(wav)

    monkeypatch.setattr(reference, "CHUNK_FRAMES", 150)
    monkeypatch.setattr(reference, "CONTEXT_FRAMES", 30)
    chunked_f0, chunked_confidence, progress = track(wav)

    assert len(chunked_f0) == len(whole_f0)
    assert len(progress) > 1 and progress == sorted(progress)
    # Frame by frame the model's answer flickers by a step of 20 cents or so,
    # whichever way it is cut; what must not happen is a wrong note at a seam.
    both = (whole_confidence > 0.5) & (chunked_confidence > 0.5)
    assert both.sum() > 250
    cents = 1200 * np.abs(np.log2(chunked_f0[both] / whole_f0[both]))
    assert np.percentile(cents, 99) < 50
    seams = np.zeros(len(whole_f0), dtype=bool)
    for seam in (150, 300, 450):
        seams[seam - 3 : seam + 3] = True
    assert np.max(cents[seams[both]]) < 50

    def notes_of(f0, confidence):
        loud = frame_levels_db(wav, RATE, len(f0), 1.0) >= -50
        return build_reference(f0.astype(float), confidence.astype(float), loud).notes

    whole, chunked = (
        notes_of(whole_f0, whole_confidence),
        notes_of(chunked_f0, chunked_confidence),
    )
    assert len(whole) == len(chunked) == 6
    for a, b in zip(whole, chunked, strict=True):
        assert b.midi == pytest.approx(a.midi, abs=0.1)
        assert b.onset_s == pytest.approx(a.onset_s, abs=0.03)
