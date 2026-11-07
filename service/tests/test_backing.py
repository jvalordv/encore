"""Tests for the backing step: the gates, the step, the skip and the route.

The step runs with an injected fake transcriber, so no model is needed. One
test runs the real model on a synthetic two-chord WAV with known notes; it is
skipped when the `transcribe` extra is not installed.
"""

import importlib.util
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from encore_service import backing as backing_module
from encore_service.app import create_app
from encore_service.backing import (
    INSTALL_HINT,
    MIN_AMPLITUDE,
    MIN_NOTE_S,
    BackingError,
    RawNote,
    filter_notes,
    load_transcriber,
    transcribe_backing,
)
from encore_service.config import Settings
from encore_service.errors import StepSkipped
from encore_service.pipeline import RUNNERS, STEP_ORDER, _is_done, prepare
from encore_service.schemas import BackingNotes
from encore_service.separation import write_flac
from encore_service.store import SongStore
from tests.fakes import add_song, stereo_tone, wav_bytes

RATE = 22_050


def put_instrumental(store: SongStore, audio: np.ndarray) -> str:
    song_id = add_song(store, audio[None, :], RATE)
    write_flac(store.song_dir(song_id) / "no_vocals.flac", audio[None, :], RATE)
    return song_id


def fake_loader(raw: list[RawNote]):
    seen: list[Path] = []

    def load():
        def transcribe(path: Path) -> list[RawNote]:
            seen.append(path)
            return raw

        return transcribe

    return load, seen


def test_gates_drop_short_and_weak_notes_and_sort_by_onset() -> None:
    notes = filter_notes(
        [
            RawNote(2.0, 3.0, 64, 0.8),
            RawNote(0.0, 1.0, 60, 1.0),
            RawNote(0.0, 1.0, 67, 0.5),
            RawNote(1.0, 1.0 + MIN_NOTE_S - 0.005, 62, 0.9),  # too short
            RawNote(1.0, 2.0, 62, MIN_AMPLITUDE - 0.01),  # too weak
            RawNote(1.0, 2.0, 130, 0.9),  # not a MIDI note
        ]
    )
    assert [(n.onset_s, n.midi) for n in notes.notes] == [
        (0.0, 60),
        (0.0, 67),
        (2.0, 64),
    ]
    assert [n.velocity for n in notes.notes] == [127, 64, 102]


def test_a_note_exactly_at_the_gates_is_kept() -> None:
    notes = filter_notes([RawNote(1.0, 1.0 + MIN_NOTE_S, 60, MIN_AMPLITUDE)])
    assert len(notes.notes) == 1


def test_the_step_writes_backing_json_from_the_instrumental(store: SongStore) -> None:
    song_id = put_instrumental(store, np.zeros(RATE, dtype=np.float32))
    load, seen = fake_loader([RawNote(0.0, 0.5, 60, 0.9), RawNote(0.0, 0.5, 64, 0.9)])
    reported: list[float] = []

    transcribe_backing(store, song_id, reported.append, loader=load)

    assert seen == [store.stem_path(song_id, "no_vocals")]
    path = store.backing_path(song_id)
    assert path is not None
    saved = BackingNotes.model_validate_json(path.read_text(encoding="utf-8"))
    assert [n.midi for n in saved.notes] == [60, 64]
    assert reported[-1] == 1.0


def test_a_model_failure_names_what_failed(store: SongStore) -> None:
    song_id = put_instrumental(store, np.zeros(RATE, dtype=np.float32))

    def load():
        def boom(path: Path) -> list[RawNote]:
            raise ValueError("bad audio")

        return boom

    with pytest.raises(BackingError, match="Transcribing the instrumental failed"):
        transcribe_backing(store, song_id, lambda _: None, loader=load)
    assert store.backing_path(song_id) is None


def test_without_the_extra_the_step_is_skipped_with_the_install_command(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(__import__("sys").modules, "basic_pitch", None)
    song_id = put_instrumental(store, np.zeros(RATE, dtype=np.float32))
    with pytest.raises(StepSkipped) as skipped:
        load_transcriber()
    assert skipped.value.reason == INSTALL_HINT

    monkeypatch.setitem(RUNNERS, "separation", lambda s, i, r: None)
    monkeypatch.setitem(RUNNERS, "backing", transcribe_backing)
    prepare(store, song_id)
    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.backing.state == "skipped"
    assert status.steps.backing.detail == INSTALL_HINT


def test_backing_runs_after_the_reference_and_waits_for_separation() -> None:
    assert STEP_ORDER.index("backing") == STEP_ORDER.index("reference") + 1


def test_a_backing_step_is_done_only_while_its_file_is_there(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = put_instrumental(store, np.zeros(RATE, dtype=np.float32))
    load, _ = fake_loader([RawNote(0.0, 0.5, 60, 0.9)])
    monkeypatch.setattr(backing_module, "load_transcriber", load)
    monkeypatch.setitem(RUNNERS, "separation", lambda s, i, r: None)
    monkeypatch.setitem(RUNNERS, "backing", transcribe_backing)
    prepare(store, song_id)
    status = store.read_status(song_id)
    assert status is not None and status.steps.backing.state == "done"
    assert _is_done(store, song_id, "backing", status)

    path = store.backing_path(song_id)
    assert path is not None
    path.unlink()
    assert not _is_done(store, song_id, "backing", status)


def test_the_backing_route_serves_notes_and_says_why_when_there_are_none(
    tmp_path: Path,
) -> None:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        files = {"file": ("tone.wav", wav_bytes(stereo_tone()), "audio/wav")}
        song_id = client.post("/songs", files=files).json()["song_id"]
        assert client.app.state.jobs.wait_idle(timeout=10.0)
        store: SongStore = client.app.state.store

        missing = client.get(f"/songs/{song_id}/backing")
        assert missing.status_code == 409
        assert missing.json()["detail"] == "Song has no backing notes."
        assert client.get(f"/songs/{'0' * 64}/backing").status_code == 404
        assert client.get("/songs/not-an-id/backing").status_code == 404

        store.write_backing(
            song_id,
            filter_notes([RawNote(0.5, 1.5, 60, 0.8), RawNote(0.5, 1.5, 64, 0.8)]),
        )
        response = client.get(f"/songs/{song_id}/backing")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    body = response.json()
    assert set(body) == {"notes"}
    assert set(body["notes"][0]) == {"onset_s", "offset_s", "midi", "velocity"}
    assert [n["midi"] for n in body["notes"]] == [60, 64]


@pytest.mark.skipif(
    importlib.util.find_spec("basic_pitch") is None,
    reason="the transcribe extra is not installed",
)
def test_the_real_model_hears_a_two_chord_wav(tmp_path: Path) -> None:
    chords = ((48, 52, 55), (53, 57, 60))  # C major, then F major
    seconds = 2.0
    t = np.arange(round(seconds * RATE)) / RATE
    parts = []
    for chord in chords:
        wave = sum(
            sum(
                a * np.sin(2 * np.pi * 440 * 2 ** ((m - 69) / 12) * (k + 1) * t)
                for k, a in enumerate((1.0, 0.5, 0.25))
            )
            for m in chord
        )
        parts.append(wave / 6)
    audio = np.concatenate(parts).astype(np.float32)
    path = tmp_path / "chords.wav"
    path.write_bytes(wav_bytes(audio[None, :], RATE))

    notes = filter_notes(load_transcriber()(path)).notes

    first = {n.midi for n in notes if n.onset_s < 1.0}
    second = {n.midi for n in notes if 1.8 <= n.onset_s < 3.0}
    assert set(chords[0]) <= first
    assert set(chords[1]) <= second
