"""Tests for the preparation steps: skipping, running, failing and re-running.

Runners are fakes placed in the registry with monkeypatch, so these tests
pin down the pipeline's rules without any model or network.
"""

import logging
from collections.abc import Callable

import pytest

from encore_service.pipeline import (
    MIN_PROGRESS_INTERVAL_S,
    MIN_PROGRESS_STEP,
    RUNNERS,
    STEP_ORDER,
    initial_status,
    make_reporter,
    prepare,
)
from encore_service.schemas import SongSteps, StepStatus
from encore_service.store import SongMeta, SongStore


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
    separation, reference = Calls(_ok), Calls(_ok)
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


def test_a_done_step_is_never_run_again(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    store.update_step(song_id, "separation", state="done", progress=1.0)
    separation = Calls(_ok)
    monkeypatch.setitem(RUNNERS, "separation", separation)
    prepare(store, song_id)
    prepare(store, song_id)
    assert separation.count == 0


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
