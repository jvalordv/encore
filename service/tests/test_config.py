"""Tests for environment-driven settings."""

import sys
from pathlib import Path

import pytest

from encore_service.config import (
    DEFAULT_CACHE_DIR,
    DEFAULT_MAX_SONG_S,
    DEFAULT_ORIGINS,
    Settings,
)


def test_defaults() -> None:
    settings = Settings.from_env({})
    assert settings.port == 8765
    assert settings.cache_dir == DEFAULT_CACHE_DIR
    assert settings.cache_dir.name == "cache"
    assert settings.allowed_origins == DEFAULT_ORIGINS
    assert "http://localhost:5173" in settings.allowed_origins
    assert "http://127.0.0.1:5173" in settings.allowed_origins
    assert settings.max_song_s == DEFAULT_MAX_SONG_S == 900


def test_overrides_are_read() -> None:
    settings = Settings.from_env(
        {
            "ENCORE_DEVICE": "CPU",
            "ENCORE_CACHE_DIR": "/data/encore",
            "ENCORE_PORT": "9000",
            "ENCORE_ALLOWED_ORIGINS": "http://a.test, http://b.test,",
            "ENCORE_MAX_SONG_S": "1200",
        }
    )
    assert settings.device == "cpu"
    assert settings.cache_dir == Path("/data/encore")
    assert settings.port == 9000
    assert settings.allowed_origins == ("http://a.test", "http://b.test")
    assert settings.max_song_s == 1200


def test_bad_port_is_a_clear_error() -> None:
    with pytest.raises(ValueError, match="ENCORE_PORT"):
        Settings.from_env({"ENCORE_PORT": "eight"})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("1", 1), ("900", 900), (" 600 ", 600), ("86400", 86400), ("", 900), ("  ", 900)],
)
def test_max_song_s_is_a_positive_integer(raw: str, expected: int) -> None:
    assert Settings.from_env({"ENCORE_MAX_SONG_S": raw}).max_song_s == expected


@pytest.mark.parametrize(
    "raw", ["0", "-1", "-900", "abc", "9.5", "15 min", "1e3", "--"]
)
def test_bad_max_song_s_is_a_clear_error_that_quotes_the_value(raw: str) -> None:
    with pytest.raises(ValueError, match="ENCORE_MAX_SONG_S") as raised:
        Settings.from_env({"ENCORE_MAX_SONG_S": raw})
    assert repr(raw.strip()) in str(raised.value)
    assert "positive integer" in str(raised.value)


def test_device_falls_back_to_cpu_without_torch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)
    assert Settings.from_env({}).device == "cpu"
