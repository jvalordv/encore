"""Fakes shared by the service tests.

`Ydl` stands in for `yt_dlp.YoutubeDL` wherever a test would otherwise reach
YouTube: it records the options and URLs it is given and answers from fields
the test sets. `FetchFakes` replaces the two calls the fetch step makes
(`youtube.download_audio` and `youtube.to_flac`), so a test can run that step
without a network or ffmpeg; its conversion writes a real FLAC. The `ydl` and
`fakes` fixtures in `conftest.py` install them.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
import yt_dlp

from encore_service import youtube
from encore_service.config import Settings

# The class itself, taken when the tests are collected, before any fixture has
# replaced it. A test that proves something about yt-dlp uses this one.
REAL_YOUTUBE_DL = yt_dlp.YoutubeDL

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
