"""Tests for the separation step as the pipeline runs it, with a fake model.

The model is a fake (see tests/fakes.py), so nothing here needs torch or
downloads weights, and the file passes in CI, where torch is not installed.
The arithmetic is in test_separation_math.py, reading and writing audio in
test_separation_audio.py, and what the real model code does with real tensors
in test_separation_torch.py, which is skipped without torch.
"""

import hashlib
import io
import json
import logging
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from encore_service import pipeline, registry, separation
from encore_service.app import create_app
from encore_service.config import Settings
from encore_service.errors import StepSkipped
from encore_service.pipeline import initial_status, prepare
from encore_service.separation import (
    CLIP_CEILING,
    INSTALL_HINT,
    Audio,
    SeparationError,
    separate_vocals,
)
from encore_service.store import SongMeta, SongStore
from tests.fakes import (
    FLAC_ATOL,
    REAL_LOAD_DEMUCS,
    STEM_RATE,
    WAV_ATOL,
    FakeSeparator,
    add_song,
    backing_of,
    encode_with_ffmpeg,
    known_sources,
    needs_ffmpeg,
    read_stem,
    song_files,
    stereo_tone,
    wav_bytes,
)

WAIT_S = 10.0
SERVICE_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def cpu_device(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run every test here as if ENCORE_DEVICE=cpu, so none imports torch."""
    monkeypatch.setenv("ENCORE_DEVICE", "cpu")
    monkeypatch.delenv("ENCORE_DEMUCS_MODEL", raising=False)


# --- helpers ------------------------------------------------------------------


def run(store: SongStore, song_id: str) -> list[float]:
    """Run the step on a song; returns the progress it reported."""
    reported: list[float] = []
    separate_vocals(store, song_id, reported.append)
    return reported


# --- the step, end to end with a fake model -----------------------------------


def test_the_step_installs_both_stems_as_24_bit_flac(
    store: SongStore, separator: FakeSeparator
) -> None:
    song_id = add_song(store)
    sources = known_sources(STEM_RATE, STEM_RATE)

    reported = run(store, song_id)

    assert song_files(store, song_id) == [
        "meta.json",
        "no_vocals.flac",
        "source.wav",
        "status.json",
        "vocals.flac",
    ]
    for stem in ("vocals", "no_vocals"):
        path = store.stem_path(song_id, stem)
        assert path is not None
        info = sf.info(str(path))
        assert (info.format, info.subtype) == ("FLAC", "PCM_24")
        assert (info.samplerate, info.channels) == (STEM_RATE, 2)
        assert info.frames == STEM_RATE
    np.testing.assert_allclose(
        read_stem(store, song_id, "vocals"), sources["vocals"], atol=FLAC_ATOL
    )
    np.testing.assert_allclose(
        read_stem(store, song_id, "no_vocals"), backing_of(sources), atol=FLAC_ATOL
    )
    meta = store.read_meta(song_id)
    assert meta is not None and meta.stem_gain == 1.0
    # What the model reported, then the step's own end.
    assert reported == [0.25, 0.5, 0.95, 1.0]


def test_the_model_is_given_the_songs_stereo_audio_at_the_songs_rate(
    store: SongStore, separator: FakeSeparator
) -> None:
    wav = stereo_tone(0.5, 22_050)
    song_id = add_song(store, wav, rate=22_050, duration_s=0.5)

    run(store, song_id)

    [heard] = separator.heard
    assert separator.heard_rates == [22_050]
    np.testing.assert_allclose(heard, wav, atol=WAV_ATOL)


def test_a_mono_song_reaches_the_model_as_two_identical_channels(
    store: SongStore, separator: FakeSeparator
) -> None:
    song_id = add_song(store, stereo_tone(0.5)[:1])

    run(store, song_id)

    [heard] = separator.heard
    assert heard.shape[0] == 2
    np.testing.assert_array_equal(heard[0], heard[1])


def test_stems_are_written_at_the_models_rate_not_the_songs(
    store: SongStore, separator: FakeSeparator
) -> None:
    separator.samplerate = 16_000
    song_id = add_song(store)  # an 8 kHz song

    run(store, song_id)

    path = store.stem_path(song_id, "vocals")
    assert path is not None
    info = sf.info(str(path))
    assert (info.samplerate, info.frames) == (16_000, 2 * STEM_RATE)
    # The model was told the song's own rate, to resample from.
    assert separator.heard_rates == [STEM_RATE]


def test_stems_that_would_clip_are_scaled_together_and_the_gain_recorded(
    store: SongStore, separator: FakeSeparator
) -> None:
    separator.make = lambda samples, rate: known_sources(samples, rate, scale=4.0)
    song_id = add_song(store)
    sources = known_sources(STEM_RATE, STEM_RATE, scale=4.0)
    peak = max(
        float(np.abs(sources["vocals"]).max()),
        float(np.abs(backing_of(sources)).max()),
    )
    assert peak > 1.0  # the loudest of the two would clip as it is

    run(store, song_id)

    gain = CLIP_CEILING / peak
    meta = store.read_meta(song_id)
    assert meta is not None
    assert meta.stem_gain == pytest.approx(gain, rel=1e-6)
    vocals, backing = (read_stem(store, song_id, s) for s in ("vocals", "no_vocals"))
    assert max(float(np.abs(vocals).max()), float(np.abs(backing).max())) <= 1.0
    # The sum is the model's own, times the gain. (What the model made are
    # estimates of the voice and the rest, not an exact split of the song.)
    np.testing.assert_allclose(
        vocals + backing,
        gain * (sources["vocals"] + backing_of(sources)),
        atol=1e-6,
    )
    # And the ratio between them is the model's own.
    np.testing.assert_allclose(vocals, gain * sources["vocals"], atol=FLAC_ATOL)
    # What a reader of the stems does: divide by the gain that meta.json
    # records, and each stem is at the level the model made it.
    np.testing.assert_allclose(
        vocals / meta.stem_gain, sources["vocals"], atol=2 * FLAC_ATOL
    )
    np.testing.assert_allclose(
        backing / meta.stem_gain, backing_of(sources), atol=2 * FLAC_ATOL
    )


def test_a_second_separation_resets_the_gain_to_one(
    store: SongStore, separator: FakeSeparator
) -> None:
    song_id = add_song(store)
    store.set_stem_gain(song_id, 0.5)  # left by an earlier, louder separation

    run(store, song_id)

    meta = store.read_meta(song_id)
    assert meta is not None and meta.stem_gain == 1.0


def test_the_scratch_folder_is_gone_after_a_success(
    store: SongStore, separator: FakeSeparator
) -> None:
    song_id = add_song(store)
    run(store, song_id)
    assert not (store.song_dir(song_id) / ".separate").exists()


def test_what_an_earlier_crash_left_in_the_scratch_folder_is_cleared(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = add_song(store)
    work = store.song_dir(song_id) / ".separate"
    (work / "nested").mkdir(parents=True)
    (work / "vocals.flac").write_bytes(b"a half-written stem")
    (work / "decoded.wav").write_bytes(b"x" * 1000)
    found: list[list[str]] = []
    real_read = separation.read_audio

    def read(path: Path, scratch: Path) -> tuple[Audio, int]:
        found.append(sorted(p.name for p in scratch.iterdir()))
        return real_read(path, scratch)

    monkeypatch.setattr(separation, "read_audio", read)

    run(store, song_id)

    # Empty when the work began, so nothing stale can be read or installed.
    assert found == [[]]
    assert not work.exists()
    assert sf.info(str(store.stem_path(song_id, "vocals"))).frames == STEM_RATE


def test_the_stems_are_written_aside_and_moved_in_only_once_both_are_whole(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = add_song(store)
    folder = store.song_dir(song_id)
    seen_while_writing: list[list[str]] = []
    real_write = separation.write_flac

    def write(path: Path, wav: Audio, rate: int) -> None:
        # Nothing the stems route serves exists while a stem is being written.
        seen_while_writing.append(sorted(p.name for p in folder.iterdir()))
        assert path.parent == folder / ".separate"
        real_write(path, wav, rate)

    at_first_install: list[tuple[bool, bool, bool]] = []
    real_install = store.install_stem

    def install(sid: str, stem: str, finished: Path) -> Path:
        if not at_first_install:
            work = folder / ".separate"
            at_first_install.append(
                (
                    sf.info(str(work / "vocals.flac")).frames == STEM_RATE,
                    sf.info(str(work / "no_vocals.flac")).frames == STEM_RATE,
                    store.stem_path(sid, "vocals") is None,
                )
            )
        return real_install(sid, stem, finished)

    monkeypatch.setattr(separation, "write_flac", write)
    monkeypatch.setattr(store, "install_stem", install)

    run(store, song_id)

    assert len(seen_while_writing) == 2
    for names in seen_while_writing:
        assert "vocals.flac" not in names and "no_vocals.flac" not in names
    assert at_first_install == [(True, True, True)]


def test_the_gain_is_recorded_before_the_stems_go_in(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = add_song(store)
    order: list[str] = []
    real_gain, real_install = store.set_stem_gain, store.install_stem

    def gain(sid: str, value: float) -> None:
        order.append("gain")
        real_gain(sid, value)

    def install(sid: str, stem: str, finished: Path) -> Path:
        order.append(f"install {stem}")
        return real_install(sid, stem, finished)

    monkeypatch.setattr(store, "set_stem_gain", gain)
    monkeypatch.setattr(store, "install_stem", install)

    run(store, song_id)

    assert order == ["gain", "install vocals", "install no_vocals"]


def test_a_song_of_unknown_length_gets_the_length_of_its_audio(
    store: SongStore, separator: FakeSeparator
) -> None:
    song_id = add_song(store, stereo_tone(0.75), duration_s=None)
    before = store.read_status(song_id)
    assert before is not None and before.duration_s is None

    run(store, song_id)

    meta, status = store.read_meta(song_id), store.read_status(song_id)
    assert meta is not None and status is not None
    assert meta.duration_s == pytest.approx(0.75)
    assert status.duration_s == meta.duration_s
    # Only the length changed.
    assert (status.title, status.source) == (before.title, before.source)


@needs_ffmpeg
def test_an_m4a_upload_is_separated_and_gets_its_length_from_the_decoded_audio(
    store: SongStore, separator: FakeSeparator, tmp_path: Path
) -> None:
    rate = 44_100
    wav = stereo_tone(1.0, rate)
    source = tmp_path / "tone.wav"
    sf.write(str(source), wav.T, rate, subtype="PCM_16")
    m4a = tmp_path / "tone.m4a"
    encode_with_ffmpeg(source, m4a, "-c:a", "aac", "-b:a", "192k")
    data = m4a.read_bytes()
    song_id = hashlib.sha256(data).hexdigest()
    part = store.incoming_path()
    part.write_bytes(data)
    # libsndfile cannot read an m4a, so the upload route finds no length.
    meta = SongMeta(source="file", title="tone", duration_s=None)
    store.add_upload(song_id, part, ".m4a", meta, initial_status(song_id, meta))

    run(store, song_id)

    [heard] = separator.heard
    assert separator.heard_rates == [rate]
    assert heard.shape[0] == 2
    assert heard.shape[1] / rate == pytest.approx(1.0, abs=0.1)
    stored = store.read_meta(song_id)
    status = store.read_status(song_id)
    assert stored is not None and status is not None
    assert stored.duration_s == pytest.approx(heard.shape[1] / rate)
    assert status.duration_s == stored.duration_s
    assert song_files(store, song_id) == [
        "meta.json",
        "no_vocals.flac",
        "source.m4a",
        "status.json",
        "vocals.flac",
    ]


def test_a_song_of_known_length_keeps_it(
    store: SongStore, separator: FakeSeparator
) -> None:
    # What a link claimed, which the audio does not overrule.
    song_id = add_song(store, stereo_tone(0.75), duration_s=200.0)

    run(store, song_id)

    meta = store.read_meta(song_id)
    assert meta is not None and meta.duration_s == 200.0


def test_a_song_whose_meta_is_gone_still_gets_its_length_in_the_status(
    store: SongStore, separator: FakeSeparator
) -> None:
    song_id = add_song(store, duration_s=None)
    (store.song_dir(song_id) / "meta.json").unlink()

    # The gain has nowhere to go without a meta.json, so the step says so
    # rather than lose it; the length was recorded before that.
    with pytest.raises(SeparationError, match="Saving the stems failed: No meta"):
        run(store, song_id)

    status = store.read_status(song_id)
    assert status is not None and status.duration_s == pytest.approx(1.0)
    assert store.stem_path(song_id, "vocals") is None


def test_the_model_is_loaded_once_and_kept_for_the_next_song(
    store: SongStore, separator: FakeSeparator
) -> None:
    first, second = add_song(store), add_song(store, stereo_tone(0.5))

    run(store, first)
    run(store, second)

    assert separator.loads == [("htdemucs_ft", "cpu")]
    assert registry.loaded_models() == ["demucs:htdemucs_ft@cpu"]


def test_the_model_and_device_come_from_the_environment(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ENCORE_DEMUCS_MODEL", "htdemucs_6s")
    monkeypatch.setenv("ENCORE_DEVICE", "cuda")

    run(store, add_song(store))

    assert separator.loads == [("htdemucs_6s", "cuda")]
    assert registry.loaded_models() == ["demucs:htdemucs_6s@cuda"]


# --- the step, failing --------------------------------------------------------


def assert_nothing_left_behind(store: SongStore, song_id: str) -> None:
    assert not (store.song_dir(song_id) / ".separate").exists()
    assert store.stem_path(song_id, "vocals") is None
    assert store.stem_path(song_id, "no_vocals") is None
    assert song_files(store, song_id) == ["meta.json", "source.wav", "status.json"]


def test_a_failing_model_fails_the_step_saying_what_and_why(
    store: SongStore, separator: FakeSeparator
) -> None:
    separator.error = RuntimeError("kernel launch failed")
    song_id = add_song(store)

    with pytest.raises(SeparationError) as raised:
        run(store, song_id)

    assert str(raised.value) == "Separating the vocal failed: kernel launch failed"
    assert isinstance(raised.value.__cause__, RuntimeError)
    assert_nothing_left_behind(store, song_id)


def test_running_out_of_gpu_memory_reaches_the_step_as_the_advice_alone(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    separator.error = SeparationError(separation.OUT_OF_MEMORY)
    song_id = add_song(store)
    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate_vocals)

    pipeline.prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    step = status.steps.separation
    # Not "Separating the vocal failed: ...": the advice is the whole message.
    assert (step.state, step.error) == (
        "failed",
        "The GPU ran out of memory while separating. Close other programs using "
        "the GPU, or set ENCORE_DEVICE=cpu (much slower).",
    )
    assert_nothing_left_behind(store, song_id)


def test_a_failure_with_no_message_names_its_type(
    store: SongStore, separator: FakeSeparator
) -> None:
    separator.error = MemoryError()
    with pytest.raises(SeparationError, match=r"^Separating the vocal failed: Mem"):
        run(store, add_song(store))


def test_a_model_that_cannot_be_loaded_fails_before_the_audio_is_read(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    separator.load_error = OSError("no network to fetch the weights")
    song_id = add_song(store)

    def read(path: Path, scratch: Path) -> tuple[Audio, int]:
        raise AssertionError("the audio was read before the model was ready")

    monkeypatch.setattr(separation, "read_audio", read)

    with pytest.raises(SeparationError) as raised:
        run(store, song_id)

    assert str(raised.value) == (
        "Loading the separation model failed: no network to fetch the weights"
    )
    assert registry.loaded_models() == []
    assert_nothing_left_behind(store, song_id)


def test_a_song_whose_audio_cannot_be_read_fails_the_step(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(separation.shutil, "which", lambda name: None)
    data = b"neither wav nor anything libsndfile knows"
    song_id = hashlib.sha256(data).hexdigest()
    part = store.incoming_path()
    part.write_bytes(data)
    meta = SongMeta(source="file", title="junk")
    store.add_upload(song_id, part, ".m4a", meta, initial_status(song_id, meta))

    with pytest.raises(SeparationError) as raised:
        run(store, song_id)

    assert str(raised.value) == (
        "Reading the audio failed: "
        "ffmpeg is not on PATH; see service/README.md (GPU setup, step 1)"
    )
    assert separator.heard == []
    assert not (store.song_dir(song_id) / ".separate").exists()


def test_a_model_with_no_voice_fails_the_step_and_installs_nothing(
    store: SongStore, separator: FakeSeparator
) -> None:
    def no_voice(samples: int, rate: int) -> dict[str, Audio]:
        sources = known_sources(samples, rate)
        del sources["vocals"]
        return sources

    separator.make = no_voice
    song_id = add_song(store)

    with pytest.raises(SeparationError) as raised:
        run(store, song_id)

    assert str(raised.value) == (
        "Saving the stems failed: "
        "the model makes no vocals source, only drums, bass, other"
    )
    assert_nothing_left_behind(store, song_id)


def test_audio_that_is_not_numbers_fails_the_step_and_installs_nothing(
    store: SongStore, separator: FakeSeparator
) -> None:
    def broken(samples: int, rate: int) -> dict[str, Audio]:
        sources = known_sources(samples, rate)
        sources["vocals"][0, 3] = np.nan
        return sources

    separator.make = broken
    song_id = add_song(store)

    with pytest.raises(SeparationError) as raised:
        run(store, song_id)

    assert str(raised.value) == (
        "Saving the stems failed: "
        "the separated audio holds values that are not numbers (NaN or infinity)"
    )
    assert_nothing_left_behind(store, song_id)


def test_a_failure_while_writing_the_second_stem_installs_neither(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = add_song(store)
    real_write = separation.write_flac
    calls: list[str] = []

    def write(path: Path, wav: Audio, rate: int) -> None:
        calls.append(path.name)
        if len(calls) == 2:
            raise OSError("No space left on device")
        real_write(path, wav, rate)

    monkeypatch.setattr(separation, "write_flac", write)

    with pytest.raises(SeparationError) as raised:
        run(store, song_id)

    assert str(raised.value) == "Saving the stems failed: No space left on device"
    assert calls == ["vocals.flac", "no_vocals.flac"]
    assert_nothing_left_behind(store, song_id)
    meta = store.read_meta(song_id)
    assert meta is not None and meta.stem_gain == 1.0


def test_a_failure_moving_a_stem_in_is_worded_like_the_others(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = add_song(store)

    def refuse(sid: str, stem: str, finished: Path) -> Path:
        raise PermissionError("held open by a scanner")

    monkeypatch.setattr(store, "install_stem", refuse)

    with pytest.raises(SeparationError, match="^Saving the stems failed: held open"):
        run(store, song_id)

    assert not (store.song_dir(song_id) / ".separate").exists()


def refusing_install(
    store: SongStore, monkeypatch: pytest.MonkeyPatch, stem: str
) -> None:
    """Make moving `stem` into the song's folder fail, as a locked file does."""
    real_install = store.install_stem

    def install(sid: str, name: str, finished: Path) -> Path:
        if name == stem:
            raise PermissionError("held open by a scanner")
        return real_install(sid, name, finished)

    monkeypatch.setattr(store, "install_stem", install)


@pytest.mark.parametrize("failing", ["vocals", "no_vocals"])
def test_a_stem_that_cannot_be_moved_in_leaves_neither_stem_to_be_served(
    store: SongStore,
    separator: FakeSeparator,
    monkeypatch: pytest.MonkeyPatch,
    failing: str,
) -> None:
    song_id = add_song(store)
    refusing_install(store, monkeypatch, failing)

    with pytest.raises(SeparationError, match="^Saving the stems failed: held open"):
        run(store, song_id)

    # Not the voice alone: the stems route would serve it as if it were whole.
    assert_nothing_left_behind(store, song_id)


def test_a_failed_install_does_not_leave_a_new_stem_beside_an_old_one(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = add_song(store)
    run(store, song_id)  # an earlier separation, whose pair is in the folder
    assert store.stem_path(song_id, "vocals") and store.stem_path(song_id, "no_vocals")
    separator.make = lambda samples, rate: known_sources(samples, rate, scale=0.5)
    refusing_install(store, monkeypatch, "no_vocals")

    with pytest.raises(SeparationError, match="^Saving the stems failed: held open"):
        run(store, song_id)

    # Neither the new voice beside the old backing, nor the old voice beside
    # the gain that the new run recorded.
    assert_nothing_left_behind(store, song_id)


def test_a_stem_that_cannot_be_removed_does_not_hide_why_the_install_failed(
    store: SongStore,
    separator: FakeSeparator,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    song_id = add_song(store)
    run(store, song_id)
    refusing_install(store, monkeypatch, "no_vocals")
    real_unlink = Path.unlink

    def unlink(self: Path, missing_ok: bool = False) -> None:
        # What Windows does to a file that the browser is still reading.
        if self.name == "vocals.flac":
            raise PermissionError("held open by the browser")
        real_unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", unlink)

    with caplog.at_level(logging.WARNING, logger="encore_service.separation"):
        with pytest.raises(SeparationError) as raised:
            run(store, song_id)

    # The step fails for the reason it failed, not for the clean-up's; the log
    # says which stem stayed, and the one that could go has gone.
    assert str(raised.value) == "Saving the stems failed: held open by a scanner"
    assert "Could not remove" in caplog.text and "vocals.flac" in caplog.text
    assert store.stem_path(song_id, "no_vocals") is None


def test_a_song_with_no_audio_cannot_be_separated(
    store: SongStore, separator: FakeSeparator
) -> None:
    song_id = add_song(store)
    (store.song_dir(song_id) / "source.wav").unlink()

    with pytest.raises(SeparationError) as raised:
        run(store, song_id)

    assert str(raised.value) == "Reading the audio failed: the song has no source audio"
    assert separator.loads == []


def test_a_song_with_no_samples_fails_the_step_saying_so(
    store: SongStore, separator: FakeSeparator
) -> None:
    song_id = add_song(store, np.zeros((2, 0), dtype=np.float32), duration_s=None)

    with pytest.raises(SeparationError) as raised:
        run(store, song_id)

    assert str(raised.value) == "Reading the audio failed: the file has no samples"
    assert isinstance(raised.value.__cause__, ValueError)
    assert separator.heard == []
    assert_nothing_left_behind(store, song_id)


def test_a_test_with_no_fake_cannot_load_a_real_model(
    store: SongStore, no_real_models: list[str]
) -> None:
    song_id = add_song(store)

    with pytest.raises(SeparationError, match="without a fake"):
        run(store, song_id)

    # The step turns any error into a failed step, so the guard also keeps a
    # record, which fails the test afterwards.
    assert len(no_real_models) == 1
    # The guard has done its job; clear its record so this test is not failed.
    no_real_models.clear()


# --- no torch -----------------------------------------------------------------


@pytest.mark.parametrize(
    "module", ["torch", "julius", "demucs.apply", "demucs.pretrained"]
)
def test_a_missing_piece_of_the_extra_skips_the_step_with_the_install_command(
    store: SongStore, monkeypatch: pytest.MonkeyPatch, module: str
) -> None:
    monkeypatch.setattr(separation, "load_demucs", REAL_LOAD_DEMUCS)
    # A None entry makes the import raise ImportError, even if installed.
    monkeypatch.setitem(sys.modules, module, None)
    song_id = add_song(store)

    with pytest.raises(StepSkipped) as raised:
        run(store, song_id)

    assert raised.value.reason == INSTALL_HINT
    assert INSTALL_HINT == (
        "Install the separation extra: cd service && uv sync --extra separation "
        "(see service/README.md, GPU setup)"
    )
    # Nothing was read or made, and no model is claimed to be loaded.
    assert not (store.song_dir(song_id) / ".separate").exists()
    assert registry.loaded_models() == []


def test_a_torch_that_will_not_load_skips_the_step_and_says_why(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(separation, "load_demucs", REAL_LOAD_DEMUCS)
    real_import = separation.importlib.import_module

    def broken_cuda(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "torch":
            raise OSError("[WinError 126] fbgemm.dll or one of its dependencies")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(separation.importlib, "import_module", broken_cuda)

    with pytest.raises(StepSkipped) as raised:
        run(store, add_song(store))

    assert raised.value.reason == (
        "torch could not be loaded ([WinError 126] fbgemm.dll or one of its "
        "dependencies). " + INSTALL_HINT
    )


# --- through the pipeline and the app -----------------------------------------


def test_the_pipeline_runs_the_step_and_the_steps_after_it_wait_their_turn(
    store: SongStore, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate_vocals)
    song_id = add_song(store)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.separation.state, status.steps.separation.progress) == (
        "done",
        1.0,
    )
    assert status.steps.reference.detail == "Not built yet (ROADMAP P2-T3)"
    assert store.stem_path(song_id, "vocals") is not None


def test_without_the_extra_the_pipeline_skips_separation_and_what_needs_it(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate_vocals)
    monkeypatch.setitem(pipeline.RUNNERS, "reference", lambda *args: None)
    monkeypatch.setitem(pipeline.RUNNERS, "lyrics", lambda *args: None)
    monkeypatch.setattr(separation, "load_demucs", REAL_LOAD_DEMUCS)
    monkeypatch.setitem(sys.modules, "torch", None)
    song_id = add_song(store)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    separation_step = status.steps.separation
    assert (separation_step.state, separation_step.detail) == ("skipped", INSTALL_HINT)
    assert separation_step.error is None
    for dependant in (status.steps.reference, status.steps.lyrics):
        assert (dependant.state, dependant.detail) == ("skipped", "Needs separation")


def test_separation_is_the_runner_registered_for_its_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.undo()  # the real registry, not the emptied one
    assert pipeline.RUNNERS["separation"] is separate_vocals


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        yield client


def test_a_song_added_through_the_app_is_separated_and_its_stems_are_served(
    client: TestClient, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate_vocals)
    data = wav_bytes(stereo_tone())

    posted = client.post("/songs", files={"file": ("tone.wav", data, "audio/wav")})
    song_id = posted.json()["song_id"]
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)

    steps = client.get(f"/songs/{song_id}").json()["steps"]
    assert steps["separation"]["state"] == "done"
    sources = known_sources(STEM_RATE, STEM_RATE)
    for stem, expected in (
        ("vocals", sources["vocals"]),
        ("no_vocals", backing_of(sources)),
    ):
        response = client.get(f"/songs/{song_id}/stems/{stem}")
        assert response.status_code == 200
        assert response.headers["content-type"] == "audio/flac"
        decoded, rate = sf.read(io.BytesIO(response.content), dtype="float32")
        assert rate == STEM_RATE
        np.testing.assert_allclose(decoded.T, expected, atol=FLAC_ATOL)
    # The model that did it is on the /gpu report.
    assert client.get("/gpu").json()["loaded_models"] == ["demucs:htdemucs_ft@cpu"]


@pytest.mark.parametrize("gone", [["vocals"], ["no_vocals"], ["vocals", "no_vocals"]])
def test_adding_a_song_again_separates_it_again_once_its_stems_have_gone(
    client: TestClient,
    separator: FakeSeparator,
    monkeypatch: pytest.MonkeyPatch,
    gone: list[str],
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate_vocals)
    files = {"file": ("tone.wav", wav_bytes(stereo_tone()), "audio/wav")}
    song_id = client.post("/songs", files=files).json()["song_id"]
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)
    assert len(separator.heard) == 1
    folder = client.app.state.store.song_dir(song_id)
    for stem in gone:
        (folder / f"{stem}.flac").unlink()
        assert client.get(f"/songs/{song_id}/stems/{stem}").status_code == 409
    # The status still says done, which is all the browser would know.
    steps = client.get(f"/songs/{song_id}").json()["steps"]
    assert steps["separation"]["state"] == "done"

    again = client.post("/songs", files=files)

    # Queued again at once, not left saying done for stems that are not there.
    assert again.json()["steps"]["separation"]["state"] == "queued"
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)
    assert len(separator.heard) == 2
    for stem in ("vocals", "no_vocals"):
        assert client.get(f"/songs/{song_id}/stems/{stem}").status_code == 200
    steps = client.get(f"/songs/{song_id}").json()["steps"]
    assert steps["separation"]["state"] == "done"


def test_adding_a_song_again_leaves_a_finished_separation_alone(
    client: TestClient, separator: FakeSeparator, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate_vocals)
    files = {"file": ("tone.wav", wav_bytes(stereo_tone()), "audio/wav")}
    song_id = client.post("/songs", files=files).json()["song_id"]
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)

    again = client.post("/songs", files=files)

    assert again.json()["steps"]["separation"]["state"] == "done"
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)
    assert len(separator.heard) == 1
    assert client.get(f"/songs/{song_id}/stems/vocals").status_code == 200


