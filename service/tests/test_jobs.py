"""Tests for the one-at-a-time job queue.

Ordering is checked by submitting before the worker starts, and overlap by
holding a job open on an event, so nothing here depends on timing. The only
waiting is `wait_idle`, which is what it is for.
"""

import logging
import threading
from collections.abc import Iterator

import pytest

from encore_service.jobs import JobQueue

WAIT_S = 10.0


@pytest.fixture
def jobs() -> Iterator[JobQueue]:
    job_queue = JobQueue()
    yield job_queue
    job_queue.stop(timeout=WAIT_S)


def _workers() -> set[threading.Thread]:
    """Every live job worker in the process, whichever queue owns it."""
    return {t for t in threading.enumerate() if t.name == "encore-jobs"}


def test_jobs_run_in_submission_order(jobs: JobQueue) -> None:
    ran: list[int] = []
    for n in range(10):
        assert jobs.submit(f"job-{n}", lambda n=n: ran.append(n)) is True
    jobs.start()
    assert jobs.wait_idle(WAIT_S)
    assert ran == list(range(10))


def test_every_job_runs_on_the_one_worker_thread(jobs: JobQueue) -> None:
    names: list[str] = []
    for n in range(20):
        jobs.submit(f"job-{n}", lambda: names.append(threading.current_thread().name))
    jobs.start()
    assert jobs.wait_idle(WAIT_S)
    assert names == ["encore-jobs"] * 20


def test_a_key_already_queued_is_not_queued_again(jobs: JobQueue) -> None:
    ran: list[str] = []
    assert jobs.submit("song", lambda: ran.append("first")) is True
    assert jobs.submit("song", lambda: ran.append("second")) is False
    jobs.start()
    assert jobs.wait_idle(WAIT_S)
    assert ran == ["first"]


def test_a_key_already_running_is_not_queued_again(jobs: JobQueue) -> None:
    started, release = threading.Event(), threading.Event()
    ran: list[str] = []

    def hold() -> None:
        started.set()
        assert release.wait(WAIT_S)
        ran.append("first")

    jobs.start()
    assert jobs.submit("song", hold) is True
    assert started.wait(WAIT_S)
    assert jobs.submit("song", lambda: ran.append("second")) is False
    release.set()
    assert jobs.wait_idle(WAIT_S)
    assert ran == ["first"]


def test_a_key_can_be_submitted_again_once_it_has_finished(jobs: JobQueue) -> None:
    ran: list[str] = []
    jobs.start()
    assert jobs.submit("song", lambda: ran.append("first")) is True
    assert jobs.wait_idle(WAIT_S)
    assert jobs.submit("song", lambda: ran.append("second")) is True
    assert jobs.wait_idle(WAIT_S)
    assert ran == ["first", "second"]


def test_a_failing_job_is_logged_and_the_next_one_still_runs(
    jobs: JobQueue, caplog: pytest.LogCaptureFixture
) -> None:
    ran: list[str] = []

    def explode() -> None:
        raise RuntimeError("boom")

    jobs.start()
    with caplog.at_level(logging.ERROR, logger="encore_service.jobs"):
        jobs.submit("bad", explode)
        jobs.submit("good", lambda: ran.append("good"))
        assert jobs.wait_idle(WAIT_S)

    assert ran == ["good"]
    assert jobs.running
    [record] = [r for r in caplog.records if r.name == "encore_service.jobs"]
    assert "bad" in record.getMessage()
    assert record.exc_info is not None
    assert "boom" in caplog.text
    # The failed key is free again, so the song can be added to retry.
    assert jobs.submit("bad", lambda: ran.append("retried")) is True
    assert jobs.wait_idle(WAIT_S)
    assert ran == ["good", "retried"]


def test_a_job_that_exits_does_not_stop_the_worker(
    jobs: JobQueue, caplog: pytest.LogCaptureFixture
) -> None:
    ran: list[str] = []

    def leave() -> None:
        raise SystemExit(3)

    jobs.start()
    with caplog.at_level(logging.ERROR, logger="encore_service.jobs"):
        jobs.submit("leaver", leave)
        jobs.submit("next", lambda: ran.append("next"))
        # A worker that died in silence would leave "next" pending for ever.
        assert jobs.wait_idle(WAIT_S)

    assert ran == ["next"]
    assert jobs.running
    assert "leaver" in caplog.text
    # The key is free again, so the song can be added to retry.
    assert jobs.submit("leaver", lambda: ran.append("again")) is True
    assert jobs.wait_idle(WAIT_S)
    assert ran == ["next", "again"]


def test_wait_idle_reports_a_timeout(jobs: JobQueue) -> None:
    started, release = threading.Event(), threading.Event()

    def hold() -> None:
        started.set()
        release.wait(WAIT_S)

    jobs.start()
    jobs.submit("song", hold)
    assert started.wait(WAIT_S)
    assert jobs.wait_idle(timeout=0.05) is False
    release.set()
    assert jobs.wait_idle(WAIT_S) is True


