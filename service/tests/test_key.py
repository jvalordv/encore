"""Tests for the key step: the estimator on synthetic music, then the step.

The estimator is checked on synthesized chord loops whose key, tuning and key
changes are known: harmonic tones over a bass line, at 22.05 kHz so they are
fast. The step and its route are checked with the stems written by hand, as
the other step tests do, so no separation model is involved.
"""

import json
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from encore_service import key as key_module
from encore_service.app import create_app
from encore_service.config import Settings
from encore_service.errors import StepSkipped
from encore_service.key import (
    CONFIDENCE_GATE,
    HOP_S,
    MARGIN_FULL,
    WINDOW_S,
    KeyEstimationError,
    estimate_key,
    extract_key,
    frame_size,
)
from encore_service.pipeline import RUNNERS, STEP_ORDER, _is_done, prepare
from encore_service.schemas import KeyMap, KeySegment
from encore_service.separation import write_flac
from encore_service.store import SongStore
from tests.fakes import add_song, stereo_tone, wav_bytes

RATE = 22_050
PARTIALS = (1.0, 0.5, 0.33, 0.25)
# The chords of the loop as (semitones above the tonic, third of the triad).
I_IV_V_I = ((0, 4), (5, 4), (7, 4), (0, 4))
BAR_S = 2.0

Runner = Callable[[SongStore, str, Callable[[float], None]], None]


def note(midi: float, seconds: float, cents: float = 0.0) -> np.ndarray:
    """A harmonic tone at `midi` (+ `cents`) with short fades."""
    hz = 440 * 2 ** ((midi - 69 + cents / 100) / 12)
    t = np.arange(round(seconds * RATE)) / RATE
    wave = sum(a * np.sin(2 * np.pi * hz * (k + 1) * t) for k, a in enumerate(PARTIALS))
    fade = np.minimum(1, np.minimum(t / 0.02, (seconds - t) / 0.05))
    return wave * fade


def loop(tonic: int, seconds: float, cents: float = 0.0) -> np.ndarray:
    """I-IV-V-I in the major key on `tonic` (C = 0), a bar of two seconds each."""
    bars = []
    for bar in range(round(seconds / BAR_S)):
        offset, third = I_IV_V_I[bar % 4]
        root = 60 + tonic + offset
        triad = sum(note(m, BAR_S, cents) for m in (root, root + third, root + 7))
        bars.append(triad / 3 + 0.5 * note(root - 24, BAR_S, cents))
    return np.concatenate(bars).astype(np.float32)


def assert_well_formed(key: KeyMap, seconds: float) -> None:
    segments = key.segments
    assert segments[0].start_s == 0.0
    assert segments[-1].end_s == pytest.approx(seconds, abs=1e-3)
    for before, after in zip(segments, segments[1:], strict=False):
        assert before.end_s == after.start_s
        assert (before.tonic, before.mode) != (after.tonic, after.mode)
    for segment in segments:
        assert segment.end_s > segment.start_s
        assert 0.0 <= segment.confidence <= 1.0
        assert (segment.tonic is None) == (segment.mode is None)
        if segment.tonic is None:
            assert segment.confidence < CONFIDENCE_GATE
        else:
            assert segment.confidence >= CONFIDENCE_GATE
    assert -50.0 <= key.tuning_cents < 50.0


def as_major(segment: KeySegment) -> tuple[int | None, str | None]:
    """The key with a minor named by its relative major, so either passes."""
    if segment.tonic is None:
        return None, None
    if segment.mode == "minor":
        return (segment.tonic + 3) % 12, "major"
    return segment.tonic, "major"


# --- the estimator -----------------------------------------------------------


def test_a_progression_in_d_major_is_found_and_clear() -> None:
    key = estimate_key(loop(2, 32.0), RATE)

    assert_well_formed(key, 32.0)
    assert len(key.segments) == 1
    segment = key.segments[0]
    assert (segment.tonic, segment.mode) in {(2, "major"), (11, "minor")}
    assert segment.confidence >= CONFIDENCE_GATE
    assert abs(key.tuning_cents) < 3.0


@pytest.mark.parametrize("tonic", [0, 5, 7, 9, 10])
def test_other_major_keys_are_found_too(tonic: int) -> None:
    key = estimate_key(loop(tonic, 32.0), RATE)
    assert [as_major(s) for s in key.segments] == [(tonic, "major")]


def test_a_change_of_key_is_found_within_one_window_of_the_boundary() -> None:
    audio = np.concatenate([loop(0, 16.0), loop(2, 16.0)])
    key = estimate_key(audio, RATE)

    assert_well_formed(key, 32.0)
    assert [as_major(s) for s in key.segments] == [(0, "major"), (2, "major")]
    assert abs(key.segments[0].end_s - 16.0) <= WINDOW_S


