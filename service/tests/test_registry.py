"""Tests for the model registry: load once, keep, list by family.

The registry is bookkeeping, so these use plain objects as models. What
`GET /gpu` makes of the listing is in `test_gpu.py`.
"""

import threading

import pytest

from encore_service.registry import ModelRegistry
from tests.fakes import FakeSeparator

# Long enough for a thread to reach a lock on a loaded machine, and short
# enough that a hang fails the test rather than stalling the run.
WAIT_S = 10.0


def test_a_model_is_loaded_once_per_name_and_device() -> None:
    registry = ModelRegistry()
    loads: list[tuple[str, str]] = []

    def load(name: str, device: str) -> FakeSeparator:
        loads.append((name, device))
        return FakeSeparator()

    first = registry.get("demucs", "htdemucs_ft", "cuda", load)
    again = registry.get("demucs", "htdemucs_ft", "cuda", load)
    other_device = registry.get("demucs", "htdemucs_ft", "cpu", load)
    other_model = registry.get("demucs", "htdemucs", "cuda", load)

    assert again is first
    assert other_device is not first and other_model is not first
    assert loads == [
        ("htdemucs_ft", "cuda"),
        ("htdemucs_ft", "cpu"),
        ("htdemucs", "cuda"),
    ]


def test_the_registry_lists_what_it_holds_by_family_name_and_device() -> None:
    registry = ModelRegistry()
    assert registry.loaded() == []

    registry.get("demucs", "htdemucs_ft", "cuda", lambda name, device: FakeSeparator())
    registry.get("demucs", "htdemucs", "cpu", lambda name, device: FakeSeparator())

    assert registry.loaded() == ["demucs:htdemucs@cpu", "demucs:htdemucs_ft@cuda"]


def test_a_load_that_fails_is_not_kept_and_can_be_tried_again() -> None:
    registry = ModelRegistry()

    def refuse(name: str, device: str) -> FakeSeparator:
        raise OSError("no network")

    with pytest.raises(OSError, match="no network"):
        registry.get("demucs", "htdemucs_ft", "cuda", refuse)
    assert registry.loaded() == []

    model = FakeSeparator()
    assert registry.get("demucs", "htdemucs_ft", "cuda", lambda n, d: model) is model


def test_two_requests_for_a_model_at_once_load_it_once() -> None:
    registry = ModelRegistry()
    loading, release = threading.Event(), threading.Event()
    loads: list[str] = []

    def slow_load(name: str, device: str) -> FakeSeparator:
        loads.append(name)
        loading.set()
        assert release.wait(WAIT_S)
        return FakeSeparator()

    results: list[object] = []
    threads = [
        threading.Thread(
            target=lambda: results.append(registry.get("demucs", "m", "cpu", slow_load))
        )
        for _ in range(2)
    ]
    threads[0].start()
    assert loading.wait(WAIT_S)
    threads[1].start()
    release.set()
    for thread in threads:
        thread.join(WAIT_S)

    assert loads == ["m"]
    assert len(results) == 2 and results[0] is results[1]


def test_listing_the_models_does_not_wait_for_a_load_in_progress() -> None:
    registry = ModelRegistry()
    registry.get("demucs", "held", "cpu", lambda name, device: FakeSeparator())
    loading, release = threading.Event(), threading.Event()

    def slow_load(name: str, device: str) -> FakeSeparator:
        loading.set()
        assert release.wait(WAIT_S)
        return FakeSeparator()

    thread = threading.Thread(
        target=lambda: registry.get("demucs", "slow", "cpu", slow_load)
    )
    thread.start()
    try:
        assert loading.wait(WAIT_S)
        # A first use may download for minutes; GET /gpu must still answer.
        assert registry.loaded() == ["demucs:held@cpu"]
    finally:
        release.set()
        thread.join(WAIT_S)
    assert registry.loaded() == ["demucs:held@cpu", "demucs:slow@cpu"]


def test_the_same_name_in_two_families_is_two_models() -> None:
    registry = ModelRegistry()

    registry.get("demucs", "full", "cuda", lambda name, device: FakeSeparator())
    registry.get("crepe", "full", "cuda", lambda name, device: object())

    assert registry.loaded() == ["crepe:full@cuda", "demucs:full@cuda"]
