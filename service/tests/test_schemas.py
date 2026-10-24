"""Round-trip and validation tests for the shared pydantic schemas."""

import pytest
from pydantic import ValidationError

from encore_service.schemas import (
    Contour,
    Features,
    Note,
    Recommendation,
    SongStatus,
    SongSteps,
    TakeAnalysis,
)


def test_contour_round_trips() -> None:
    raw = {
        "hop_s": 0.01,
        "t0_s": 1.5,
        "f0_hz": [0.0, 220.0, 221.5, 0.0],
        "confidence": [0.1, 0.95, 0.97, 0.2],
    }
    contour = Contour.model_validate(raw)
    assert contour.model_dump() == raw


def test_contour_hop_defaults_to_ten_ms() -> None:
    contour = Contour.model_validate({"f0_hz": [440.0], "confidence": [1.0]})
    assert contour.hop_s == 0.01
    assert contour.t0_s == 0.0


def test_contour_rejects_mismatched_lengths() -> None:
    with pytest.raises(ValidationError):
        Contour.model_validate({"f0_hz": [440.0, 441.0], "confidence": [1.0]})


def test_song_status_round_trips() -> None:
    raw = {
        "song_id": "yt-dQw4w9WgXcQ",
        "title": "Tone",
        "duration_s": 212.5,
        "source": "youtube",
        "steps": {
            "fetch": {"state": "done", "progress": 1.0, "error": None, "detail": None},
            "separation": {
                "state": "done",
                "progress": 1.0,
                "error": None,
                "detail": None,
            },
            "reference": {
                "state": "running",
                "progress": 0.4,
                "error": None,
                "detail": None,
            },
            "lyrics": {
                "state": "skipped",
                "progress": 0.0,
                "error": None,
                "detail": "Not built yet (ROADMAP P2-T4)",
            },
        },
    }
    status = SongStatus.model_validate(raw)
    assert status.steps.reference.progress == 0.4
    assert status.steps.lyrics.detail == "Not built yet (ROADMAP P2-T4)"
    assert status.model_dump() == raw


def test_song_status_keeps_a_failure_message_in_error() -> None:
    status = SongStatus.model_validate(
        {"song_id": "ab12", "steps": {"lyrics": {"state": "failed", "error": "no"}}}
    )
    assert status.steps.lyrics.error == "no"
    assert status.steps.lyrics.detail is None


def test_song_status_defaults_to_queued() -> None:
    status = SongStatus(song_id="ab12")
    assert status.steps.fetch.state == "queued"
    assert status.steps.separation.state == "queued"
    assert status.steps.lyrics.progress == 0.0
    assert status.steps.separation.detail is None
    # A bare status is an upload with nothing known about it yet.
    assert status.source == "file"
    assert status.title is None
    assert status.duration_s is None


def test_song_steps_run_in_order_with_fetch_first() -> None:
    assert list(SongSteps.model_fields) == [
        "fetch",
        "separation",
        "reference",
        "lyrics",
    ]


def test_step_state_is_restricted() -> None:
    raw = {"song_id": "x", "steps": {"lyrics": {"state": "paused"}}}
    with pytest.raises(ValidationError):
        SongStatus.model_validate(raw)


def test_song_source_is_restricted() -> None:
    with pytest.raises(ValidationError):
        SongStatus.model_validate({"song_id": "x", "source": "vimeo"})


def test_take_analysis_accepts_empty_features() -> None:
    analysis = TakeAnalysis.model_validate(
        {
            "contour": {"f0_hz": [], "confidence": []},
            "notes": [
                {
                    "onset_s": 0.0,
                    "offset_s": 0.5,
                    "midi": 60.2,
                    "cents_mean": 20.0,
                    "cents_std": 5.0,
                    "scoop_cents": 0.0,
                }
            ],
            "alignment": {"offset_s": 0.04},
            "features": {},
        }
    )
    assert analysis.features == Features()
    assert analysis.notes[0].vibrato is None
    assert analysis.recommendations == []


def test_note_and_recommendation_round_trip() -> None:
    note = {
        "onset_s": 1.0,
        "offset_s": 2.2,
        "midi": 64.0,
        "cents_mean": -12.0,
        "cents_std": 18.0,
        "scoop_cents": 40.0,
        "vibrato": {"rate_hz": 5.5, "extent_cents": 60.0, "regularity": 0.02},
    }
    assert Note.model_validate(note).model_dump() == note

    rec = {
        "rule_id": "flat_bias",
        "mode": "general",
        "severity": "priority",
        "message_key": "flat_bias",
        "evidence": {"note_indices": [2, 5], "value": -24.0, "reference_value": None},
    }
    assert Recommendation.model_validate(rec).model_dump() == rec
