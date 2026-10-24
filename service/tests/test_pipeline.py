"""Tests for the preparation steps: skipping, running, failing and re-running.

Runners are fakes placed in the registry with monkeypatch, so these tests
pin down the pipeline's rules without any model or network.
"""

import logging
import threading
from collections.abc import Callable, Iterator

import pytest

from encore_service import pipeline
from encore_service.errors import StepSkipped
from encore_service.jobs import JobQueue
from encore_service.pipeline import (
    MIN_PROGRESS_INTERVAL_S,
    MIN_PROGRESS_STEP,
    RUNNERS,
    STEP_ORDER,
    initial_status,
    make_reporter,
    prepare,
    queue_preparation,
)
from encore_service.schemas import SongStatus, SongSteps, StepStatus
from encore_service.store import STEM_FILES, SongMeta, SongStore


class Calls:
    """A fake runner that records its calls and does what it is told."""

    def __init__(
        self, action: Callable[[SongStore, str, Callable[[float], None]], None]
    ) -> None:
        self.action = action
        self.count = 0

    def __call__(
        self, store: SongStore, song_id: str, report: Callable[[float], None]
    ) -> None:
        self.count += 1
        self.action(store, song_id, report)


def _ok(store: SongStore, song_id: str, report: Callable[[float], None]) -> None:
    report(0.5)


def _boom(store: SongStore, song_id: str, report: Callable[[float], None]) -> None:
    raise RuntimeError("model exploded")


def _put_stems(store: SongStore, song_id: str) -> None:
    """Leave both stems in the song's folder, as the separation step does."""
    for name in STEM_FILES.values():
        (store.song_dir(song_id) / name).write_bytes(b"fLaC")


def _separates(store: SongStore, song_id: str, report: Callable[[float], None]) -> None:
    """A separation that does what the real one leaves behind: its stems."""
    report(0.5)
    _put_stems(store, song_id)


def _separation(store: SongStore, song_id: str) -> StepStatus:
    status = store.read_status(song_id)
    assert status is not None
    return status.steps.separation


class FakeClock:
    """A clock the test moves by hand."""

    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_step_order_matches_the_schema() -> None:
    assert STEP_ORDER == ("fetch", "separation", "reference", "lyrics")
    assert list(SongSteps.model_fields) == list(STEP_ORDER)
    assert set(RUNNERS) == set(STEP_ORDER)