# --- the service without torch ------------------------------------------------

# Run in a fresh interpreter, because only there is torch really not imported:
# the test process may have it. It imports the app, as uvicorn does. With
# `block` set, torch, demucs and julius cannot be imported at all, which is how
# CI looks, and it also serves a song and /gpu. Without it nothing is served:
# a song would be separated with the real model, which downloads weights.
APP_SCRIPT = """
import io, json, sys, tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

root, block = sys.argv[1], sys.argv[2] == "block"
if block:
    for name in ("torch", "demucs", "julius"):
        sys.modules[name] = None
sys.path.insert(0, root)

from fastapi.testclient import TestClient
from encore_service.app import create_app
from encore_service.config import Settings
import encore_service.pipeline as pipeline

heavy = ("torch", "demucs", "julius")
report = {
    "imported": sorted(m for m in heavy if sys.modules.get(m)),
    "runner": pipeline.RUNNERS["separation"].__name__,
}
if block:
    buffer = io.BytesIO()
    silence = np.zeros((800, 2), dtype=np.float32) + 0.1
    sf.write(buffer, silence, 8000, format="WAV")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as cache:
        settings = Settings(cache_dir=Path(cache), device_override="cpu")
        with TestClient(create_app(settings)) as client:
            files = {"file": ("t.wav", buffer.getvalue(), "audio/wav")}
            song_id = client.post("/songs", files=files).json()["song_id"]
            assert client.app.state.jobs.wait_idle(timeout=30)
            steps = client.get(f"/songs/{song_id}").json()["steps"]
            gpu = client.get("/gpu").json()
    report.update(
        separation=steps["separation"],
        reference=steps["reference"],
        torch_available=gpu["torch_available"],
        loaded_models=gpu["loaded_models"],
    )
print(json.dumps(report))
"""


def run_app_script(block: bool, tmp_path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, "-c", APP_SCRIPT, str(SERVICE_ROOT), "block" if block else ""],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=tmp_path,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_importing_the_app_does_not_import_torch_or_demucs(tmp_path: Path) -> None:
    report = run_app_script(False, tmp_path)

    # Building the model list for /gpu is bookkeeping: it never loads torch.
    assert report["imported"] == []
    assert report["runner"] == "separate_vocals"


def test_the_service_runs_and_skips_separation_when_torch_cannot_be_imported(
    tmp_path: Path,
) -> None:
    report = run_app_script(True, tmp_path)

    assert report["imported"] == []
    assert report["runner"] == "separate_vocals"
    assert report["torch_available"] is False
    assert report["loaded_models"] == []
    assert report["separation"]["state"] == "skipped"
    assert report["separation"]["detail"] == INSTALL_HINT
    assert report["reference"]["state"] == "skipped"
