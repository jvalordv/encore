"""Fixtures shared by the service tests.

`store` is a song cache in a temporary folder. `new_song` and `new_link` put a
song in it the way the routes do, so store and pipeline tests start from real
cache contents rather than hand-built folders. Every test also runs with the
step registry emptied (see `no_runners`) and with yt-dlp out of reach (see
`no_unfaked_yt_dlp`). `ydl`, `fakes` and `node_only` keep the YouTube code
away from the network, ffmpeg and whatever this machine has on PATH.
"""

import hashlib
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from encore_service import pipeline, youtube
from encore_service.pipeline import initial_status
from encore_service.store import SongMeta, SongStore
from tests.fakes import FetchFakes, Ydl, install_fake_fetch, install_fake_ydl

UNFAKED = (
    "A test reached yt-dlp without a fake. Use the `ydl` fixture, or replace "
    "youtube.lookup or the fetch calls (see tests/fakes.py)."
)


@pytest.fixture(autouse=True)
def no_runners(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start each test with no step runners registered.

    Without this, a test that adds a song would start running real models as
    soon as their runners exist. A test that needs a step registers a fake
    for it with `monkeypatch.setitem(pipeline.RUNNERS, ...)`.
    """
    for step in pipeline.RUNNERS:
        monkeypatch.setitem(pipeline.RUNNERS, step, None)


@pytest.fixture(autouse=True)
def no_unfaked_yt_dlp(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Fail a test that reaches yt-dlp without a fake, so none touches YouTube.

    `lookup` and `download_audio` both build `youtube.yt_dlp.YoutubeDL`, so
    replacing that class closes every way to YouTube. The attempt is also
    remembered and fails the test afterwards: both functions turn any error
    into a YtDlpError, which a route turns into a 502, and a test that expects
    a 502 would otherwise pass for the wrong reason. The `ydl` fixture runs
    after this one and puts its fake in the class's place. Yields the list of
    attempts, which only the test of this guard needs.
    """
    reached: list[str] = []

    class Unfaked:
        def __init__(self, *args: object, **kwargs: object) -> None:
            reached.append(UNFAKED)
            raise AssertionError(UNFAKED)

    monkeypatch.setattr(youtube.yt_dlp, "YoutubeDL", Unfaked)
    yield reached
    assert not reached, UNFAKED


@pytest.fixture
def store(tmp_path: Path) -> SongStore:
    """A song store over an empty temporary cache."""
    return SongStore(tmp_path)


@pytest.fixture
def new_song(store: SongStore) -> Callable[..., str]:
    """Factory: cache an uploaded song; its bytes decide its id."""

    def make(data: bytes = b"audio", ext: str = ".wav") -> str:
        song_id = hashlib.sha256(data).hexdigest()
        part = store.incoming_path()
        part.write_bytes(data)
        meta = SongMeta(source="file", title="song", duration_s=1.5)
        store.add_upload(song_id, part, ext, meta, initial_status(song_id, meta))
        return song_id

    return make


@pytest.fixture
def new_link(store: SongStore) -> Callable[..., str]:
    """Factory: cache a linked song whose audio has not been fetched yet."""

    def make(video_id: str = "dQw4w9WgXcQ") -> str:
        song_id = f"yt-{video_id}"
        meta = SongMeta(
            source="youtube",
            title="Linked",
            url=f"https://youtu.be/{video_id}",
            duration_s=200.0,
            video_id=video_id,
        )
        store.song_dir(song_id).mkdir()
        store.write_meta(song_id, meta)
        store.write_status(song_id, initial_status(song_id, meta))
        return song_id

    return make


@pytest.fixture
def ydl(monkeypatch: pytest.MonkeyPatch) -> Ydl:
    """A fake yt_dlp.YoutubeDL that records what it is given."""
    return install_fake_ydl(monkeypatch)


@pytest.fixture
def node_only(monkeypatch: pytest.MonkeyPatch) -> dict[str, dict[str, str]]:
    """Pretend Node is the one JavaScript runtime on PATH, whatever is there."""
    runtimes = {"node": {"path": "/opt/node/node"}}
    monkeypatch.setattr(youtube, "js_runtimes", lambda: runtimes)
    return runtimes


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch) -> FetchFakes:
    """Fake download and conversion for the fetch step; see tests/fakes.py."""
    return install_fake_fetch(monkeypatch)