def test_with_no_runners_every_step_is_skipped_with_a_reason(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song()
    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    steps = status.steps
    # An upload has nothing to fetch, which is not worth a note.
    assert (steps.fetch.state, steps.fetch.detail) == ("skipped", None)
    assert (steps.separation.state, steps.separation.detail) == (
        "skipped",
        "Not built yet (ROADMAP P2-T2)",
    )
    assert (steps.reference.state, steps.reference.detail) == (
        "skipped",
        "Not built yet (ROADMAP P2-T3)",
    )
    assert (steps.lyrics.state, steps.lyrics.detail) == (
        "skipped",
        "Not built yet (ROADMAP P2-T4)",
    )
    for name in STEP_ORDER:
        assert getattr(steps, name).error is None
        assert getattr(steps, name).progress == 0.0


def test_a_registered_runner_runs_reports_and_ends_done(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    seen: list[tuple[str, float]] = []

    def separate(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        step = _separation(s, sid)
        seen.append((step.state, step.progress))
        report(0.5)
        seen.append(("reported", _separation(s, sid).progress))

    runner = Calls(separate)
    monkeypatch.setitem(RUNNERS, "separation", runner)

    prepare(store, song_id)

    assert runner.count == 1
    assert seen == [("running", 0.0), ("reported", 0.5)]
    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.separation.state, status.steps.separation.progress) == (
        "done",
        1.0,
    )
    assert status.steps.separation.detail is None
    # The steps after it have no runner, so they say so.
    assert status.steps.reference.detail == "Not built yet (ROADMAP P2-T3)"
    assert status.steps.lyrics.detail == "Not built yet (ROADMAP P2-T4)"


def test_a_raising_runner_fails_its_step_and_its_dependants_skip(
    store: SongStore,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    song_id = new_song()
    reference, lyrics = Calls(_ok), Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", _boom)
    monkeypatch.setitem(RUNNERS, "reference", reference)
    monkeypatch.setitem(RUNNERS, "lyrics", lyrics)

    with caplog.at_level(logging.ERROR, logger="encore_service.pipeline"):
        prepare(store, song_id)  # does not raise

    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.separation.state == "failed"
    assert status.steps.separation.error == "model exploded"
    assert status.steps.separation.detail is None
    for dependant in (status.steps.reference, status.steps.lyrics):
        assert (dependant.state, dependant.detail) == ("skipped", "Needs separation")
        assert dependant.error is None
    assert (reference.count, lyrics.count) == (0, 0)
    # The browser gets the message only; the traceback is for the service log.
    assert "Traceback" not in (status.steps.separation.error or "")
    assert "model exploded" in caplog.text
    assert any(record.exc_info for record in caplog.records)


def _exit(store: SongStore, song_id: str, report: Callable[[float], None]) -> None:
    raise SystemExit(2)


def test_a_runner_that_calls_exit_fails_its_step_like_any_other(
    store: SongStore,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    song_id = new_song()
    reference = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", _exit)
    monkeypatch.setitem(RUNNERS, "reference", reference)

    with caplog.at_level(logging.ERROR, logger="encore_service.pipeline"):
        prepare(store, song_id)  # SystemExit does not get out

    status = store.read_status(song_id)
    assert status is not None
    # Left "running" it would stay so until the next start.
    assert status.steps.separation.state == "failed"
    assert status.steps.separation.error == "Exited with status 2"
    assert status.steps.reference.detail == "Needs separation"
    assert reference.count == 0
    assert any(record.exc_info for record in caplog.records)


@pytest.mark.parametrize(
    ("raised", "message"),
    [
        (SystemExit(), "Exited with status 0"),
        (SystemExit(0), "Exited with status 0"),
        (SystemExit(3), "Exited with status 3"),
        # A string is what sys.exit("...") prints, so it is already readable.
        (SystemExit("no usable audio"), "no usable audio"),
        (RuntimeError("out of memory"), "out of memory"),
        (ValueError(), "ValueError"),
    ],
)
def test_a_failed_step_shows_text_a_person_can_read(
    store: SongStore,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
    raised: BaseException,
    message: str,
) -> None:
    def fail(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        raise raised

    song_id = new_song()
    monkeypatch.setitem(RUNNERS, "separation", fail)
    prepare(store, song_id)
    assert _separation(store, song_id).error == message


def test_a_failure_with_no_message_still_says_something(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    def silent(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        raise ValueError

    song_id = new_song()
    monkeypatch.setitem(RUNNERS, "separation", silent)
    prepare(store, song_id)
    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.separation.error == "ValueError"


def test_a_failed_step_keeps_the_progress_it_reached(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    def half_way(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        report(0.5)
        raise RuntimeError("out of memory")

    song_id = new_song()
    monkeypatch.setitem(RUNNERS, "separation", half_way)
    prepare(store, song_id)
    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.separation.progress == 0.5


def test_re_running_prepare_runs_only_the_steps_not_done(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    separation, reference = Calls(_separates), Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", separation)

    prepare(store, song_id)
    first = store.read_status(song_id)
    assert first is not None
    assert first.steps.separation.state == "done"
    assert first.steps.reference.detail == "Not built yet (ROADMAP P2-T3)"

    # The reference runner now exists. Separation is done, so it is left
    # alone, and the step that was skipped as "not built" gets its turn.
    monkeypatch.setitem(RUNNERS, "reference", reference)
    prepare(store, song_id)

    assert (separation.count, reference.count) == (1, 1)
    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.reference.state == "done"
    assert status.steps.reference.detail is None
    assert status.steps.lyrics.detail == "Not built yet (ROADMAP P2-T4)"


@pytest.mark.parametrize("step", ["reference", "lyrics"])
def test_a_done_step_is_never_run_again(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    song_id = new_song()
    store.update_step(song_id, step, state="done", progress=1.0)
    runner = Calls(_ok)
    monkeypatch.setitem(RUNNERS, step, runner)
    prepare(store, song_id)
    prepare(store, song_id)
    assert runner.count == 0


def test_a_done_separation_is_left_alone_while_its_stems_are_there(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    store.update_step(song_id, "separation", state="done", progress=1.0)
    _put_stems(store, song_id)
    separation = Calls(_separates)
    monkeypatch.setitem(RUNNERS, "separation", separation)

    prepare(store, song_id)
    prepare(store, song_id)

    assert separation.count == 0
    assert _separation(store, song_id).state == "done"


@pytest.mark.parametrize(
    "gone", [("vocals",), ("no_vocals",), ("vocals", "no_vocals")], ids="-".join
)
def test_a_done_separation_runs_again_when_a_stem_has_gone_missing(
    store: SongStore,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
    gone: tuple[str, ...],
) -> None:
    song_id = new_song()
    separation = Calls(_separates)
    monkeypatch.setitem(RUNNERS, "separation", separation)
    prepare(store, song_id)
    assert separation.count == 1
    for stem in gone:
        # Deleted by hand, to free the drive say; the status still says done.
        (store.song_dir(song_id) / STEM_FILES[stem]).unlink()
    assert _separation(store, song_id).state == "done"

    prepare(store, song_id)

    # Run again, not left "done" for good beside a stem that is not there.
    assert separation.count == 2
    assert _separation(store, song_id).state == "done"
    assert all(store.stem_path(song_id, stem) for stem in STEM_FILES)


def test_a_failed_step_is_retried_and_its_error_cleared(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    monkeypatch.setitem(RUNNERS, "separation", _boom)
    prepare(store, song_id)
    failed = store.read_status(song_id)
    assert failed is not None
    assert failed.steps.separation.error == "model exploded"

    fixed = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", fixed)
    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert fixed.count == 1
    assert status.steps.separation.state == "done"
    assert status.steps.separation.error is None


def test_a_step_left_running_is_run_again(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    store.update_step(song_id, "separation", state="running", progress=0.3)
    separation = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", separation)
    prepare(store, song_id)
    assert separation.count == 1


def test_a_link_without_its_audio_cannot_be_separated(
    store: SongStore, new_link: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_link()
    separation = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", separation)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    # A link does have something to fetch, and its runner is not built yet.
    assert status.steps.fetch.state == "skipped"
    assert status.steps.fetch.detail == "Not built yet (ROADMAP P2-T1b)"
    assert (status.steps.separation.state, status.steps.separation.detail) == (
        "skipped",
        "Needs fetch",
    )
    assert separation.count == 0


def test_a_link_is_separated_once_its_audio_has_been_fetched(
    store: SongStore, new_link: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fetch(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        report(0.5)
        (s.song_dir(sid) / "source.flac").write_bytes(b"fLaC")

    song_id = new_link()
    separation = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "fetch", fetch)
    monkeypatch.setitem(RUNNERS, "separation", separation)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert status.source == "youtube"
    assert status.steps.fetch.state == "done"
    assert status.steps.separation.state == "done"
    assert separation.count == 1


def test_a_failed_fetch_leaves_nothing_to_separate(
    store: SongStore, new_link: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_link()
    separation = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "fetch", _boom)
    monkeypatch.setitem(RUNNERS, "separation", separation)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.fetch.state == "failed"
    assert status.steps.separation.detail == "Needs fetch"
    assert separation.count == 0


def test_a_done_fetch_runs_again_when_its_audio_has_gone_missing(
    store: SongStore, new_link: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_link()
    # The fetch finished once; the file it made was lost from the cache after.
    store.update_step(song_id, "fetch", state="done", progress=1.0)
    assert store.source_path(song_id) is None

    def fetch(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        (s.song_dir(sid) / "source.flac").write_bytes(b"fLaC")

    fetching, separation = Calls(fetch), Calls(_ok)
    monkeypatch.setitem(RUNNERS, "fetch", fetching)
    monkeypatch.setitem(RUNNERS, "separation", separation)

    prepare(store, song_id)

    # Not "Needs fetch" for good: the fetch ran, and the audio is back.
    assert fetching.count == 1
    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.fetch.state == "done"
    assert status.steps.separation.state == "done"
    assert separation.count == 1


def test_a_done_fetch_is_left_alone_while_its_audio_is_there(
    store: SongStore, new_link: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_link()
    store.update_step(song_id, "fetch", state="done", progress=1.0)
    (store.song_dir(song_id) / "source.flac").write_bytes(b"fLaC")
    fetching = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "fetch", fetching)

    prepare(store, song_id)

    assert fetching.count == 0
    assert store.read_status(song_id) is not None


def test_an_upload_that_lost_its_audio_is_told_to_be_added_again(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    source = store.song_dir(song_id) / "source.wav"
    source.unlink()
    separation = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", separation)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.separation.state, status.steps.separation.detail) == (
        "skipped",
        "Source audio is missing. Add the file again.",
    )
    # An upload has no fetch step, so the note must not send the person to one.
    assert status.steps.fetch.detail is None
    assert separation.count == 0

    # Once the audio is back, the step that was waiting for it runs.
    source.write_bytes(b"audio")
    prepare(store, song_id)
    assert separation.count == 1
    assert _separation(store, song_id).state == "done"


def test_skipping_a_step_clears_the_error_of_an_earlier_attempt(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    store.update_step(song_id, "reference", state="failed", error="old failure")
    monkeypatch.setitem(RUNNERS, "separation", _boom)
    monkeypatch.setitem(RUNNERS, "reference", Calls(_ok))

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    reference = status.steps.reference
    assert (reference.state, reference.error, reference.detail) == (
        "skipped",
        None,
        "Needs separation",
    )


def test_preparing_a_song_that_has_gone_does_not_raise(
    store: SongStore, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="encore_service.pipeline"):
        prepare(store, "8" * 64)
    assert "vanished" in caplog.text


def test_initial_status_for_an_upload_skips_fetch_only() -> None:
    meta = SongMeta(source="file", title="Take", duration_s=3.5)
    status = initial_status("9" * 64, meta)
    assert (status.title, status.duration_s, status.source) == ("Take", 3.5, "file")
    assert status.steps.fetch.state == "skipped"
    assert status.steps.fetch.detail is None
    for name in ("separation", "reference", "lyrics"):
        assert getattr(status.steps, name).state == "queued"


def test_initial_status_for_a_link_queues_every_step() -> None:
    meta = SongMeta(source="youtube", title="Clip", video_id="dQw4w9WgXcQ")
    status = initial_status("yt-dQw4w9WgXcQ", meta)
    assert status.source == "youtube"
    assert status.duration_s is None
    for name in STEP_ORDER:
        assert getattr(status.steps, name).state == "queued"


def test_the_reporter_writes_sparingly(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert MIN_PROGRESS_STEP == 0.01
    assert MIN_PROGRESS_INTERVAL_S == 0.5
    song_id = new_song()
    writes: list[float] = []
    real_update = store.update_step

    def spy(sid: str, step: str, **changes: float) -> object:
        writes.append(changes["progress"])
        return real_update(sid, step, **changes)

    monkeypatch.setattr(store, "update_step", spy)
    clock = FakeClock()
    report = make_reporter(store, song_id, "separation", clock)

    report(0.005)  # moved by less than 0.01 and no time has passed
    report(0.02)  # moved by 0.02
    # A step of one hundredth counts, though floats put 0.03 - 0.02 just short.
    assert 0.03 - 0.02 < MIN_PROGRESS_STEP
    report(0.03)
    report(0.035)  # only 0.005 more, and no time has passed
    clock.now += 0.6
    report(0.035)  # half a second has passed since the last write
    report(0.035)  # nothing new
    clock.now += 0.6
    report(0.035)  # time has passed, but there is still nothing new
    report(1.0)  # reaching the end is always written

    assert writes == [0.02, 0.03, 0.035, 1.0]
    assert _separation(store, song_id).progress == 1.0


def test_the_reporter_clamps_and_ignores_nonsense(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song()
    report = make_reporter(store, song_id, "separation", FakeClock())

    report(float("nan"))
    report(float("inf"))
    report(-0.5)  # clamps to 0, which is where it already is
    assert _separation(store, song_id).progress == 0.0

    report(1.0000001)  # a runner's rounding must not fail the step
    assert _separation(store, song_id).progress == 1.0


# --- StepSkipped -------------------------------------------------------------


def _skipping(reason: str) -> Callable[[SongStore, str, Callable[[float], None]], None]:
    def skip(store: SongStore, song_id: str, report: Callable[[float], None]) -> None:
        raise StepSkipped(reason)

    return skip


def test_a_runner_that_raises_step_skipped_ends_its_step_skipped_with_the_reason(
    store: SongStore,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    song_id = new_song()
    monkeypatch.setitem(RUNNERS, "separation", _skipping("Install the extra"))

    with caplog.at_level(logging.INFO, logger="encore_service.pipeline"):
        prepare(store, song_id)

    step = _separation(store, song_id)
    assert (step.state, step.detail) == ("skipped", "Install the extra")
    assert (step.error, step.progress) == (None, 0.0)
    # Not a failure: nothing at error level, no traceback, one line saying so.
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert "Step separation skipped for song" in caplog.text
    assert "Install the extra" in caplog.text


def test_a_skip_forgets_the_progress_the_runner_reported_before_it(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    def part_way(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        report(0.6)
        assert _separation(s, sid).progress == 0.6
        raise StepSkipped("Nothing to separate")

    song_id = new_song()
    monkeypatch.setitem(RUNNERS, "separation", part_way)

    prepare(store, song_id)

    step = _separation(store, song_id)
    assert (step.state, step.progress, step.detail) == (
        "skipped",
        0.0,
        "Nothing to separate",
    )


def test_the_steps_that_need_a_skipped_step_skip_too_and_do_not_run(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    reference, lyrics = Calls(_ok), Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", _skipping("Install the extra"))
    monkeypatch.setitem(RUNNERS, "reference", reference)
    monkeypatch.setitem(RUNNERS, "lyrics", lyrics)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    for dependant in (status.steps.reference, status.steps.lyrics):
        assert (dependant.state, dependant.detail) == ("skipped", "Needs separation")
        assert dependant.error is None
    assert (reference.count, lyrics.count) == (0, 0)


def test_a_skipped_fetch_leaves_separation_waiting_for_the_audio(
    store: SongStore, new_link: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_link()
    separation = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "fetch", _skipping("Offline"))
    monkeypatch.setitem(RUNNERS, "separation", separation)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.fetch.state, status.steps.fetch.detail) == (
        "skipped",
        "Offline",
    )
    assert status.steps.separation.detail == "Needs fetch"
    assert separation.count == 0


def test_a_skipped_step_is_tried_again_and_its_reason_cleared(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    monkeypatch.setitem(RUNNERS, "separation", _skipping("Install the extra"))
    prepare(store, song_id)
    assert _separation(store, song_id).state == "skipped"

    # The extra is installed; the person adds the song again.
    fixed = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", fixed)
    prepare(store, song_id)

    step = _separation(store, song_id)
    assert (step.state, step.detail, step.error) == ("done", None, None)
    assert fixed.count == 1


def test_a_skipped_step_is_not_a_failure_for_the_next_start(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    monkeypatch.setitem(RUNNERS, "separation", _skipping("Install the extra"))
    prepare(store, song_id)

    # Every step has settled, so nothing is queued to be resumed.
    assert song_id not in store.ids_waiting_to_run()
    assert store.recover_interrupted() == []


def test_step_skipped_is_the_pipelines_to_import_and_needs_a_reason() -> None:
    assert pipeline.StepSkipped is StepSkipped
    assert StepSkipped("why").reason == "why"
    assert str(StepSkipped("why")) == "why"
    for blank in ("", "   ", "\n"):
        with pytest.raises(ValueError, match="say why"):
            StepSkipped(blank)


# --- queue_preparation -----------------------------------------------------

WAIT_S = 10.0
QUEUED = StepStatus()  # queued, no progress, no error, no detail


@pytest.fixture
def jobs() -> Iterator[JobQueue]:
    """A job queue stopped after the test; a test starts it when it needs to."""
    job_queue = JobQueue()
    yield job_queue
    job_queue.stop(timeout=WAIT_S)


def _status(store: SongStore, song_id: str) -> SongStatus:
    status = store.read_status(song_id)
    assert status is not None
    return status


def test_queue_preparation_puts_unfinished_steps_back_to_queued(
    store: SongStore, jobs: JobQueue, new_link: Callable
) -> None:
    song_id = new_link()
    store.update_step(song_id, "fetch", state="failed", progress=0.4, error="boom")
    store.update_step(song_id, "separation", state="skipped", detail="Needs fetch")
    store.update_step(song_id, "reference", state="failed", error="old failure")
    store.update_step(song_id, "lyrics", state="running", progress=0.2)

    returned = queue_preparation(store, jobs, song_id)

    # The status handed back is the one after the reset, and so is the file.
    for name in STEP_ORDER:
        assert getattr(returned.steps, name) == QUEUED
    assert _status(store, song_id) == returned
    # Nothing but the steps changed.
    assert (returned.song_id, returned.source) == (song_id, "youtube")
    assert returned.title == "Linked"
    assert returned.duration_s == 200.0


def test_queue_preparation_leaves_done_steps_alone(
    store: SongStore, jobs: JobQueue, new_link: Callable
) -> None:
    song_id = new_link()
    # A fetch is only done while the audio it made is in the cache.
    (store.song_dir(song_id) / "source.flac").write_bytes(b"fLaC")
    store.update_step(song_id, "fetch", state="done", progress=1.0)
    store.update_step(song_id, "separation", state="failed", error="out of memory")
    store.update_step(song_id, "reference", state="skipped", detail="Needs separation")

    returned = queue_preparation(store, jobs, song_id)

    assert returned.steps.fetch == StepStatus(state="done", progress=1.0)
    assert returned.steps.separation == QUEUED
    assert returned.steps.reference == QUEUED
    assert returned.steps.lyrics == QUEUED


def test_queue_preparation_queues_a_done_fetch_whose_audio_has_gone_missing(
    store: SongStore, jobs: JobQueue, new_link: Callable
) -> None:
    song_id = new_link()
    store.update_step(song_id, "fetch", state="done", progress=1.0)
    store.update_step(song_id, "separation", state="skipped", detail="Needs fetch")
    assert store.source_path(song_id) is None

    returned = queue_preparation(store, jobs, song_id)

    # Adding the link again is how a lost download is repaired, so the status
    # must not go on saying the download is done.
    assert returned.steps.fetch == QUEUED
    assert returned.steps.separation == QUEUED
    assert _status(store, song_id) == returned


def test_queue_preparation_queues_a_done_separation_whose_stems_have_gone_missing(
    store: SongStore, jobs: JobQueue, new_song: Callable
) -> None:
    song_id = new_song()
    store.update_step(song_id, "separation", state="done", progress=1.0)
    _put_stems(store, song_id)
    (store.song_dir(song_id) / STEM_FILES["no_vocals"]).unlink()

    returned = queue_preparation(store, jobs, song_id)

    # Adding the song again is how lost stems are made again, so the status
    # must not go on saying the separation is done.
    assert returned.steps.separation == QUEUED
    assert _status(store, song_id) == returned


def test_queue_preparation_leaves_a_done_separation_alone_while_its_stems_are_there(
    store: SongStore, jobs: JobQueue, new_song: Callable
) -> None:
    song_id = new_song()
    store.update_step(song_id, "separation", state="done", progress=1.0)
    _put_stems(store, song_id)

    returned = queue_preparation(store, jobs, song_id)

    assert returned.steps.separation == StepStatus(state="done", progress=1.0)


def test_queue_preparation_keeps_fetch_skipped_for_an_upload(
    store: SongStore, jobs: JobQueue, new_song: Callable
) -> None:
    song_id = new_song()
    store.update_step(song_id, "separation", state="failed", error="no")

    returned = queue_preparation(store, jobs, song_id)

    # An upload arrives with its audio, so fetch never applies to it.
    assert returned.steps.fetch == StepStatus(state="skipped")
    assert returned.steps.separation == QUEUED
    assert _status(store, song_id) == returned


def test_queue_preparation_of_a_song_with_nothing_to_reset_returns_it_as_it_is(
    store: SongStore, jobs: JobQueue, new_song: Callable
) -> None:
    song_id = new_song()
    before = _status(store, song_id)
    assert queue_preparation(store, jobs, song_id) == before
    assert _status(store, song_id) == before


def test_queue_preparation_queues_one_prepare_job_for_the_song(
    store: SongStore,
    jobs: JobQueue,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    song_id = new_song()
    separation = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", separation)

    queue_preparation(store, jobs, song_id)
    # Still pending, as the worker has not started: a repeat is not queued.
    assert jobs.submit(song_id, lambda: None) is False
    jobs.start()
    assert jobs.wait_idle(WAIT_S)

    assert separation.count == 1
    assert _separation(store, song_id).state == "done"


def test_queue_preparation_changes_nothing_for_a_song_already_queued(
    store: SongStore, jobs: JobQueue, new_song: Callable
) -> None:
    song_id = new_song()
    # Accepted, and the worker is not started, so the job stays queued.
    queue_preparation(store, jobs, song_id)
    store.update_step(song_id, "separation", state="failed", error="late news")
    queued = _status(store, song_id)

    again = queue_preparation(store, jobs, song_id)

    # The failure is not wiped: that job has not run yet, and a reset now
    # would hide a result the person has not seen.
    assert again == queued
    assert again.steps.separation.state == "failed"
    assert _status(store, song_id) == queued


def test_queue_preparation_returns_a_running_song_unchanged(
    store: SongStore,
    jobs: JobQueue,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    song_id = new_song()
    started, release = threading.Event(), threading.Event()

    def separate(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        report(0.5)
        started.set()
        assert release.wait(WAIT_S)

    monkeypatch.setitem(RUNNERS, "separation", separate)
    jobs.start()
    first = queue_preparation(store, jobs, song_id)
    assert first.steps.separation == QUEUED
    assert started.wait(WAIT_S)
    running = _status(store, song_id)
    assert (running.steps.separation.state, running.steps.separation.progress) == (
        "running",
        0.5,
    )

    again = queue_preparation(store, jobs, song_id)

    assert again == running
    assert _status(store, song_id) == running
    release.set()
    assert jobs.wait_idle(WAIT_S)
    assert _separation(store, song_id).state == "done"


def test_the_reset_lands_before_a_worker_can_start_the_job(
    store: SongStore,
    jobs: JobQueue,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    song_id = new_song()
    store.update_step(song_id, "separation", state="failed", error="old failure")
    store.update_step(song_id, "reference", state="failed", error="old failure")
    at_entry: list[str] = []

    def separate(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        # Runs on the worker, the moment it has the job.
        status = s.read_status(sid)
        assert status is not None
        at_entry.append(status.steps.reference.state)
        raise RuntimeError("new failure")

    real_reset = pipeline._reset_unfinished

    def slow_reset(s: SongStore, sid: str) -> SongStatus:
        # Hand a worker that already holds the job time to finish it. A reset
        # that waited for the job to be queued would then bury its result;
        # one that runs first just waits out the timeout, as no job can run.
        jobs.wait_idle(timeout=0.3)
        return real_reset(s, sid)

    monkeypatch.setattr(pipeline, "_reset_unfinished", slow_reset)
    monkeypatch.setitem(RUNNERS, "separation", separate)
    jobs.start()

    returned = queue_preparation(store, jobs, song_id)
    assert jobs.wait_idle(WAIT_S)

    # The job saw the reset steps, not the failures they had before...
    assert at_entry == ["queued"]
    assert returned.steps.separation == QUEUED
    # ...and what it found afterwards stands.
    step = _separation(store, song_id)
    assert (step.state, step.error) == ("failed", "new failure")
    reference = _status(store, song_id).steps.reference
    assert (reference.state, reference.error) == ("skipped", None)


def test_queue_preparation_for_a_song_that_is_gone_raises_and_frees_the_key(
    store: SongStore, jobs: JobQueue
) -> None:
    with pytest.raises(FileNotFoundError):
        queue_preparation(store, jobs, "9" * 64)
    # Nothing was queued under the id.
    jobs.start()
    assert jobs.wait_idle(WAIT_S)
    assert jobs.submit("9" * 64, lambda: None) is True


def test_a_song_can_be_queued_again_once_its_job_has_finished(
    store: SongStore,
    jobs: JobQueue,
    new_song: Callable,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    song_id = new_song()
    separation = Calls(_boom)
    monkeypatch.setitem(RUNNERS, "separation", separation)
    jobs.start()

    queue_preparation(store, jobs, song_id)
    assert jobs.wait_idle(WAIT_S)
    assert _separation(store, song_id).state == "failed"

    retry = queue_preparation(store, jobs, song_id)
    assert retry.steps.separation == QUEUED
    assert jobs.wait_idle(WAIT_S)
    assert separation.count == 2
