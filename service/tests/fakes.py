"""Fakes shared by the service tests.

`Ydl` stands in for `yt_dlp.YoutubeDL` wherever a test would otherwise reach
YouTube: it records the options and URLs it is given and answers from fields
the test sets. `FetchFakes` replaces the two calls the fetch step makes
(`youtube.download_audio` and `youtube.to_flac`), so a test can run that step
without a network or ffmpeg; its conversion writes a real FLAC.
`FakePitchTracker` does the same for the pitch model of the reference step: it
follows a known melody whatever audio it is given. `FakeSeparator` stands in
for a loaded separation model: it returns stems of
known tones and records what it was given, so the separation step runs without
torch or weights; `add_song`, `known_sources` and the other audio helpers make
what the separation tests feed it and check against. The `ydl`, `fakes` and
`separator` fixtures in `conftest.py` install the fakes.
"""

import hashlib
import io
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
import yt_dlp

from encore_service import melody, pipeline, reference, separation, youtube
from encore_service.config import Settings
from encore_service.pipeline import initial_status
from encore_service.separation import Audio
from encore_service.store import SongMeta, SongStore

# The class itself, taken when the tests are collected, before any fixture has
# replaced it. A test that proves something about yt-dlp uses this one.
REAL_YOUTUBE_DL = yt_dlp.YoutubeDL
# Likewise the real model loader, for the test of what it does without torch.
REAL_LOAD_DEMUCS = separation.load_demucs
REAL_LOAD_CREPE = reference.load_crepe
# The step registry as shipped, before the tests empty it.
REAL_RUNNERS = dict(pipeline.RUNNERS)

# The audio the fake conversion writes, so its real length is known.
RATE = 8_000
SECONDS = 1.5


@dataclass
class Ydl:
    """What the fake YoutubeDL was given, and what it is told to do."""

    options: dict[str, Any] = field(default_factory=dict)
    extracted: list[tuple[str, bool]] = field(default_factory=list)
    downloaded: list[list[str]] = field(default_factory=list)
    closed: int = 0
    info: Any = None
    error: BaseException | None = None
    on_download: Callable[[dict[str, Any]], None] | None = None


def install_fake_ydl(monkeypatch: pytest.MonkeyPatch) -> Ydl:
    """Replace yt_dlp.YoutubeDL with a fake that records and never connects."""
    seen = Ydl()

    class FakeYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            seen.options = options

        def __enter__(self) -> "FakeYoutubeDL":
            return self

        def __exit__(self, *exc_info: object) -> None:
            seen.closed += 1

        def extract_info(self, url: str, download: bool = True) -> Any:
            seen.extracted.append((url, download))
            if seen.error is not None:
                raise seen.error
            return seen.info

        def download(self, urls: list[str]) -> int:
            seen.downloaded.append(list(urls))
            if seen.error is not None:
                raise seen.error
            if seen.on_download is not None:
                seen.on_download(seen.options)
            return 0

        def prepare_filename(self, info_dict: dict[str, Any]) -> str:
            # yt-dlp's own answer, so a test sees what the real one would do
            # with the output template (which expands $NAME, for one thing).
            return REAL_YOUTUBE_DL(dict(seen.options)).prepare_filename(info_dict)

    monkeypatch.setattr(youtube.yt_dlp, "YoutubeDL", FakeYoutubeDL)
    return seen


def write_flac(path: Path) -> None:
    """Write SECONDS of a 440 Hz tone to `path` as a real FLAC file."""
    t = np.arange(int(RATE * SECONDS)) / RATE
    sf.write(
        str(path),
        0.3 * np.sin(2 * np.pi * 440 * t),
        RATE,
        format="FLAC",
        subtype="PCM_16",
    )


@dataclass
class FetchFakes:
    """The YouTube calls the fetch step makes: what they saw, how they end."""

    downloads: list[tuple[str, Path, Settings]] = field(default_factory=list)
    in_work_dir: list[list[str]] = field(default_factory=list)
    conversions: list[tuple[Path, Path]] = field(default_factory=list)
    download_error: Exception | None = None
    convert_error: Exception | None = None
    unreadable_audio: bool = False


