"""The stub routes answer 501 and name the ROADMAP task that fills them in."""

import pytest
from fastapi.testclient import TestClient

from encore_service.app import create_app
from encore_service.config import Settings

WAV = ("take.wav", b"RIFF", "audio/wav")


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(Settings()))


def test_create_song_is_a_stub(client: TestClient) -> None:
    response = client.post("/songs", files={"file": ("a.mp3", b"x", "audio/mpeg")})
    assert response.status_code == 501
    assert "P2-T1" in response.json()["detail"]


def test_get_song_is_a_stub(client: TestClient) -> None:
    response = client.get("/songs/abc")
    assert response.status_code == 501
    assert "P2-T1" in response.json()["detail"]


def test_analyze_is_a_stub(client: TestClient) -> None:
    response = client.post("/analyze", files={"take": WAV}, data={"song_id": "abc"})
    assert response.status_code == 501
    assert "P3-T1" in response.json()["detail"]


def test_duet_enroll_is_a_stub(client: TestClient) -> None:
    response = client.post(
        "/duet/enroll", files={"audio": WAV}, data={"singer_id": "a"}
    )
    assert response.status_code == 501
    assert "P4-T2" in response.json()["detail"]


def test_duet_split_is_a_stub(client: TestClient) -> None:
    response = client.post(
        "/duet/split",
        files={"take": WAV},
        data={"song_id": "abc", "singer_ids": ["a", "b"]},
    )
    assert response.status_code == 501
    assert "P4-T4" in response.json()["detail"]


def test_openapi_documents_the_contract(client: TestClient) -> None:
    schemas = client.get("/openapi.json").json()["components"]["schemas"]
    for name in ("SongStatus", "TakeAnalysis", "DuetSplit", "Contour", "Features"):
        assert name in schemas
