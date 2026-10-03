"""Tests for GET /health and the CORS wiring around it."""

from fastapi.testclient import TestClient

from encore_service import __version__
from encore_service.app import create_app
from encore_service.config import Settings


def test_health_reports_ok_and_version() -> None:
    client = TestClient(create_app(Settings()))
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__}


def test_cors_allows_the_dev_server_origin() -> None:
    client = TestClient(create_app(Settings()))
    response = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_cors_ignores_other_origins() -> None:
    client = TestClient(create_app(Settings()))
    response = client.get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in response.headers
