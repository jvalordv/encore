"""HTTP tests for GET /songs/{id}/stems/{stem}: the vocal and the backing.

A song is added through the real routes and its stems are put in its folder as
the separation step leaves them, so these tests are about what the route
serves and refuses, not about how a stem is made (see test_separation.py).
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from encore_service.app import create_app
from encore_service.config import Settings
from encore_service.routes.songs import STEM_GAIN_HEADER
from encore_service.separation import write_flac
from tests.fakes import STEM_RATE, known_sources, stereo_tone, wav_bytes

OTHER_SONG = "0" * 64


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        yield client


@pytest.fixture
def song_id(client: TestClient) -> str:
    """A song added through the route, with no runner to prepare it."""
    files = {"file": ("tone.wav", wav_bytes(stereo_tone()), "audio/wav")}
    song_id = client.post("/songs", files=files).json()["song_id"]
    assert client.app.state.jobs.wait_idle(timeout=10.0)
    return song_id


def put_stem(tmp_path: Path, song_id: str, stem: str) -> bytes:
    """Leave a stem in the song's folder as the step does; returns its bytes."""
    path = tmp_path / song_id / f"{stem}.flac"
    write_flac(path, known_sources(STEM_RATE, STEM_RATE)["vocals"], STEM_RATE)
    return path.read_bytes()


@pytest.mark.parametrize("stem", ["vocals", "no_vocals"])
def test_a_stem_is_served_as_flac(
    client: TestClient, tmp_path: Path, song_id: str, stem: str
) -> None:
    data = put_stem(tmp_path, song_id, stem)

    response = client.get(f"/songs/{song_id}/stems/{stem}")

    assert response.status_code == 200
    assert response.content == data
    assert response.content[:4] == b"fLaC"
    assert response.headers["content-type"] == "audio/flac"


def test_each_stem_is_its_own_file(
    client: TestClient, tmp_path: Path, song_id: str
) -> None:
    (tmp_path / song_id / "vocals.flac").write_bytes(b"fLaC the voice")
    (tmp_path / song_id / "no_vocals.flac").write_bytes(b"fLaC the backing")

    assert client.get(f"/songs/{song_id}/stems/vocals").content == b"fLaC the voice"
    assert client.get(f"/songs/{song_id}/stems/no_vocals").content == (
        b"fLaC the backing"
    )


def test_stems_support_range_requests_for_seeking(
    client: TestClient, tmp_path: Path, song_id: str
) -> None:
    data = put_stem(tmp_path, song_id, "vocals")

    response = client.get(
        f"/songs/{song_id}/stems/vocals", headers={"Range": "bytes=0-9"}
    )

    assert response.status_code == 206
    assert response.content == data[:10]
    assert response.headers["accept-ranges"] == "bytes"


@pytest.mark.parametrize("stem", ["vocals", "no_vocals"])
def test_a_stem_carries_the_gain_the_stems_were_scaled_by(
    client: TestClient, tmp_path: Path, song_id: str, stem: str
) -> None:
    put_stem(tmp_path, song_id, stem)
    client.app.state.store.set_stem_gain(song_id, 0.8123456789)

    response = client.get(f"/songs/{song_id}/stems/{stem}")

    # Exactly what meta.json holds, so the original can be scaled to match.
    assert response.headers[STEM_GAIN_HEADER] == "0.8123456789"
    assert float(response.headers[STEM_GAIN_HEADER]) == 0.8123456789


def test_the_gain_of_stems_that_were_not_scaled_is_one(
    client: TestClient, tmp_path: Path, song_id: str
) -> None:
    put_stem(tmp_path, song_id, "vocals")

    response = client.get(f"/songs/{song_id}/stems/vocals")

    assert float(response.headers[STEM_GAIN_HEADER]) == 1.0


def test_the_gain_is_one_when_the_songs_meta_cannot_be_read(
    client: TestClient, tmp_path: Path, song_id: str
) -> None:
    put_stem(tmp_path, song_id, "vocals")
    (tmp_path / song_id / "meta.json").write_text("{ not json", encoding="utf-8")

    response = client.get(f"/songs/{song_id}/stems/vocals")

    assert response.status_code == 200
    assert float(response.headers[STEM_GAIN_HEADER]) == 1.0


def test_a_range_request_for_a_stem_carries_the_gain_too(
    client: TestClient, tmp_path: Path, song_id: str
) -> None:
    put_stem(tmp_path, song_id, "vocals")
    client.app.state.store.set_stem_gain(song_id, 0.5)

    response = client.get(
        f"/songs/{song_id}/stems/vocals", headers={"Range": "bytes=0-9"}
    )

    assert response.status_code == 206
    assert float(response.headers[STEM_GAIN_HEADER]) == 0.5


