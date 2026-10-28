"""The preparation steps of a song, run in order inside one queued job.

`prepare` walks fetch, separation, reference and lyrics, recording each
step's state in the song's status.json as it goes so the browser can poll
progress. The work of a step is a runner registered in `RUNNERS`. A step with
no runner yet is reported as skipped, with a note naming the ROADMAP task that
builds it, so the browser can tell "not built" from "failed". A runner that
cannot do its work on this machine, or has none to do, raises `StepSkipped`
and its step ends skipped with that reason, which stops the steps that need it
without calling it a failure. To add a runner, import it here and replace its
`None` in `RUNNERS`; nothing else changes. `queue_preparation` is how a song
gets onto the job queue: the routes and the start-up resume all go through it.
"""

import logging
import math
import time
from collections.abc import Callable
from functools import partial

from encore_service.errors import StepSkipped
from encore_service.fetch import fetch_source
from encore_service.jobs import JobQueue
from encore_service.reference import extract_reference
from encore_service.schemas import (
    SongSource,
    SongStatus,
    SongSteps,
    StepName,
    StepStatus,
)
from encore_service.separation import separate_vocals
from encore_service.store import STEM_FILES, SongMeta, SongStore

logger = logging.getLogger(__name__)

# Steps in run order; a step may depend on what an earlier one produced.
STEP_ORDER: tuple[StepName, ...] = ("fetch", "separation", "reference", "lyrics")

# Called by a runner with how far it has got, from 0 to 1.
Report = Callable[[float], None]
# Does one step's work for one song, and raises when it cannot.
Runner = Callable[[SongStore, str, Report], None]

# What the lyrics step says: the words come from a lookup the browser makes,
# so the service has nothing to prepare, but the step stays in the status so
# the browser's list of steps does not change when the service gains lyrics.
LYRICS_SKIPPED = "Lyrics come from a lookup in the app"


def skip_lyrics(store: SongStore, song_id: str, report: Report) -> None:
    """The lyrics step's runner: there is nothing to do, and it says so."""
    raise StepSkipped(LYRICS_SKIPPED)


# Step name -> its runner, or None while the step is not built.
RUNNERS: dict[StepName, Runner | None] = {
    "fetch": fetch_source,
    "separation": separate_vocals,
    "reference": extract_reference,
    "lyrics": skip_lyrics,
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


def queue_preparation(store: SongStore, jobs: JobQueue, song_id: str) -> SongStatus:
    """Queue a song's preparation and return the status to show for it.

    When the queue takes the job, every step that is not done and has work to
    do for this song goes back to `queued` (progress cleared, no error or
    detail), so a step that failed or was skipped does not keep reading that
    way while its retry waits, and the status returned is the one after that
    reset. A fetch whose audio has gone missing, or a separation whose stems
    have, counts as not done. A song that is already queued or running is left
    as it is and its current status returned. Raises FileNotFoundError for a
    song with no status.
    """
    reset: list[SongStatus] = []
    accepted = jobs.submit(
        song_id,
        partial(prepare, store, song_id),
        # Run by the queue before the worker can see the job. Resetting after
        # submit returned would race the worker, which could have failed or
        # finished a step already: the reset would then bury its result.
        on_accepted=lambda: reset.append(_reset_unfinished(store, song_id)),
    )
    if accepted:
        return reset[0]
    status = store.read_status(song_id)
    if status is None:
        raise FileNotFoundError(f"No status stored for song {song_id}")
    return status


def _reset_unfinished(store: SongStore, song_id: str) -> SongStatus:
    """Queue every unfinished step that applies again; returns the status."""
    status = store.read_status(song_id)
    if status is None:
        raise FileNotFoundError(f"No status stored for song {song_id}")
    for step in STEP_ORDER:
        current: StepStatus = getattr(status.steps, step)
        if not _applies(step, status.source) or _is_done(store, song_id, step, status):
            continue
        if current == StepStatus():
            continue
        status = store.update_step(
            song_id, step, state="queued", progress=0.0, error=None, detail=None
        )
    return status


def _is_done(
    store: SongStore, song_id: str, step: StepName, status: SongStatus
) -> bool:
    """Whether a step is done and what it made is still there.

    The fetch and the separation leave files to look for: the song's audio,
    and its two stems. A link whose fetch finished but whose audio has since
    gone missing from the cache is not done, whatever its status says, or
    adding the link again could never fetch the audio back. An upload gets its
    audio back by being added again instead. Likewise a separation whose stems
    have gone: with one missing the stems route would answer "not separated
    yet" for good, since adding the song again would find the step done and
    leave it be.
    """
    if getattr(status.steps, step).state != "done":
        return False
    if step == "fetch" and _applies(step, status.source):
        return store.source_path(song_id) is not None
    if step == "separation":
        return all(store.stem_path(song_id, stem) is not None for stem in STEM_FILES)
    return True


def prepare(store: SongStore, song_id: str) -> None:
    """Run each step of a song that is not done yet, in order.

    Safe to repeat: finished steps are left alone and every other step is
    judged afresh, so a step skipped as "not built yet" runs once its runner
    is registered, a failed step is retried, and a fetch whose audio has gone
    missing, or a separation whose stems have, is run again.
    """
    for step in STEP_ORDER:
        # Read on every turn: the step before this one decides what it does.
        status = store.read_status(song_id)
        if status is None:
            logger.warning("Song %s vanished before it was prepared", song_id)
            return
        if _is_done(store, song_id, step, status):
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
    except StepSkipped as skipped:
        # Not a failure, so no traceback: the reason is for the browser and
        # one line in the log says the step was left out.
        logger.info("Step %s skipped for song %s: %s", step, song_id, skipped.reason)
        _skip(store, song_id, step, skipped.reason)
        return
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