def test_one_odd_stretch_does_not_flip_the_key() -> None:
    # Six seconds of another key inside a minute of D major.
    audio = np.concatenate([loop(2, 28.0), loop(7, 6.0), loop(2, 28.0)])
    key = estimate_key(audio, RATE)

    assert_well_formed(key, 62.0)
    assert [as_major(s) for s in key.segments] == [(2, "major")]


@pytest.mark.parametrize("cents", [30.0, -30.0, 45.0])
def test_the_tuning_offset_is_measured_and_the_key_still_found(cents: float) -> None:
    key = estimate_key(loop(2, 32.0, cents=cents), RATE)

    assert key.tuning_cents == pytest.approx(cents, abs=4.0)
    assert [as_major(s) for s in key.segments] == [(2, "major")]


def test_a_tuning_that_rounds_up_to_fifty_is_wrapped_into_range(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(key_module, "estimate_tuning", lambda *args: 49.996)

    key = estimate_key(loop(2, 12.0), RATE)

    assert key.tuning_cents == -50.0
    assert key_module._report_cents(49.994) == 49.99
    assert key_module._report_cents(-49.996) == -50.0


def test_white_noise_has_no_clear_key() -> None:
    noise = np.random.default_rng(1).normal(0, 0.1, 30 * RATE).astype(np.float32)
    key = estimate_key(noise, RATE)

    assert_well_formed(key, 30.0)
    assert [s.tonic for s in key.segments] == [None]
    assert key.tuning_cents == 0.0


def test_silence_and_a_signal_under_the_floor_have_no_clear_key() -> None:
    for audio in (np.zeros(20 * RATE, dtype=np.float32), 1e-5 * loop(2, 20.0)):
        key = estimate_key(audio, RATE)
        assert_well_formed(key, 20.0)
        assert [s.tonic for s in key.segments] == [None]


def test_a_gap_of_silence_inside_one_key_does_not_break_the_key() -> None:
    gap = np.zeros(4 * RATE, np.float32)
    key = estimate_key(np.concatenate([loop(2, 24.0), gap, loop(2, 24.0)]), RATE)

    assert_well_formed(key, 52.0)
    assert {as_major(s) for s in key.segments} <= {(2, "major"), (None, None)}
    assert key.segments[0].tonic is not None


def test_a_track_shorter_than_one_window_gets_one_segment() -> None:
    key = estimate_key(loop(2, 6.0), RATE)
    assert_well_formed(key, 6.0)
    assert len(key.segments) == 1

    tiny = estimate_key(np.zeros(100, dtype=np.float32), RATE)
    assert_well_formed(tiny, 100 / RATE)
    assert tiny.segments[0].tonic is None


def test_an_empty_signal_is_refused() -> None:
    with pytest.raises(ValueError, match="no audio"):
        estimate_key(np.zeros(0, dtype=np.float32), RATE)


def test_the_segments_cover_a_length_that_is_not_a_whole_hop() -> None:
    audio = loop(2, 34.0)[: round(31.3 * RATE)]
    key = estimate_key(audio, RATE)
    assert_well_formed(key, len(audio) / RATE)


def test_progress_runs_up_to_one_in_order() -> None:
    seen: list[float] = []
    estimate_key(loop(2, 16.0), RATE, seen.append)
    assert seen == sorted(seen)
    assert seen[-1] == 1.0
    assert all(0.0 <= value <= 1.0 for value in seen)


def test_a_five_minute_track_is_one_clear_key_and_fast_enough() -> None:
    audio = np.tile(loop(2, 32.0), 10)[: 300 * RATE]
    key = estimate_key(audio, RATE)
    assert_well_formed(key, 300.0)
    assert [as_major(s) for s in key.segments] == [(2, "major")]


def test_the_frame_scales_with_the_rate_to_a_power_of_two() -> None:
    assert frame_size(44_100) == 8192
    assert frame_size(22_050) == 4096
    assert frame_size(48_000) == 8192
    assert frame_size(8_000) == 2048


def test_each_key_knows_its_relative() -> None:
    relatives = key_module._relatives()
    for tonic in range(12):
        minor = relatives[tonic]
        assert minor >= 12
        assert (minor - 12 + 3) % 12 == tonic
        assert relatives[minor] == tonic


def test_the_confidence_leaves_out_the_relative_and_tracks_the_margin() -> None:
    scores = np.zeros((1, 24))
    scores[0, 2] = 0.8  # D major
    scores[0, 12 + 11] = 0.78  # B minor, its relative
    scores[0, 7] = 0.5  # G major
    path = np.array([2])
    assert key_module._confidences(scores, path)[0] == 1.0

    scores[0, 7] = 0.75
    expected = (0.8 - 0.75) / MARGIN_FULL
    assert key_module._confidences(scores, path)[0] == pytest.approx(expected)

    # A path key that the scores do not support has no confidence at all.
    assert key_module._confidences(scores, np.array([5]))[0] == 0.0


def test_a_window_is_longer_than_the_hop_between_windows() -> None:
    assert 0 < HOP_S < WINDOW_S


# --- the models --------------------------------------------------------------


def test_a_segment_has_tonic_and_mode_together_or_neither() -> None:
    KeySegment(start_s=0, end_s=1, tonic=None, mode=None, confidence=0.1)
    KeySegment(start_s=0, end_s=1, tonic=11, mode="minor", confidence=0.9)
    for bad in (
        {"tonic": 3, "mode": None},
        {"tonic": None, "mode": "major"},
        {"tonic": 12, "mode": "major"},
        {"tonic": 1, "mode": "dorian"},
    ):
        with pytest.raises(ValidationError):
            KeySegment(start_s=0, end_s=1, confidence=0.5, **bad)


def test_the_tuning_is_held_to_minus_fifty_up_to_fifty() -> None:
    KeyMap(tuning_cents=-50, segments=[])
    KeyMap(tuning_cents=49.99, segments=[])
    for bad in (50, -50.01):
        with pytest.raises(ValidationError):
            KeyMap(tuning_cents=bad, segments=[])


# --- the step ----------------------------------------------------------------


def put_instrumental(
    store: SongStore, audio: np.ndarray, gain: float = 1.0, rate: int = RATE
) -> str:
    """A song whose `no_vocals` stem is `audio` (mono or channels x samples)."""
    stem = audio[None, :] if audio.ndim == 1 else audio
    song_id = add_song(store, stem, rate)
    write_flac(store.song_dir(song_id) / "no_vocals.flac", stem, rate)
    store.set_stem_gain(song_id, gain)
    return song_id


def run(store: SongStore, song_id: str) -> list[float]:
    reported: list[float] = []
    extract_key(store, song_id, reported.append)
    return reported


def test_the_step_reads_the_instrumental_and_writes_key_json(store: SongStore) -> None:
    song_id = put_instrumental(store, loop(2, 24.0))

    reported = run(store, song_id)

    path = store.key_path(song_id)
    assert path is not None and path.name == "key.json"
    key = KeyMap.model_validate_json(path.read_bytes())
    assert_well_formed(key, 24.0)
    assert [as_major(s) for s in key.segments] == [(2, "major")]
    assert reported[-1] == 1.0
    assert reported == sorted(reported)


def test_a_stereo_stem_is_one_channel_and_a_quiet_one_is_read_at_the_songs_level(
    store: SongStore,
) -> None:
    # The stem is 60 dB under the song's own level, as a scaled stem can be;
    # the gain brings it back above the silence floor.
    audio = loop(2, 24.0)
    quiet = np.stack([0.0004 * audio, 0.0004 * audio])
    song_id = put_instrumental(store, quiet, gain=0.001)

    run(store, song_id)

    path = store.key_path(song_id)
    assert path is not None
    key = KeyMap.model_validate_json(path.read_bytes())
    assert [as_major(s) for s in key.segments] == [(2, "major")]


def test_a_song_with_no_instrumental_stem_fails_the_step(store: SongStore) -> None:
    song_id = add_song(store)
    with pytest.raises(KeyEstimationError, match="no instrumental stem"):
        run(store, song_id)


def test_an_unreadable_stem_fails_the_step_saying_what_failed(
    store: SongStore,
) -> None:
    song_id = add_song(store)
    (store.song_dir(song_id) / "no_vocals.flac").write_bytes(b"not flac")
    with pytest.raises(KeyEstimationError, match="Reading the instrumental failed"):
        run(store, song_id)


def separates_to(audio: np.ndarray, rate: int = RATE) -> Runner:
    """A separation runner that leaves both stems as `audio`."""

    def separate(store: SongStore, song_id: str, report: Callable[[float], None]):
        for name in ("vocals.flac", "no_vocals.flac"):
            write_flac(store.song_dir(song_id) / name, audio[None, :], rate)
        report(1.0)

    return separate


def noting(order: list[str], name: str, inner: Runner | None = None) -> Runner:
    """A runner that records its name, then does `inner` if it has one."""

    def runner(store: SongStore, song_id: str, report: Callable[[float], None]):
        order.append(name)
        if inner is not None:
            inner(store, song_id, report)

    return runner


def raising(error: Exception) -> Runner:
    def runner(store: SongStore, song_id: str, report: Callable[[float], None]):
        raise error

    return runner


def test_the_key_step_sits_between_separation_and_the_reference() -> None:
    assert STEP_ORDER.index("separation") < STEP_ORDER.index("key")
    assert STEP_ORDER.index("key") < STEP_ORDER.index("reference")


def test_the_key_runs_after_separation_and_before_the_reference(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    order: list[str] = []
    audio = loop(2, 12.0)
    monkeypatch.setitem(
        RUNNERS, "separation", noting(order, "separation", separates_to(audio))
    )
    monkeypatch.setitem(RUNNERS, "key", noting(order, "key", extract_key))
    monkeypatch.setitem(RUNNERS, "reference", noting(order, "reference"))
    song_id = add_song(store, audio[None, :], RATE)

    prepare(store, song_id)

    assert order == ["separation", "key", "reference"]
    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.key.state, status.steps.key.progress) == ("done", 1.0)
    assert store.key_path(song_id) is not None


def test_the_key_runs_for_a_song_whose_reference_is_skipped(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = loop(2, 12.0)
    monkeypatch.setitem(RUNNERS, "separation", separates_to(audio))
    monkeypatch.setitem(RUNNERS, "key", extract_key)
    monkeypatch.setitem(
        RUNNERS, "reference", raising(StepSkipped("No singing found: karaoke"))
    )
    song_id = add_song(store, audio[None, :], RATE)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.reference.state == "skipped"
    assert status.steps.key.state == "done"
    assert store.key_path(song_id) is not None


def test_a_failed_reference_does_not_stop_the_key(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = loop(2, 12.0)
    monkeypatch.setitem(RUNNERS, "separation", separates_to(audio))
    monkeypatch.setitem(RUNNERS, "key", extract_key)
    monkeypatch.setitem(RUNNERS, "reference", raising(RuntimeError("exploded")))
    song_id = add_song(store, audio[None, :], RATE)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.reference.state, status.steps.key.state) == ("failed", "done")


def test_the_key_is_skipped_as_needing_separation_when_it_did_not_finish(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[str] = []
    monkeypatch.setitem(
        RUNNERS, "separation", raising(StepSkipped("Install the extra"))
    )
    monkeypatch.setitem(RUNNERS, "key", noting(ran, "key"))
    song_id = add_song(store)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.key.state, status.steps.key.detail) == (
        "skipped",
        "Needs separation",
    )
    assert ran == []


def test_a_done_key_step_whose_file_has_gone_runs_again(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = loop(2, 12.0)
    monkeypatch.setitem(RUNNERS, "separation", separates_to(audio))
    monkeypatch.setitem(RUNNERS, "key", extract_key)
    song_id = add_song(store, audio[None, :], RATE)
    prepare(store, song_id)
    status = store.read_status(song_id)
    assert status is not None
    assert _is_done(store, song_id, "key", status)

    path = store.key_path(song_id)
    assert path is not None
    path.unlink()
    assert not _is_done(store, song_id, "key", status)

    prepare(store, song_id)
    assert store.key_path(song_id) is not None


def test_a_status_file_written_before_the_key_step_loads_it_as_queued(
    store: SongStore,
) -> None:
    song_id = add_song(store)
    status_path = store.song_dir(song_id) / "status.json"
    raw = json.loads(status_path.read_text(encoding="utf-8"))
    del raw["steps"]["key"]
    status_path.write_text(json.dumps(raw), encoding="utf-8")

    status = store.read_status(song_id)

    assert status is not None
    assert status.steps.key.state == "queued"
    assert status.steps.key.progress == 0.0


def test_the_key_route_serves_the_key_and_says_why_when_there_is_none(
    tmp_path: Path,
) -> None:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        files = {"file": ("tone.wav", wav_bytes(stereo_tone()), "audio/wav")}
        song_id = client.post("/songs", files=files).json()["song_id"]
        assert client.app.state.jobs.wait_idle(timeout=10.0)
        store: SongStore = client.app.state.store
        stem = loop(2, 16.0)[None, :]
        write_flac(store.song_dir(song_id) / "no_vocals.flac", stem, RATE)

        missing = client.get(f"/songs/{song_id}/key")
        assert missing.status_code == 409
        assert missing.json()["detail"] == "Song has no key yet."
        assert client.get(f"/songs/{'0' * 64}/key").status_code == 404
        assert client.get("/songs/not-an-id/key").status_code == 404

        run(store, song_id)
        response = client.get(f"/songs/{song_id}/key")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    body = response.json()
    key = KeyMap.model_validate(body)
    assert_well_formed(key, 16.0)
    assert [as_major(s) for s in key.segments] == [(2, "major")]
    assert set(body) == {"tuning_cents", "segments"}
    assert set(body["segments"][0]) == {
        "start_s",
        "end_s",
        "tonic",
        "mode",
        "confidence",
    }
