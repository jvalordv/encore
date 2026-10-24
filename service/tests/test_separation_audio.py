"""Tests for reading a song and writing its stems: libsndfile, ffmpeg, FLAC.

ffmpeg is faked wherever the question is what is asked of it, and run for real
(skipped where it is not installed) where the question is what comes out.
"""

import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_service import separation, youtube
from encore_service.separation import read_audio, write_flac
from tests.fakes import (
    FLAC_ATOL,
    STEM_RATE,
    WAV_ATOL,
    encode_with_ffmpeg,
    known_sources,
    needs_ffmpeg,
    stereo_tone,
    wav_bytes,
)

# --- writing a stem ---------------------------------------------------------


def test_flac_stems_are_24_bit_at_the_given_rate(tmp_path: Path) -> None:
    wav = known_sources(4_000, 16_000)["vocals"]
    path = tmp_path / "vocals.flac"

    write_flac(path, wav, 16_000)

    info = sf.info(str(path))
    assert (info.format, info.subtype) == ("FLAC", "PCM_24")
    assert (info.samplerate, info.channels, info.frames) == (16_000, 2, 4_000)
    data, _ = sf.read(str(path), dtype="float32", always_2d=True)
    # Channels stay on their own sides: the right is half the left.
    np.testing.assert_allclose(data.T, wav, atol=FLAC_ATOL)


# --- reading the song ---------------------------------------------------------


def test_a_stereo_file_is_read_as_channels_by_samples(tmp_path: Path) -> None:
    wav = stereo_tone(0.5, 22_050)
    path = tmp_path / "tone.wav"
    path.write_bytes(wav_bytes(wav, 22_050))

    got, rate = read_audio(path, tmp_path)

    assert rate == 22_050
    assert got.shape == wav.shape and got.dtype == np.float32
    assert got.flags.c_contiguous
    np.testing.assert_allclose(got, wav, atol=WAV_ATOL)


def test_a_mono_file_becomes_two_identical_channels(tmp_path: Path) -> None:
    mono = stereo_tone(0.2)[:1]
    path = tmp_path / "mono.wav"
    path.write_bytes(wav_bytes(mono))

    got, _ = read_audio(path, tmp_path)

    assert got.shape == (2, mono.shape[1])
    np.testing.assert_array_equal(got[0], got[1])
    np.testing.assert_allclose(got[0], mono[0], atol=WAV_ATOL)


def test_flac_is_read_without_ffmpeg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(separation.shutil, "which", lambda name: None)
    wav = stereo_tone(0.2)
    path = tmp_path / "tone.flac"
    sf.write(str(path), wav.T, STEM_RATE, format="FLAC", subtype="PCM_24")

    got, rate = read_audio(path, tmp_path)

    assert rate == STEM_RATE
    np.testing.assert_allclose(got, wav, atol=FLAC_ATOL)


def test_a_file_with_no_samples_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "empty.wav"
    sf.write(str(path), np.zeros((0, 2), dtype=np.float32), STEM_RATE)

    with pytest.raises(ValueError, match="the file has no samples"):
        read_audio(path, tmp_path)


def test_a_format_libsndfile_cannot_read_needs_ffmpeg_and_says_where_to_get_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(separation.shutil, "which", lambda name: None)
    path = tmp_path / "song.m4a"
    path.write_bytes(b"not something libsndfile reads")

    with pytest.raises(youtube.FfmpegError) as raised:
        read_audio(path, tmp_path)

    assert str(raised.value) == (
        "ffmpeg is not on PATH; see service/README.md (GPU setup, step 1)"
    )


# --- ffmpeg, faked ------------------------------------------------------------


class Ran:
    """What the fake subprocess.run was given."""

    def __init__(self) -> None:
        self.commands: list[list[str]] = []
        self.kwargs: list[dict[str, Any]] = []


@pytest.fixture
def ffmpeg_on_path(monkeypatch: pytest.MonkeyPatch) -> str:
    path = str(Path("/opt/ffmpeg/bin/ffmpeg"))
    monkeypatch.setattr(
        separation.shutil, "which", lambda name: path if name == "ffmpeg" else None
    )
    return path


def fake_ffmpeg(
    monkeypatch: pytest.MonkeyPatch,
    *,
    returncode: int = 0,
    stderr: bytes = b"",
    raises: BaseException | None = None,
) -> Ran:
    seen = Ran()

    def run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        seen.commands.append(command)
        seen.kwargs.append(kwargs)
        if raises is not None:
            raise raises
        return subprocess.CompletedProcess(command, returncode, b"", stderr)

    monkeypatch.setattr(separation.subprocess, "run", run)
    return seen


