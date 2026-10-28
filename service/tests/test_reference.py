"""Tests for the reference step, with a fake pitch model.

The singing test and the level arithmetic are checked on synthetic audio whose
levels are known. The step itself runs against `FakePitchTracker`, which
follows a known melody, so what is checked is the plumbing: that a sung vocal
becomes `reference.json`, that a vocal with no singing is skipped before any
model is loaded, that the stem gain is undone, and how each way of failing is
worded. The model's own output is in `test_reference_torch.py`.
"""

import math
import sys
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from encore_service import registry
from encore_service.app import create_app
from encore_service.config import Settings
from encore_service.errors import StepSkipped
from encore_service.pipeline import LYRICS_SKIPPED, RUNNERS, prepare, skip_lyrics
from encore_service.reference import (
    CHUNK_FRAMES,
    INSTALL_HINT,
    MIN_PRESENCE_SHARE,
    PRESENCE_DBFS,
    SOUNDING_DBFS,
    Chunk,
    PitchError,
    extract_reference,
    frame_levels_db,
    plan_chunks,
    vocal_presence,
)
from encore_service.schemas import Reference
from encore_service.separation import write_flac
from encore_service.store import SongStore
from tests.fakes import (
    REAL_LOAD_CREPE,
    REAL_RUNNERS,
    FakePitchTracker,
    add_song,
    stereo_tone,
    wav_bytes,
)

RATE = 8_000


