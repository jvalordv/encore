"""HTTP tests for GET /songs: the list the browser's Library reads."""

import io
import os
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from encore_service.app import create_app
from encore_service.config import Settings

RATE = 48_000
WAIT_S = 10.0


def make_wav(hz: float) -> bytes:
    t = np.arange(RATE // 2) / RATE
    buffer = io.BytesIO()
    sf.write(buffer, 0.3 * np.sin(2 * np.pi * hz * t), RATE, format="WAV")
    return buffer.getvalue()


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        yield client


def upload(client: TestClient, name: str, hz: float) -> str:
    response = client.post("/songs", files={"file": (name, make_wav(hz), "audio/wav")})
    assert response.status_code == 200
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)
    return str(response.json()["song_id"])


def test_an_empty_store_lists_nothing(client: TestClient) -> None:
    response = client.get("/songs")

    assert response.status_code == 200
    assert response.json() == []


def test_the_list_names_each_song_and_what_is_done(client: TestClient) -> None:
    song_id = upload(client, "first tone.wav", 440.0)

    (row,) = client.get("/songs").json()

    assert row["id"] == song_id
    assert row["name"] == "first tone"
    assert row["source"] == "file"
    assert row["duration_s"] == pytest.approx(0.5, abs=1e-3)
    assert row["has_audio"] is True
    assert row["updated_at"] > 0


def test_a_finished_step_is_listed_as_done(client: TestClient) -> None:
    song_id = upload(client, "tone.wav", 440.0)
    client.app.state.store.update_step(song_id, "key", state="done", progress=1.0)

    (row,) = client.get("/songs").json()

    assert "key" in row["steps_done"]
    assert "lyrics" not in row["steps_done"]


def test_the_newest_song_comes_first(client: TestClient, tmp_path: Path) -> None:
    older = upload(client, "older.wav", 330.0)
    newer = upload(client, "newer.wav", 550.0)
    # Set the clock by hand: two writes can share a timestamp.
    os.utime(tmp_path / older / "status.json", (1_000_000, 1_000_000))
    os.utime(tmp_path / newer / "status.json", (2_000_000, 2_000_000))

    ids = [row["id"] for row in client.get("/songs").json()]

    assert ids == [newer, older]


def test_a_folder_without_a_status_is_not_a_song(
    client: TestClient, tmp_path: Path
) -> None:
    (tmp_path / ("a" * 64)).mkdir()

    assert client.get("/songs").json() == []
