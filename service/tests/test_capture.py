"""HTTP tests for the capture upload, `POST /songs/url/{video_id}/capture`.

A synthetic WAV stands in for the recorded tab audio. The app runs its real
lifespan over a temporary cache, as in test_songs.py; the step runners are
emptied by conftest, so what is checked is intake, storage and the status.
"""

import io
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from encore_service.app import create_app
from encore_service.config import Settings
from encore_service.pipeline import initial_status
from encore_service.store import SongMeta, SongStore

VIDEO_ID = "dQw4w9WgXcQ"
RATE = 48_000
WAIT_S = 10.0


def make_wav(seconds: float = 0.5) -> bytes:
    t = np.arange(int(seconds * RATE)) / RATE
    buffer = io.BytesIO()
    sf.write(buffer, 0.3 * np.sin(2 * np.pi * 440 * t), RATE, format="WAV")
    return buffer.getvalue()


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        yield client


def capture(
    client: TestClient,
    video_id: str = VIDEO_ID,
    body: bytes | None = None,
    title: str | None = "A title",
):
    data = {"title": title} if title is not None else {}
    return client.post(
        f"/songs/url/{video_id}/capture",
        files={"audio": ("capture.wav", body or make_wav(), "audio/wav")},
        data=data,
    )


def test_a_capture_becomes_the_song_and_skips_the_download(
    client: TestClient, tmp_path: Path
) -> None:
    response = capture(client)

    assert response.status_code == 200
    body = response.json()
    assert body["song_id"] == f"yt-{VIDEO_ID}"
    assert body["source"] == "youtube"
    assert body["audio_source"] == "capture"
    assert body["alongside"] is False
    assert body["title"] == "A title"
    assert body["duration_s"] == pytest.approx(0.5, abs=0.01)
    assert body["steps"]["fetch"]["state"] == "done"
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)
    status = client.get(f"/songs/yt-{VIDEO_ID}").json()
    assert status["audio_source"] == "capture"
    assert (tmp_path / f"yt-{VIDEO_ID}" / "source.wav").is_file()
    assert client.get(f"/songs/yt-{VIDEO_ID}/audio").status_code == 200


def test_a_default_title_names_the_video(client: TestClient) -> None:
    body = capture(client, title=None).json()

    assert body["title"] == f"YouTube video {VIDEO_ID}"


def _make_download(client: TestClient, tmp_path: Path) -> Path:
    store: SongStore = client.app.state.store
    song_id = f"yt-{VIDEO_ID}"
    meta = SongMeta(source="youtube", video_id=VIDEO_ID, title="x")
    store.song_dir(song_id).mkdir()
    store.write_meta(song_id, meta)
    store.write_status(song_id, initial_status(song_id, meta))
    source = store.song_dir(song_id) / "source.wav"
    source.write_bytes(make_wav())
    store.set_audio_source(song_id, "download")
    return source


def test_a_download_keeps_its_audio_and_the_capture_is_stored_beside_it(
    client: TestClient, tmp_path: Path
) -> None:
    source = _make_download(client, tmp_path)
    before = source.read_bytes()

    body = capture(client, body=make_wav(0.7)).json()

    assert body["alongside"] is True
    assert "stays the source" in body["message"]
    assert source.read_bytes() == before
    assert (tmp_path / f"yt-{VIDEO_ID}" / "capture.wav").is_file()
    assert client.get(f"/songs/yt-{VIDEO_ID}").json()["audio_source"] == "download"


def test_a_second_capture_replaces_the_first_and_clears_what_it_made(
    client: TestClient, tmp_path: Path
) -> None:
    capture(client)
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)
    song_dir = tmp_path / f"yt-{VIDEO_ID}"
    stale = [
        song_dir / "vocals.flac",
        song_dir / "key.json",
        song_dir / "reference.json",
    ]
    for path in stale:
        path.write_bytes(b"old")
    before = (song_dir / "source.wav").read_bytes()

    second = capture(client, body=make_wav(0.7)).json()

    assert second["alongside"] is False
    assert second["audio_source"] == "capture"
    assert (song_dir / "source.wav").read_bytes() != before
    assert not (song_dir / "capture.wav").exists()
    assert second["duration_s"] == pytest.approx(0.7, abs=0.01)
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)
    for path in stale:
        assert not path.exists()


def test_the_download_records_its_origin_in_the_status(
    client: TestClient,
) -> None:
    store: SongStore = client.app.state.store
    song_id = "yt-aaaaaaaaaaa"
    meta = SongMeta(source="youtube", video_id="aaaaaaaaaaa", title="x")
    store.song_dir(song_id).mkdir()
    store.write_meta(song_id, meta)
    store.write_status(song_id, initial_status(song_id, meta))
    store.set_audio_source(song_id, "download")

    assert client.get(f"/songs/{song_id}").json()["audio_source"] == "download"


@pytest.mark.parametrize("video_id", ["short", "has space!!", "videoseries!"])
def test_a_bad_video_id_is_422(client: TestClient, video_id: str) -> None:
    assert capture(client, video_id=video_id).status_code == 422


def test_audio_that_is_not_wav_is_422_and_leaves_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    response = capture(client, body=b"this is not audio at all" * 50)

    assert response.status_code == 422
    assert not (tmp_path / f"yt-{VIDEO_ID}").exists()
    assert list((tmp_path / ".incoming").iterdir()) == []


def test_an_empty_upload_is_400(client: TestClient) -> None:
    response = client.post(
        f"/songs/url/{VIDEO_ID}/capture",
        files={"audio": ("capture.wav", b"", "audio/wav")},
    )

    assert response.status_code == 400


def test_a_capture_over_the_length_limit_is_422(tmp_path: Path) -> None:
    app = create_app(Settings(cache_dir=tmp_path, max_song_s=1))
    with TestClient(app) as client:
        response = capture(client, body=make_wav(3.0))

    assert response.status_code == 422
    assert "limit" in response.json()["detail"]
