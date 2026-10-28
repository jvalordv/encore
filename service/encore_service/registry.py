"""The models the service holds in memory, one registry for every family.

Loading a model is slow (a first use may download weights, and the model then
takes GPU memory), so each step that needs one asks this registry, which loads
it on first use and keeps it. A model is identified by its family (`demucs`
for vocal separation, `crepe` for pitch tracking), its name and the device it
sits on, and `GET /gpu` lists the held ones as `family:name@device`. The
registry is plain bookkeeping: it imports no torch, and it does not look at
what it holds, so a step's loader decides what a model is. The service has one
registry, `models`; tests put a fresh one in its place, so code reaches it as
`registry.models` at the time of use, never by importing the name.
"""

import threading
from collections.abc import Callable
from typing import TypeVar, cast

ModelT = TypeVar("ModelT")


class ModelRegistry:
    """The models held in memory, one per (family, name, device)."""

    def __init__(self) -> None:
        # Loading is slow (a first use downloads weights), so loads are
        # serialised by one lock and the dictionary has another. Asking which
        # models are loaded then never waits for a download to finish.
        self._load_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._models: dict[tuple[str, str, str], object] = {}

    def get(
        self,
        family: str,
        name: str,
        device: str,
        load: Callable[[str, str], ModelT],
    ) -> ModelT:
        """The model `name` of `family` on `device`, made with `load` once.

        `load` is called with the name and the device on first use only. A
        loader that raises leaves nothing held, so the next use tries again.
        """
        key = (family, name, device)
        with self._load_lock:
            with self._state_lock:
                held = self._models.get(key)
            if held is not None:
                # One key always holds what its own family's loader made.
                return cast(ModelT, held)
            model = load(name, device)
            with self._state_lock:
                self._models[key] = model
            return model

    def loaded(self) -> list[str]:
        """The held models as `family:name@device`, in that order."""
        with self._state_lock:
            return sorted(
                f"{family}:{name}@{device}" for family, name, device in self._models
            )


# The service's one registry. Tests put a fresh one in its place.
models = ModelRegistry()


def loaded_models() -> list[str]:
    """The models held in memory, for GET /gpu; never imports torch."""
    return models.loaded()