def test_ffmpeg_is_run_from_an_argument_list_to_make_a_24_bit_wav(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    seen = fake_ffmpeg(monkeypatch)
    src, dst = tmp_path / "a b; echo hi & c'd.m4a", tmp_path / "decoded.wav"

    separation._decode_with_ffmpeg(src, dst)

    assert seen.commands == [
        [
            ffmpeg_on_path,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(src),
            "-vn",
            "-map",
            "0:a:0",
            "-c:a",
            "pcm_s24le",
            "-af",
            "aformat=channel_layouts=mono|stereo",
            str(dst),
        ]
    ]
    [kwargs] = seen.kwargs
    # Never a shell: a path with a quote or a semicolon in it is just a path.
    assert not kwargs.get("shell")
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["capture_output"] is True
    assert kwargs["timeout"] > 0


def test_ffmpeg_gets_absolute_paths(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    seen = fake_ffmpeg(monkeypatch)
    monkeypatch.chdir(tmp_path)

    # A path starting with "-" would be read by ffmpeg as an option.
    separation._decode_with_ffmpeg(Path("-odd") / "in.m4a", Path("-odd") / "out.wav")

    command = seen.commands[0]
    assert Path(command[command.index("-i") + 1]).is_absolute()
    assert Path(command[-1]).is_absolute()


def test_audio_that_ffmpeg_wrote_but_cannot_be_read_back_is_reported(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    # An ffmpeg that exits 0 and leaves no usable file behind.
    fake_ffmpeg(monkeypatch)
    song = tmp_path / "song.m4a"
    song.write_bytes(b"not something libsndfile reads")
    scratch = tmp_path / ".separate"
    scratch.mkdir()

    with pytest.raises(youtube.FfmpegError) as raised:
        read_audio(song, scratch)

    assert str(raised.value) == "ffmpeg wrote audio that could not be read back"
    assert list(scratch.iterdir()) == []


def test_ffmpeg_failure_carries_the_last_500_characters_of_stderr(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    fake_ffmpeg(monkeypatch, returncode=1, stderr=b"x" * 700 + b"the real reason\n")
    dst = tmp_path / "decoded.wav"
    dst.write_bytes(b"a stub the failed run left")

    with pytest.raises(youtube.FfmpegError) as raised:
        separation._decode_with_ffmpeg(tmp_path / "in.m4a", dst)

    message = str(raised.value)
    assert message.startswith("ffmpeg failed (exit status 1): ")
    detail = message.split(": ", 1)[1]
    assert len(detail) == 500 and detail.endswith("the real reason")
    assert not dst.exists()


def test_ffmpeg_failure_with_no_stderr_still_says_the_exit_status(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    fake_ffmpeg(monkeypatch, returncode=3)
    with pytest.raises(youtube.FfmpegError) as raised:
        separation._decode_with_ffmpeg(tmp_path / "in.m4a", tmp_path / "out.wav")
    assert str(raised.value) == "ffmpeg failed (exit status 3)"


def test_a_hung_ffmpeg_is_given_up_on_and_leaves_no_stub(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    fake_ffmpeg(monkeypatch, raises=subprocess.TimeoutExpired("ffmpeg", 600))
    dst = tmp_path / "decoded.wav"
    dst.write_bytes(b"partial")
    with pytest.raises(youtube.FfmpegError, match="did not finish"):
        separation._decode_with_ffmpeg(tmp_path / "in.m4a", dst)
    assert not dst.exists()


def test_an_ffmpeg_that_cannot_start_is_reported(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    fake_ffmpeg(monkeypatch, raises=PermissionError("access denied"))
    with pytest.raises(youtube.FfmpegError, match="could not be started"):
        separation._decode_with_ffmpeg(tmp_path / "in.m4a", tmp_path / "out.wav")


# --- ffmpeg, for real ---------------------------------------------------------


def dominant_hz(samples: np.ndarray, rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(samples.size)))
    return float(np.argmax(spectrum) * rate / samples.size)


@needs_ffmpeg
def test_an_m4a_is_decoded_by_ffmpeg_into_stereo(tmp_path: Path) -> None:
    rate, seconds = 44_100, 1.0
    t = np.arange(int(rate * seconds)) / rate
    tone = (0.4 * np.sin(2 * np.pi * 1_000 * t)).astype(np.float32)
    source = tmp_path / "tone.wav"
    sf.write(str(source), tone, rate, subtype="PCM_16")
    song = tmp_path / "song.m4a"
    encode_with_ffmpeg(source, song, "-c:a", "aac", "-b:a", "192k")
    scratch = tmp_path / ".separate"
    scratch.mkdir()

    # libsndfile cannot read it, which is why ffmpeg runs.
    with pytest.raises(RuntimeError):
        sf.info(str(song))

    wav, got_rate = read_audio(song, scratch)

    assert got_rate == rate
    assert wav.shape[0] == 2 and wav.dtype == np.float32
    assert wav.shape[1] / rate == pytest.approx(seconds, abs=0.1)
    # Mono AAC, played on both sides.
    np.testing.assert_array_equal(wav[0], wav[1])
    # The tone survived the codec and the decode.
    middle = wav[0, rate // 4 : rate // 4 + 8_192]
    assert dominant_hz(middle, rate) == pytest.approx(1_000, abs=15)
    # The decoded copy is deleted as soon as it is read.
    assert list(scratch.iterdir()) == []


@needs_ffmpeg
def test_five_one_audio_is_folded_to_stereo_with_its_centre_kept(
    tmp_path: Path,
) -> None:
    rate, seconds = 48_000, 0.5
    t = np.arange(int(rate * seconds)) / rate
    # 5.1 order is FL FR FC LFE BL BR; a vocal lives in FC. Only FC has sound.
    six = np.zeros((t.size, 6))
    six[:, 2] = 0.5 * np.sin(2 * np.pi * 440 * t)
    song = tmp_path / "six.wav"
    sf.write(str(song), six, rate, subtype="FLOAT")
    scratch = tmp_path / ".separate"
    scratch.mkdir()

    wav, got_rate = read_audio(song, scratch)

    assert got_rate == rate
    assert wav.shape[0] == 2
    # Taking the first two channels would leave silence; the downmix keeps the
    # centre, equally on both sides.
    left, right = float(np.abs(wav[0]).max()), float(np.abs(wav[1]).max())
    assert left > 0.1
    assert left == pytest.approx(right, abs=1e-3)


@needs_ffmpeg
def test_ffmpeg_rejects_a_file_that_is_not_audio_and_says_so(tmp_path: Path) -> None:
    song = tmp_path / "junk.m4a"
    song.write_bytes(b"this is not a media file at all")
    scratch = tmp_path / ".separate"
    scratch.mkdir()

    with pytest.raises(youtube.FfmpegError, match=r"ffmpeg failed \(exit status"):
        read_audio(song, scratch)

    assert list(scratch.iterdir()) == []
