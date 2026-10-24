"""The preparation steps of a song, run in order inside one queued job.

`prepare` walks fetch, separation, reference and lyrics, recording each
step's state in the song's status.json as it goes so the browser can poll
progress. The work of a step is a runner registered in `RUNNERS`. A step with
no runner yet is reported as skipped, with a note naming the ROADMAP task that
builds it, so the browser can tell "not built" from "failed". To add a runner,
import it here and replace its `None` in `RUNNERS`; nothing else changes.
"""

import logging
import math
import time
from collections.abc import Callable

from encore_service.schemas import (
    SongSource,
    SongStatus,
    SongSteps,
    StepName,
    StepStatus,
)
from encore_service.store import SongMeta, SongStore

logger = logging.getLogger(__name__)

# Steps in run order; a step may depend on what an earlier one produced.
STEP_ORDER: tuple[StepName, ...] = ("fetch", "separation", "reference", "lyrics")

# Called by a runner with how far it has got, from 0 to 1.
Report = Callable[[float], None]
# Does one step's work for one song, and raises when it cannot.
Runner = Callable[[SongStore, str, Report], None]

# Step name -> its runner, or None while the step is not built.
RUNNERS: dict[StepName, Runner | None] = {
    "fetch": None,
    "separation": None,
    "reference": None,
    "lyrics": None,
}

# The ROADMAP task that registers each runner, for the "Not built yet" note.
_BUILT_BY: dict[StepName, str] = {
    "fetch": "P2-T1b",
    "separation": "P2-T2",
    "reference": "P2-T3",
    "lyrics": "P2-T4",
}

# Progress reaches the status file when it has moved this far, or when this
# long has passed since the last write, so a polling browser sees movement
# without a runner rewriting the file on every audio chunk.
MIN_PROGRESS_STEP = 0.01
MIN_PROGRESS_INTERVAL_S = 0.5
# Float subtraction leaves a step of exactly 0.01 a hair short (0.03 - 0.02 is
# 0.00999...), which would hold that write back until the next report.
_PROGRESS_EPSILON = 1e-9


def _applies(step: StepName, source: SongSource) -> bool:
    """Whether a step has anything to do for a song from this source."""
    # An upload arrives with its audio; only a link has to be fetched.
    return step != "fetch" or source != "file"


def initial_status(song_id: str, meta: SongMeta) -> SongStatus:
    """A new song's status: all steps queued, fetch skipped for uploads."""
    steps = SongSteps()
    for name in STEP_ORDER:
        if not _applies(name, meta.source):
            setattr(steps, name, StepStatus(state="skipped"))
    return SongStatus(
        song_id=song_id,
        title=meta.title,
        duration_s=meta.duration_s,
        source=meta.source,
        steps=steps,
    )


def make_reporter(
    store: SongStore,
    song_id: str,
    step: StepName,
    clock: Callable[[], float] = time.monotonic,
) -> Report:
    """A progress callback that writes to the status file sparingly.

    Progress is written when it has moved by MIN_PROGRESS_STEP, when
    MIN_PROGRESS_INTERVAL_S has passed since the last write and it has changed,
    and always on reaching 1. Values outside 0 to 1 are clamped and NaN is
    ignored, so a runner's rounding can never fail the step.
    """
    written = 0.0
    written_at = clock()

    def report(progress: float) -> None:
        nonlocal written, written_at
        if not math.isfinite(progress):
            return
        value = min(max(progress, 0.0), 1.0)
        now = clock()
        due = (
            value >= 1.0
            or value - written >= MIN_PROGRESS_STEP - _PROGRESS_EPSILON
            or (value != written and now - written_at >= MIN_PROGRESS_INTERVAL_S)
        )
        if not due:
            return
        store.update_step(song_id, step, progress=value)
        written, written_at = value, now

    return report


def prepare(store: SongStore, song_id: str) -> None:
    """Run each step of a song that is not done yet, in order.

    Safe to repeat: finished steps are left alone and every other step is
    judged afresh, so a step skipped as "not built yet" runs once its runner
    is registered and a failed step is retried.
    """
    for step in STEP_ORDER:
        # Read on every turn: the step before this one decides what it does.
        status = store.read_status(song_id)
        if status is None:
            logger.warning("Song %s vanished before it was prepared", song_id)
            return
        if getattr(status.steps, step).state == "done":
            continue
        _run_step(store, song_id, step, status)


def _run_step(
    store: SongStore, song_id: str, step: StepName, status: SongStatus
) -> None:
    """Settle one step: skip it, or run it and record how it went."""
    if not _applies(step, status.source):
        _skip(store, song_id, step, None)
        return
    runner = RUNNERS[step]
    if runner is None:
        _skip(store, song_id, step, f"Not built yet (ROADMAP {_BUILT_BY[step]})")
        return
    blocker = _blocker(store, song_id, step, status)
    if blocker is not None:
        _skip(store, song_id, step, blocker)
        return

    store.update_step(
        song_id, step, state="running", progress=0.0, error=None, detail=None
    )
    try:
        runner(store, song_id, make_reporter(store, song_id, step))
    except (Exception, SystemExit) as exc:
        # SystemExit too: a library that calls sys.exit() would otherwise
        # leave this step "running" for good. The traceback goes to the
        # service log; the browser gets the message.
        logger.exception("Step %s failed for song %s", step, song_id)
        store.update_step(
            song_id,
            step,
            state="failed",
            error=_failure_message(exc),
            detail=None,
        )
        return
    store.update_step(
        song_id, step, state="done", progress=1.0, error=None, detail=None
    )


def _failure_message(exc: BaseException) -> str:
    """What the browser shows for a failed step: text, never a traceback."""
    if isinstance(exc, SystemExit) and (exc.code is None or isinstance(exc.code, int)):
        # A bare exit status says nothing to the person reading it.
        return f"Exited with status {exc.code or 0}"
    return str(exc) or type(exc).__name__


def _skip(store: SongStore, song_id: str, step: StepName, detail: str | None) -> None:
    """Mark a step skipped, clearing anything an earlier attempt left."""
    store.update_step(
        song_id, step, state="skipped", progress=0.0, error=None, detail=detail
    )


def _blocker(
    store: SongStore, song_id: str, step: StepName, status: SongStatus
) -> str | None:
    """Why `step` cannot run yet, worded for the user, or None when it can."""
    if step == "separation":
        # It needs audio on disk.
        if store.source_path(song_id) is not None:
            return None
        # A link gets its audio from the fetch step, but an upload arrives with
        # it, so for an upload the audio has gone missing from the cache and
        # naming fetch would send the person after a step that never applies.
        if status.source == "file":
            return "Source audio is missing. Add the file again."
        return "Needs fetch"
    if step in ("reference", "lyrics"):
        # Both read the vocal that separation writes.
        return None if status.steps.separation.state == "done" else "Needs separation"
    return None