def install_fake_fetch(monkeypatch: pytest.MonkeyPatch) -> FetchFakes:
    """Replace the download and the conversion with fakes that record."""
    seen = FetchFakes()

    def download_audio(
        video_id: str,
        dest_dir: Path,
        report: Callable[[float], None],
        settings: Settings,
    ) -> Path:
        seen.downloads.append((video_id, dest_dir, settings))
        seen.in_work_dir.append(sorted(path.name for path in dest_dir.iterdir()))
        report(0.2)
        # What a download leaves behind when it dies half way.
        (dest_dir / "download.webm.part").write_bytes(b"half")
        if seen.download_error is not None:
            raise seen.download_error
        report(0.85)
        path = dest_dir / "download.webm"
        path.write_bytes(b"webm")
        return path

    def to_flac(src: Path, dst: Path) -> None:
        seen.conversions.append((src, dst))
        if seen.convert_error is not None:
            dst.write_bytes(b"stub")
            raise seen.convert_error
        if seen.unreadable_audio:
            dst.write_bytes(b"this is not a FLAC file")
        else:
            write_flac(dst)

    monkeypatch.setattr(youtube, "download_audio", download_audio)
    monkeypatch.setattr(youtube, "to_flac", to_flac)
    return seen


# --- separation --------------------------------------------------------------

# The rate of the audio the separation tests feed in, and of the fake model's
# stems unless a test says otherwise.
STEM_RATE = 8_000
# The step's stems are 24-bit: this is their rounding, with a float32 margin.
FLAC_ATOL = 2e-7
# Reading a 16-bit WAV back gives each sample to within this.
WAV_ATOL = 1.5 / 32768


def stereo_tone(seconds: float = 1.0, rate: int = STEM_RATE) -> Audio:
    """A stereo sine, a different level on each side, as (channels, samples)."""
    t = np.arange(int(seconds * rate)) / rate
    wave = np.sin(2 * np.pi * 220 * t)
    return np.stack([0.5 * wave, 0.25 * wave]).astype(np.float32)


def wav_bytes(wav: Audio, rate: int = STEM_RATE) -> bytes:
    """`wav`, shaped (channels, samples), as the bytes of a 16-bit WAV file."""
    buffer = io.BytesIO()
    sf.write(buffer, wav.T, rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def known_sources(samples: int, rate: int, scale: float = 1.0) -> dict[str, Audio]:
    """Four stereo sources of known tones, each a sine of its own pitch.

    The right side of the vocal is half the left, so a swapped or mixed channel
    shows. `scale` multiplies everything, for a test of clipping.
    """
    t = np.arange(samples) / rate

    def tone(hz: float, left: float, right: float) -> Audio:
        wave = np.sin(2 * np.pi * hz * t)
        return (scale * np.stack([left * wave, right * wave])).astype(np.float32)

    return {
        "drums": tone(100, 0.05, 0.05),
        "bass": tone(200, 0.10, 0.10),
        "other": tone(300, 0.15, 0.10),
        "vocals": tone(440, 0.30, 0.15),
    }


def backing_of(sources: dict[str, Audio]) -> Audio:
    """What the backing stem should be: every source but the voice, summed."""
    return sum(
        (stem for name, stem in sources.items() if name != "vocals"),
        start=np.zeros_like(sources["vocals"]),
    )


def add_song(
    store: SongStore,
    wav: Audio | None = None,
    rate: int = STEM_RATE,
    duration_s: float | None = 1.0,
) -> str:
    """Cache an uploaded WAV of `wav` (a stereo tone by default) as a song."""
    data = wav_bytes(stereo_tone(rate=rate) if wav is None else wav, rate)
    song_id = hashlib.sha256(data).hexdigest()
    part = store.incoming_path()
    part.write_bytes(data)
    meta = SongMeta(source="file", title="song", duration_s=duration_s)
    store.add_upload(song_id, part, ".wav", meta, initial_status(song_id, meta))
    return song_id


def read_stem(store: SongStore, song_id: str, stem: str) -> Audio:
    """A stem the step installed, as (channels, samples) floats."""
    path = store.stem_path(song_id, stem)
    assert path is not None, f"{stem} was not installed"
    data, _ = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(data.T)


def song_files(store: SongStore, song_id: str) -> list[str]:
    return sorted(path.name for path in store.song_dir(song_id).iterdir())


needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg is not on PATH"
)