def test_wait_idle_is_true_for_an_empty_queue(jobs: JobQueue) -> None:
    assert jobs.wait_idle(0) is True
    jobs.start()
    assert jobs.wait_idle(0) is True


def test_stop_finishes_submitted_jobs_then_joins_the_worker(jobs: JobQueue) -> None:
    ran: list[int] = []
    before = _workers()
    jobs.start()
    assert jobs.running
    [worker] = _workers() - before
    for n in range(5):
        jobs.submit(f"job-{n}", lambda n=n: ran.append(n))
    jobs.stop(timeout=WAIT_S)
    assert ran == list(range(5))
    assert not jobs.running
    assert not worker.is_alive()


def test_the_worker_is_a_daemon(jobs: JobQueue) -> None:
    before = _workers()
    jobs.start()
    [worker] = _workers() - before
    assert worker.daemon


def test_start_twice_runs_one_worker(jobs: JobQueue) -> None:
    before = _workers()
    jobs.start()
    jobs.start()
    assert len(_workers() - before) == 1


def test_stop_is_safe_before_start_and_when_repeated(jobs: JobQueue) -> None:
    jobs.stop()
    jobs.stop()
    assert not jobs.running


def test_a_stopped_queue_refuses_work_and_cannot_restart(jobs: JobQueue) -> None:
    jobs.start()
    jobs.stop(timeout=WAIT_S)
    with pytest.raises(RuntimeError, match="stopped"):
        jobs.submit("song", lambda: None)
    with pytest.raises(RuntimeError, match="restarted"):
        jobs.start()


def test_on_accepted_runs_before_the_job_does(jobs: JobQueue) -> None:
    order: list[str] = []
    jobs.start()
    accepted = jobs.submit(
        "song",
        lambda: order.append("job"),
        on_accepted=lambda: order.append("hook"),
    )
    assert accepted is True
    assert jobs.wait_idle(WAIT_S)
    assert order == ["hook", "job"]


def test_on_accepted_holds_the_job_back_until_it_has_returned(
    jobs: JobQueue,
) -> None:
    in_hook, release = threading.Event(), threading.Event()
    order: list[str] = []

    def slow_hook() -> None:
        in_hook.set()
        assert release.wait(WAIT_S)
        order.append("hook")

    jobs.start()
    submitter = threading.Thread(
        target=jobs.submit,
        args=("song", lambda: order.append("job")),
        kwargs={"on_accepted": slow_hook},
    )
    submitter.start()
    assert in_hook.wait(WAIT_S)
    release.set()
    submitter.join(WAIT_S)
    assert jobs.wait_idle(WAIT_S)
    assert order == ["hook", "job"]


def test_on_accepted_is_skipped_for_a_key_already_queued(jobs: JobQueue) -> None:
    calls: list[str] = []
    # The worker is not started, so the first job stays queued.
    assert jobs.submit("song", lambda: None, on_accepted=lambda: calls.append("1"))
    assert not jobs.submit("song", lambda: None, on_accepted=lambda: calls.append("2"))
    assert calls == ["1"]


def test_on_accepted_is_skipped_for_a_key_already_running(jobs: JobQueue) -> None:
    started, release = threading.Event(), threading.Event()
    calls: list[str] = []

    def hold() -> None:
        started.set()
        release.wait(WAIT_S)

    jobs.start()
    jobs.submit("song", hold)
    assert started.wait(WAIT_S)
    assert not jobs.submit("song", hold, on_accepted=lambda: calls.append("hook"))
    release.set()
    assert jobs.wait_idle(WAIT_S)
    assert calls == []


def test_a_failing_on_accepted_frees_the_key_and_queues_nothing(
    jobs: JobQueue,
) -> None:
    ran: list[str] = []

    def broken() -> None:
        raise OSError("disk full")

    with pytest.raises(OSError, match="disk full"):
        jobs.submit("song", lambda: ran.append("first"), on_accepted=broken)

    jobs.start()
    # Nothing is pending, so the key was freed and the job never queued.
    assert jobs.wait_idle(WAIT_S)
    assert ran == []
    assert jobs.submit("song", lambda: ran.append("second")) is True
    assert jobs.wait_idle(WAIT_S)
    assert ran == ["second"]


def test_a_stopped_queue_does_not_call_on_accepted(jobs: JobQueue) -> None:
    calls: list[str] = []
    jobs.start()
    jobs.stop(timeout=WAIT_S)
    with pytest.raises(RuntimeError, match="stopped"):
        jobs.submit("song", lambda: None, on_accepted=lambda: calls.append("hook"))
    assert calls == []
