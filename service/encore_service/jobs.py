"""A one-at-a-time background job queue.

Song preparation runs models that each want most of the GPU's memory, so
jobs run strictly one after another on a single worker thread, in the order
they were submitted. Callers hand in any callable under a key. Submitting a
key that is already queued or running does nothing, which makes "add this
song again" safe to repeat. A job that fails, even by calling `sys.exit()`, is
logged and the next one runs. The app starts the queue in its lifespan and
stops it on shutdown (`app.py`).
"""

import logging
import queue
import threading
from collections.abc import Callable
from typing import Literal

logger = logging.getLogger(__name__)

# A job takes no arguments; bind them with functools.partial.
Job = Callable[[], object]


class JobQueue:
    """FIFO queue drained by one daemon worker thread; usable once."""

    def __init__(self) -> None:
        # None is the stop sentinel. It queues behind every earlier job, so
        # stop() lets work already submitted finish.
        self._items: queue.Queue[tuple[str, Job] | None] = queue.Queue()
        # Guards _pending and _state, and wakes wait_idle when a job ends.
        self._cond = threading.Condition()
        self._pending: set[str] = set()
        self._state: Literal["new", "running", "stopped"] = "new"
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        """True while the worker thread is alive."""
        thread = self._thread
        return thread is not None and thread.is_alive()

    def start(self) -> None:
        """Start the worker; a no-op if running, an error after stop()."""
        with self._cond:
            if self._state == "running":
                return
            if self._state == "stopped":
                raise RuntimeError("A stopped JobQueue cannot be restarted.")
            self._state = "running"
            # A daemon, so an interrupted job never keeps the process alive.
            self._thread = threading.Thread(
                target=self._work, name="encore-jobs", daemon=True
            )
            self._thread.start()

    def stop(self, timeout: float | None = None) -> None:
        """Finish the jobs already submitted, then join the worker."""
        with self._cond:
            was_running = self._state == "running"
            self._state = "stopped"
            if was_running:
                self._items.put(None)
            thread = self._thread
        if was_running and thread is not None:
            thread.join(timeout)

    def submit(self, key: str, job: Job) -> bool:
        """Queue `job` under `key`; False if that key is queued or running."""
        with self._cond:
            if self._state == "stopped":
                raise RuntimeError("The job queue has been stopped.")
            if key in self._pending:
                return False
            self._pending.add(key)
            # Inside the lock so queue order is submission order.
            self._items.put((key, job))
            return True

    def wait_idle(self, timeout: float | None = None) -> bool:
        """Block until nothing is queued or running; False if time ran out."""
        with self._cond:
            return self._cond.wait_for(lambda: not self._pending, timeout)

    def _work(self) -> None:
        """Run jobs until the stop sentinel arrives."""
        while True:
            item = self._items.get()
            if item is None:
                return
            key, job = item
            try:
                job()
            except BaseException:
                # Not just Exception: a job that calls sys.exit() raises
                # SystemExit, which would end this thread without a word and
                # leave every later song waiting for ever. Ctrl+C is delivered
                # to the main thread, never this one, so nothing the process
                # should act on is swallowed here.
                logger.exception("Job %r failed", key)
            finally:
                with self._cond:
                    self._pending.discard(key)
                    self._cond.notify_all()