def encode_with_ffmpeg(src: Path, dst: Path, *codec: str) -> None:
    """Have the real ffmpeg make `dst` from `src`, for a test of reading it."""
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), *codec]
        + [str(dst)],
        check=True,
        capture_output=True,
        timeout=60,
    )


@dataclass
class FakeSeparator:
    """A loaded separation model that makes known stems and records its use."""

    samplerate: int = STEM_RATE
    # What it reports while it "works", in order.
    progress: tuple[float, ...] = (0.25, 0.5, 0.95)
    error: BaseException | None = None
    load_error: BaseException | None = None
    make: Callable[[int, int], dict[str, Audio]] = known_sources
    loads: list[tuple[str, str]] = field(default_factory=list)
    heard: list[Audio] = field(default_factory=list)
    heard_rates: list[int] = field(default_factory=list)

    def separate(
        self, wav: Audio, samplerate: int, report: Callable[[float], None]
    ) -> dict[str, Audio]:
        self.heard.append(wav.copy())
        self.heard_rates.append(samplerate)
        for value in self.progress:
            report(value)
        if self.error is not None:
            raise self.error
        samples = round(wav.shape[1] * self.samplerate / samplerate)
        return self.make(samples, self.samplerate)


def install_fake_separator(monkeypatch: pytest.MonkeyPatch) -> FakeSeparator:
    """Make the separation step's loader hand out one fake model."""
    fake = FakeSeparator()

    def load(name: str, device: str) -> FakeSeparator:
        fake.loads.append((name, device))
        if fake.load_error is not None:
            raise fake.load_error
        return fake

    monkeypatch.setattr(separation, "load_demucs", load)
    return fake


# --- pitch -------------------------------------------------------------------

# What the fake pitch model hears: a rest, a note, a rest, a higher note.
FAKE_MELODY: tuple[tuple[float | None, float], ...] = (
    (None, 0.2),
    (57.0, 0.5),
    (None, 0.3),
    (64.0, 0.6),
)


@dataclass
class FakePitchTracker:
    """A loaded pitch model that follows `melody` and records its use."""

    melody: tuple[tuple[float | None, float], ...] = FAKE_MELODY
    error: BaseException | None = None
    load_error: BaseException | None = None
    loads: list[tuple[str, str]] = field(default_factory=list)
    # The length in samples and the rate of each audio it was given.
    heard: list[tuple[int, int]] = field(default_factory=list)

    def track(
        self, mono: Audio, samplerate: int, report: Callable[[float], None]
    ) -> tuple[np.ndarray, np.ndarray]:
        self.heard.append((len(mono), samplerate))
        for value in (0.3, 0.6, 1.0):
            report(value)
        if self.error is not None:
            raise self.error
        frames = 1 + len(mono) * 100 // samplerate
        midi = np.full(frames, np.nan)
        at = 0
        for pitch, seconds in self.melody:
            count = round(seconds * 100)
            if pitch is not None:
                midi[at : at + count] = pitch
            at += count
        f0 = melody.midi_to_hz(midi).astype(np.float32)
        confidence = np.where(np.isnan(midi), 0.05, 0.9).astype(np.float32)
        return f0, confidence


def install_fake_pitch_tracker(monkeypatch: pytest.MonkeyPatch) -> FakePitchTracker:
    """Make the reference step's loader hand out one fake pitch model."""
    fake = FakePitchTracker()

    def load(name: str, device: str) -> FakePitchTracker:
        fake.loads.append((name, device))
        if fake.load_error is not None:
            raise fake.load_error
        return fake

    monkeypatch.setattr(reference, "load_crepe", load)
    return fake
