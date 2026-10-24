"""Fixtures shared by the service tests.

`store` is a song cache in a temporary folder. `new_song` and `new_link` put a
song in it the way the routes do, so store and pipeline tests start from real
cache contents rather than hand-built folders. Every test also runs with the
step registry emptied (see `no_runners`).
"""

import hashlib
from collections.abc import Callable
from pathlib import Path

import pytest

from encore_service import pipeline
from encore_service.pipeline import initial_status
from encore_service.store import SongMeta, SongStore


@pytest.fixture(autouse=True)
def no_runners(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start each test with no step runners registered.

    Without this, a test that adds a song would start running real models as
    soon as their runners exist. A test that needs a step registers a fake
    for it with `monkeypatch.setitem(pipeline.RUNNERS, ...)`.
    """
    for step in pipeline.RUNNERS:
        monkeypatch.setitem(pipeline.RUNNERS, step, None)


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
