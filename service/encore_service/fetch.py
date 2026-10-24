"""The fetch step: bring a linked song's audio into its cache folder.

`fetch_source` is the runner registered for the `fetch` step in `pipeline.py`.
It downloads the video's best audio stream with yt-dlp into a scratch folder
inside the song's own folder, has ffmpeg write that as FLAC, and moves the
result into place as `source.flac` in one step, so a song never has a
half-written file under a name the audio route serves. Whatever goes wrong the
scratch folder is removed and the step fails with a message that says what
failed and why. See "Song sources" in docs/ARCHITECTURE.md.
"""

import shutil
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import TypeVar

import soundfile as sf

from encore_service import youtube
from encore_service.config import Settings
from encore_service.store import SongStore

ResultT = TypeVar("ResultT")

# Inside the song's folder, so the finished file moves into place on the same
# volume and the move is atomic.
WORK_DIR = ".fetch"
SOURCE_EXT = ".flac"
# Progress once the conversion is done; the download filled the part before it
# (youtube.DOWNLOAD_SHARE) and saving the file takes the rest.
CONVERTED = 0.95


class FetchError(RuntimeError):
    """The fetch step failed; the message says what failed and why."""


def fetch_source(store: SongStore, song_id: str, report: youtube.Report) -> None:
    """Download, convert and install a linked song's audio.

    Raises FetchError, reading "<what failed>: <why>", on any failure, with
    the scratch folder gone and no `source.*` left under a served name.
    """
    meta = store.read_meta(song_id)
    if meta is None or meta.video_id is None:
        raise FetchError("This song has no YouTube video to fetch.")
    video_id = meta.video_id
    settings = Settings.from_env()
    work = store.song_dir(song_id) / WORK_DIR
    converted = work / f"source{SOURCE_EXT}"
    try:
        _attempt("Preparing the download folder", partial(_fresh_dir, work))
        downloaded = _attempt(
            "Downloading from YouTube",
            partial(youtube.download_audio, video_id, work, report, settings),
        )
        _attempt(
            "Converting the download to FLAC",
            partial(youtube.to_flac, downloaded, converted),
        )
        report(CONVERTED)
        # Measured before the move, so a file that cannot be read never gets
        # as far as a name the audio route serves.
        duration_s = _attempt(
            "Reading the converted audio", partial(_duration_s, converted)
        )
        _attempt(
            "Saving the audio",
            partial(_install, store, song_id, converted, duration_s),
        )
        report(1.0)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _attempt(what: str, action: Callable[[], ResultT]) -> ResultT:
    """Run `action`; a failure becomes FetchError("<what> failed: <why>")."""
    try:
        return action()
    except youtube.YtDlpError as exc:
        raise FetchError(youtube.describe_failure(f"{what} failed", exc)) from exc
    except Exception as exc:
        raise FetchError(f"{what} failed: {str(exc) or type(exc).__name__}") from exc


def _fresh_dir(path: Path) -> None:
    """Make `path` an empty folder, clearing what a crashed fetch left in it."""
    if path.exists():
        shutil.rmtree(path)
    path.mkdir()


def _duration_s(path: Path) -> float:
    """Length of the audio file in seconds, as libsndfile reads it."""
    return float(sf.info(str(path)).duration)


def _install(store: SongStore, song_id: str, path: Path, duration_s: float) -> None:
    """Move the finished file into place and record the length it really has."""
    store.install_source(song_id, path, SOURCE_EXT)
    store.set_duration(song_id, duration_s)
