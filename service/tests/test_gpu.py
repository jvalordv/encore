"""Tests for GET /gpu with torch absent, CPU-only, and CUDA-capable.

torch is not installed in CI, so the CPU-only and CUDA cases use a stand-in
module placed in sys.modules; the numbers asserted are the stand-in's. The
models the report lists are whatever the model registry holds, put there with
fakes, as torch plays no part in that list.
"""

import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from encore_service import separation
from encore_service.app import create_app
from encore_service.config import Settings
from tests.fakes import FakeSeparator

GIB = 1024**3


def _client(device: str | None = None) -> TestClient:
    return TestClient(create_app(Settings(device_override=device)))


def _fake_torch(cuda: bool) -> SimpleNamespace:
    return SimpleNamespace(
        cuda=SimpleNamespace(
            is_available=lambda: cuda,
            current_device=lambda: 0,
            get_device_name=lambda index: "Fake RTX 4070 Ti",
            mem_get_info=lambda: (4 * GIB, 12 * GIB),
        )
    )


def test_gpu_without_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    # A None entry makes `import torch` raise ImportError, even if installed.
    monkeypatch.setitem(sys.modules, "torch", None)
    response = _client().get("/gpu")
    assert response.status_code == 200
    assert response.json() == {
        "torch_available": False,
        "cuda_available": False,
        "device": "cpu",
        "device_name": None,
        "vram_total_mb": None,
        "vram_free_mb": None,
        "loaded_models": [],
    }


def test_gpu_with_cpu_only_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(cuda=False))
    body = _client().get("/gpu").json()
    assert body["torch_available"] is True
    assert body["cuda_available"] is False
    assert body["device"] == "cpu"
    assert body["vram_total_mb"] is None


def test_gpu_with_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(cuda=True))
    body = _client().get("/gpu").json()
    assert body["torch_available"] is True
    assert body["cuda_available"] is True
    assert body["device"] == "cuda"
    assert body["device_name"] == "Fake RTX 4070 Ti"
    assert body["vram_total_mb"] == 12 * 1024
    assert body["vram_free_mb"] == 4 * 1024
    assert body["loaded_models"] == []


def test_gpu_reports_the_forced_device(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(cuda=True))
    assert _client(device="cpu").get("/gpu").json()["device"] == "cpu"


def _hold(name: str, device: str) -> None:
    """Put a model in the service's registry, as a separated song would."""
    separation.models.get(name, device, lambda n, d: FakeSeparator())


@pytest.mark.parametrize("torch_state", ["absent", "cpu_only", "cuda"])
def test_gpu_lists_the_models_held_in_memory(
    monkeypatch: pytest.MonkeyPatch, torch_state: str
) -> None:
    if torch_state == "absent":
        monkeypatch.setitem(sys.modules, "torch", None)
    else:
        monkeypatch.setitem(
            sys.modules, "torch", _fake_torch(cuda=torch_state == "cuda")
        )
    _hold("htdemucs_ft", "cuda")
    _hold("htdemucs", "cpu")

    body = _client().get("/gpu").json()

    # In name order, whatever torch can or cannot do: it is the registry's list.
    assert body["loaded_models"] == ["demucs:htdemucs@cpu", "demucs:htdemucs_ft@cuda"]


def test_gpu_lists_a_model_the_moment_it_has_loaded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)
    client = _client()
    assert client.get("/gpu").json()["loaded_models"] == []

    _hold("htdemucs_ft", "cuda")

    assert client.get("/gpu").json()["loaded_models"] == ["demucs:htdemucs_ft@cuda"]