def tone(seconds: float, dbfs: float, rate: int = RATE) -> np.ndarray:
    """A 440 Hz sine whose RMS level is `dbfs`, as mono float32."""
    t = np.arange(round(seconds * rate)) / rate
    peak = 10 ** (dbfs / 20) * math.sqrt(2)
    return (peak * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def sung(seconds: float = 2.0, dbfs: float = -14.0) -> np.ndarray:
    return tone(seconds, dbfs)


def put_vocal(
    store: SongStore, wav: np.ndarray, gain: float = 1.0, rate: int = RATE
) -> str:
    """A song whose vocal stem is `wav` (mono or channels x samples)."""
    stem = wav[None, :] if wav.ndim == 1 else wav
    # The vocal is also the song's audio, so two vocals are two songs.
    song_id = add_song(store, stem, rate)
    write_flac(store.song_dir(song_id) / "vocals.flac", stem, rate)
    store.set_stem_gain(song_id, gain)
    return song_id


def run(store: SongStore, song_id: str) -> list[float]:
    reported: list[float] = []
    extract_reference(store, song_id, reported.append)
    return reported


@pytest.fixture(autouse=True)
def on_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENCORE_DEVICE", "cpu")


# --- is anyone singing -------------------------------------------------------


def test_a_second_is_a_window_and_the_share_counts_the_ones_above_the_level() -> None:
    wav = np.concatenate([tone(3, -20), tone(1, -60)])
    assert vocal_presence(wav, RATE) == pytest.approx(0.75)


def test_silence_and_a_noise_floor_have_no_presence() -> None:
    assert vocal_presence(np.zeros(5 * RATE, dtype=np.float32), RATE) == 0.0
    assert vocal_presence(tone(5, -70), RATE) == 0.0


def test_the_level_is_judged_at_the_songs_scale_not_the_stems() -> None:
    # A stem scaled down by 0.5 (-6 dB) so that it would not clip: it reads
    # -43 dBFS in the file and -37 dBFS in the song.
    wav = tone(4, PRESENCE_DBFS - 3)
    assert vocal_presence(wav, RATE, gain=1.0) == 0.0
    assert vocal_presence(wav, RATE, gain=0.5) == 1.0


def test_audio_shorter_than_a_window_is_one_window() -> None:
    assert vocal_presence(tone(0.4, -20), RATE) == 1.0
    assert vocal_presence(tone(0.4, -70), RATE) == 0.0


def test_a_sparse_burst_in_a_quiet_track_stays_under_the_share_asked_for() -> None:
    # Animal calls in a film with no singing: 1 s in 30 is loud.
    wav = np.concatenate([tone(10, -70), tone(1, -15), tone(19, -70)])
    share = vocal_presence(wav, RATE)
    assert share == pytest.approx(1 / 30)
    assert share < MIN_PRESENCE_SHARE


def test_frame_levels_follow_a_tone_that_starts_and_stops() -> None:
    gain = 0.5
    wav = np.concatenate([tone(1, -80), tone(1, -30), tone(1, -80)])
    frames = 1 + len(wav) // (RATE // 100)

    levels = frame_levels_db(wav, RATE, frames, gain)

    assert len(levels) == frames
    # In the file the middle second is -30 dBFS; at the song's scale, -24.
    assert levels[150] == pytest.approx(-30 - 20 * math.log10(gain), abs=0.1)
    assert levels[50] < -70
    assert levels[250] < -70
    # The window is 40 ms wide, centred: the frame at the tone's start has
    # half of it, which is 3 dB down.
    assert levels[100] == pytest.approx(levels[150] - 3.0, abs=0.7)


def test_frame_levels_read_past_the_end_of_the_audio_as_silence() -> None:
    levels = frame_levels_db(tone(1, -20), RATE, 150, 1.0)
    assert len(levels) == 150
    assert levels[50] > SOUNDING_DBFS
    assert levels[149] < -100


# --- chunks ------------------------------------------------------------------


def test_chunks_tile_the_frames_and_each_has_context_where_there_is_room() -> None:
    chunks = plan_chunks(total=250, size=100, context=20)
    assert chunks == [
        Chunk(0, 100, 0, 120),
        Chunk(100, 200, 80, 220),
        Chunk(200, 250, 180, 250),
    ]
    covered = [f for c in chunks for f in range(c.core_start, c.core_end)]
    assert covered == list(range(250))


def test_one_short_track_is_one_chunk() -> None:
    assert plan_chunks(total=40, size=CHUNK_FRAMES, context=10) == [Chunk(0, 40, 0, 40)]


# --- the step ----------------------------------------------------------------


def test_a_sung_vocal_becomes_a_reference_and_progress_reaches_one(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    song_id = put_vocal(store, sung(2.0))

    reported = run(store, song_id)

    path = store.reference_path(song_id)
    assert path is not None
    reference = Reference.model_validate_json(path.read_bytes())
    assert [round(n.midi) for n in reference.notes] == [57, 64]
    assert reference.contour.hop_s == 0.01
    assert reference.contour.t0_s == 0.0
    assert len(reference.contour.f0_hz) == 1 + 2 * 100
    assert reported[-1] == 1.0
    assert reported == sorted(reported)
    assert pitch_tracker.heard == [(2 * RATE, RATE)]
    assert pitch_tracker.loads == [("full", "cpu")]


def test_the_model_is_loaded_once_and_listed_for_gpu(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    first, second = put_vocal(store, sung(1.5)), put_vocal(store, sung(2.0))
    assert registry.loaded_models() == []

    run(store, first)
    run(store, second)

    assert pitch_tracker.loads == [("full", "cpu")]
    assert registry.loaded_models() == ["crepe:full@cpu"]


def test_a_vocal_with_no_singing_is_skipped_before_any_model_is_loaded(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    song_id = put_vocal(store, tone(20, -70))

    with pytest.raises(StepSkipped, match="No singing found"):
        run(store, song_id)

    assert pitch_tracker.loads == []
    assert registry.loaded_models() == []
    assert store.reference_path(song_id) is None


def test_the_skip_says_how_little_of_the_track_sounds_and_why_it_matters(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    wav = np.concatenate([tone(28, -70), tone(1, -15), tone(1, -70)])
    song_id = put_vocal(store, wav)

    with pytest.raises(StepSkipped) as skipped:
        run(store, song_id)

    assert "only 3% of this track" in skipped.value.reason
    assert "karaoke or instrumental" in skipped.value.reason


def test_the_stem_gain_is_undone_before_the_singing_is_judged(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    # Quiet in the file, loud enough in the song it was scaled down from.
    quiet = tone(3, PRESENCE_DBFS - 4)
    skipped = put_vocal(store, quiet, gain=1.0)
    kept = put_vocal(store, quiet * 1.01, gain=0.4)

    with pytest.raises(StepSkipped):
        run(store, skipped)
    run(store, kept)

    assert store.reference_path(kept) is not None


def test_a_stereo_vocal_is_tracked_as_one_channel(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    left = sung(2.0)
    song_id = put_vocal(store, np.stack([left, 0.5 * left]))

    run(store, song_id)

    assert pitch_tracker.heard == [(2 * RATE, RATE)]


def test_a_pitch_the_model_finds_in_the_traces_between_words_is_not_a_note(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    # The model reports both notes with full confidence, but the second sits
    # in a stretch where the stem is down at -62 dBFS, as separation leaves it.
    wav = np.concatenate([tone(1.0, -14), tone(1.0, -62)])
    song_id = put_vocal(store, wav)

    run(store, song_id)

    path = store.reference_path(song_id)
    assert path is not None
    notes = Reference.model_validate_json(path.read_bytes()).notes
    assert [round(n.midi) for n in notes] == [57]


def test_a_track_with_no_steady_pitch_is_skipped_not_failed(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    pitch_tracker.melody = ((None, 3.0),)
    song_id = put_vocal(store, sung(2.0))

    with pytest.raises(StepSkipped, match="No melody found"):
        run(store, song_id)

    assert store.reference_path(song_id) is None


def test_a_model_that_fails_fails_the_step_with_what_and_why(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    pitch_tracker.error = RuntimeError("CUDA error")
    song_id = put_vocal(store, sung(2.0))

    with pytest.raises(PitchError, match="Tracking the pitch failed: CUDA error"):
        run(store, song_id)

    assert store.reference_path(song_id) is None


def test_a_model_that_will_not_load_fails_the_step_and_is_not_kept(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    pitch_tracker.load_error = OSError("no weights")
    song_id = put_vocal(store, sung(2.0))

    with pytest.raises(PitchError, match="Loading the pitch model failed: no weights"):
        run(store, song_id)

    assert registry.loaded_models() == []


def test_a_song_with_no_vocal_stem_fails_the_step(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    song_id = add_song(store)
    with pytest.raises(PitchError, match="no vocal stem"):
        run(store, song_id)


def test_an_unreadable_vocal_stem_fails_the_step(
    store: SongStore, pitch_tracker: FakePitchTracker
) -> None:
    song_id = add_song(store)
    (store.song_dir(song_id) / "vocals.flac").write_bytes(b"not flac")
    with pytest.raises(PitchError, match="Reading the vocal failed"):
        run(store, song_id)


def test_without_the_pitch_extra_a_sung_song_is_skipped_with_the_command(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The real loader, with torchcrepe made unimportable.
    monkeypatch.setattr("encore_service.reference.load_crepe", REAL_LOAD_CREPE)
    monkeypatch.setitem(sys.modules, "torchcrepe", None)
    song_id = put_vocal(store, sung(2.0))

    with pytest.raises(StepSkipped) as skipped:
        run(store, song_id)

    assert skipped.value.reason == INSTALL_HINT
    assert "--extra pitch" in INSTALL_HINT


def test_a_karaoke_vocal_is_skipped_for_its_reason_even_without_the_extra(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("encore_service.reference.load_crepe", REAL_LOAD_CREPE)
    monkeypatch.setitem(sys.modules, "torchcrepe", None)
    song_id = put_vocal(store, tone(10, -75))

    with pytest.raises(StepSkipped, match="No singing found"):
        run(store, song_id)


# --- in the pipeline and over HTTP -------------------------------------------


def _separates_to(
    wav: np.ndarray,
) -> Callable[[SongStore, str, Callable[[float], None]], None]:
    def separate(store: SongStore, song_id: str, report: Callable[[float], None]):
        write_flac(store.song_dir(song_id) / "vocals.flac", wav[None, :], RATE)
        write_flac(store.song_dir(song_id) / "no_vocals.flac", wav[None, :], RATE)
        report(1.0)

    return separate


def test_every_step_has_a_runner_and_lyrics_skips_with_its_reason() -> None:
    assert all(runner is not None for runner in REAL_RUNNERS.values())
    assert REAL_RUNNERS["reference"] is extract_reference
    assert REAL_RUNNERS["lyrics"] is skip_lyrics
    with pytest.raises(StepSkipped) as skipped:
        skip_lyrics(None, "id", lambda progress: None)  # type: ignore[arg-type]
    assert skipped.value.reason == "Lyrics come from a lookup in the app"
    assert LYRICS_SKIPPED == skipped.value.reason


def test_prepare_marks_a_sung_song_done_and_a_karaoke_one_skipped_with_its_reason(
    store: SongStore, pitch_tracker: FakePitchTracker, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(RUNNERS, "reference", extract_reference)
    monkeypatch.setitem(RUNNERS, "lyrics", skip_lyrics)

    monkeypatch.setitem(RUNNERS, "separation", _separates_to(sung(2.0)))
    sung_id = add_song(store, sung(2.0)[None, :], RATE)
    prepare(store, sung_id)
    status = store.read_status(sung_id)
    assert status is not None
    assert (status.steps.reference.state, status.steps.reference.detail) == (
        "done",
        None,
    )
    assert status.steps.lyrics.state == "skipped"
    assert status.steps.lyrics.detail == "Lyrics come from a lookup in the app"

    monkeypatch.setitem(RUNNERS, "separation", _separates_to(tone(20, -75)))
    karaoke_id = add_song(store, tone(20, -75)[None, :], RATE)
    prepare(store, karaoke_id)
    status = store.read_status(karaoke_id)
    assert status is not None
    assert status.steps.separation.state == "done"
    assert status.steps.reference.state == "skipped"
    assert "No singing found" in (status.steps.reference.detail or "")
    assert status.steps.reference.error is None


def test_the_reference_route_serves_the_melody_and_says_why_when_there_is_none(
    tmp_path: Path, pitch_tracker: FakePitchTracker
) -> None:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        files = {"file": ("tone.wav", wav_bytes(stereo_tone()), "audio/wav")}
        song_id = client.post("/songs", files=files).json()["song_id"]
        assert client.app.state.jobs.wait_idle(timeout=10.0)
        store: SongStore = client.app.state.store
        write_flac(store.song_dir(song_id) / "vocals.flac", sung(2.0)[None, :], RATE)

        assert client.get(f"/songs/{song_id}/reference").status_code == 409
        assert client.get(f"/songs/{'0' * 64}/reference").status_code == 404
        assert client.get("/songs/not-an-id/reference").status_code == 404

        run(store, song_id)
        response = client.get(f"/songs/{song_id}/reference")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    notes = Reference.model_validate(response.json()).notes
    assert [round(note.midi) for note in notes] == [57, 64]
