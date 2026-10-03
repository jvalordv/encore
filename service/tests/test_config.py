"""Tests for environment-driven settings."""

import sys
from pathlib import Path

import pytest

from encore_service.config import DEFAULT_CACHE_DIR, DEFAULT_ORIGINS, Settings


def test_defaults() -> None:
    settings = Settings.from_env({})
    assert settings.port == 8765
    assert settings.cache_dir == DEFAULT_CACHE_DIR
    assert settings.cache_dir.name == "cache"
    assert settings.allowed_origins == DEFAULT_ORIGINS
    assert "http://localhost:5173" in settings.allowed_origins
    assert "http://127.0.0.1:5173" in settings.allowed_origins


def test_overrides_are_read() -> None:
    settings = Settings.from_env(
        {
            "ENCORE_DEVICE": "CPU",
            "ENCORE_CACHE_DIR": "/data/encore",
            "ENCORE_PORT": "9000",
            "ENCORE_ALLOWED_ORIGINS": "http://a.test, http://b.test,",
        }
    )
    assert settings.device == "cpu"
    assert settings.cache_dir == Path("/data/encore")
    assert settings.port == 9000
    assert settings.allowed_origins == ("http://a.test", "http://b.test")


def test_bad_port_is_a_clear_error() -> None:
    with pytest.raises(ValueError, match="ENCORE_PORT"):
        Settings.from_env({"ENCORE_PORT": "eight"})


def test_device_falls_back_to_cpu_without_torch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)
    assert Settings.from_env({}).device == "cpu"