def test_a_page_on_the_apps_origin_may_read_the_gain(
    client: TestClient, tmp_path: Path, song_id: str
) -> None:
    put_stem(tmp_path, song_id, "vocals")

    response = client.get(
        f"/songs/{song_id}/stems/vocals", headers={"Origin": "http://localhost:5173"}
    )

    # Without this a script on another origin sees no custom header at all.
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    exposed = response.headers["access-control-expose-headers"]
    assert STEM_GAIN_HEADER in [name.strip() for name in exposed.split(",")]


@pytest.mark.parametrize("stem", ["vocals", "no_vocals"])
def test_a_stem_that_is_not_there_yet_is_409(
    client: TestClient, song_id: str, stem: str
) -> None:
    response = client.get(f"/songs/{song_id}/stems/{stem}")

    assert response.status_code == 409
    assert response.json() == {"detail": "Song not separated yet."}


def test_one_stem_being_there_does_not_make_the_other_so(
    client: TestClient, tmp_path: Path, song_id: str
) -> None:
    put_stem(tmp_path, song_id, "vocals")

    assert client.get(f"/songs/{song_id}/stems/vocals").status_code == 200
    assert client.get(f"/songs/{song_id}/stems/no_vocals").status_code == 409


def test_a_half_written_stem_is_not_served(
    client: TestClient, tmp_path: Path, song_id: str
) -> None:
    # The step writes aside and moves in whole; this is where it writes aside.
    scratch = tmp_path / song_id / ".separate"
    scratch.mkdir()
    (scratch / "vocals.flac").write_bytes(b"fLaC half")
    (tmp_path / song_id / "vocals.flac.part").write_bytes(b"fLaC half")

    assert client.get(f"/songs/{song_id}/stems/vocals").status_code == 409


def test_an_unknown_song_is_404_whatever_the_stem(client: TestClient) -> None:
    for stem in ("vocals", "no_vocals", "drums"):
        response = client.get(f"/songs/{OTHER_SONG}/stems/{stem}")
        assert response.status_code == 404
        assert response.json() == {"detail": "No such song."}
    assert client.get("/songs/yt-dQw4w9WgXcQ/stems/vocals").status_code == 404


@pytest.mark.parametrize(
    "bad_id", ["not-an-id", "A" * 64, "0" * 63, "0" * 64 + "%0A", "yt-short"]
)
def test_a_malformed_song_id_is_404_like_an_unknown_one(
    client: TestClient, bad_id: str
) -> None:
    unknown = client.get(f"/songs/{OTHER_SONG}/stems/vocals")

    response = client.get(f"/songs/{bad_id}/stems/vocals")

    assert (response.status_code, response.json()) == (404, unknown.json())


@pytest.mark.parametrize("bad_id", ["..", "%2E%2E", "..%2F..", "%2E%2E%5C%2E%2E"])
def test_a_song_id_that_climbs_out_of_the_cache_is_404(
    client: TestClient, bad_id: str
) -> None:
    # Some of these are settled by the client or the router before the route
    # runs; none may reach a file.
    assert client.get(f"/songs/{bad_id}/stems/vocals").status_code == 404


@pytest.mark.parametrize(
    "stem",
    [
        "drums",
        "bass",
        "other",
        "source",
        "VOCALS",
        "vocals.flac",
        "no-vocals",
        "status.json",
        "meta.json",
        "%2e%2e",
        "vocals%00",
        "vocals%0A",
    ],
)
def test_a_name_that_is_not_a_stem_is_404_even_if_a_file_has_that_name(
    client: TestClient, tmp_path: Path, song_id: str, stem: str
) -> None:
    put_stem(tmp_path, song_id, "vocals")
    put_stem(tmp_path, song_id, "no_vocals")

    response = client.get(f"/songs/{song_id}/stems/{stem}")

    assert response.status_code == 404
    assert response.json() == {"detail": "No such stem."}


@pytest.mark.parametrize(
    "path",
    ["../source.wav", "..%2Fsource.wav", "..%5Csource.wav", "%2e%2e/source.wav"],
)
def test_a_stem_name_cannot_reach_other_files_of_the_song(
    client: TestClient, tmp_path: Path, song_id: str, path: str
) -> None:
    put_stem(tmp_path, song_id, "vocals")

    response = client.get(f"/songs/{song_id}/stems/{path}")

    assert response.status_code == 404
    # Whatever answered, it was not the song's audio.
    assert response.content[:4] not in (b"RIFF", b"fLaC")


def test_openapi_describes_the_stems_route(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()

    operation = spec["paths"]["/songs/{song_id}/stems/{stem}"]["get"]
    assert {"200", "404", "409"} <= set(operation["responses"])
