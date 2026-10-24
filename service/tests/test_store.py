"""Tests for the song cache: id guard, atomic JSON, locking and recovery."""

import json
import os
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from pydantic import ValidationError

from encore_service import store as store_module
from encore_service.pipeline import initial_status
from encore_service.schemas import SongStatus, SongSteps
from encore_service.store import (
    INTERRUPTED_MESSAGE,
    SongMeta,
    SongStore,
    is_valid_id,
)

HASH = "0123456789abcdef" * 4

VALID_IDS = [
    HASH,
    "0" * 64,
    "f" * 64,
    "yt-" + "A" * 11,
    "yt-dQw4w9WgXcQ",
    "yt-a_b-c_d-e_f",  # underscore and hyphen are part of the alphabet
]

INVALID_IDS = [
    "",
    "0" * 63,
    "0" * 65,
    "A" * 64,  # hex must be lowercase
    "g" * 64,
    HASH + "\n",  # a "$" anchor would let this through
    "yt-" + "a" * 10,
    "yt-" + "a" * 12,
    "yt-abc$def123",  # the brief's example; 10 characters, so also too short
    "yt-abc$def1234",  # 11 characters, rejected for the "$" alone
    "yt-" + "a" * 11 + "\n",
    "YT-" + "a" * 11,
    "yt-",
    "../x",
    "..",
    "../" + "0" * 61,  # 64 characters, but a traversal
    "..\\x",
    "C:\\x",
    "a/b",
    "yt-" + "é" * 11,
    "０" * 64,  # fullwidth digits
]


@pytest.mark.parametrize("song_id", VALID_IDS)
def test_valid_ids_are_accepted(song_id: str) -> None:
    assert is_valid_id(song_id)


@pytest.mark.parametrize("song_id", INVALID_IDS)
def test_invalid_ids_are_rejected(song_id: str) -> None:
    assert not is_valid_id(song_id)


def test_invalid_ids_behave_like_unknown_ids(store: SongStore, tmp_path: Path) -> None:
    unknown = "1" * 64
    for bad in INVALID_IDS:
        assert store.exists(bad) is False
        assert store.read_status(bad) is None
        assert store.read_meta(bad) is None
        assert store.source_path(bad) is None
        with pytest.raises(ValueError):
            store.song_dir(bad)
        with pytest.raises(ValueError):
            store.write_status(bad, SongStatus(song_id=bad))
        with pytest.raises(ValueError):
            store.write_meta(bad, SongMeta(source="file"))
        with pytest.raises(ValueError):
            store.update_step(bad, "fetch", state="done")
    # An id that is merely unknown answers the same reads the same way.
    assert store.exists(unknown) is False
    assert store.read_status(unknown) is None
    assert store.source_path(unknown) is None
    # Nothing above touched the disk.
    assert list(tmp_path.iterdir()) == []


def test_status_round_trips_unicode(store: SongStore, new_song: Callable) -> None:
    song_id = new_song()
    status = store.read_status(song_id)
    assert status is not None
    status.title = "Café — 歌"
    store.write_status(song_id, status)
    assert store.read_status(song_id) == status
    raw = (store.song_dir(song_id) / "status.json").read_bytes()
    assert "Café — 歌" in raw.decode("utf-8")


def test_write_status_rejects_a_status_for_another_song(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song()
    with pytest.raises(ValueError):
        store.write_status(song_id, SongStatus(song_id="2" * 64))


def test_meta_round_trips(store: SongStore, new_link: Callable) -> None:
    song_id = new_link()
    meta = store.read_meta(song_id)
    assert meta == SongMeta(
        source="youtube",
        title="Linked",
        url="https://youtu.be/dQw4w9WgXcQ",
        duration_s=200.0,
        video_id="dQw4w9WgXcQ",
    )


def test_unknown_song_reads_as_none(store: SongStore) -> None:
    assert store.read_status("3" * 64) is None
    assert store.read_meta("3" * 64) is None


def test_json_writes_leave_no_temp_file(store: SongStore, new_song: Callable) -> None:
    song_id = new_song()
    for state in ("running", "done"):
        store.update_step(song_id, "separation", state=state)
    store.write_meta(song_id, SongMeta(source="file", title="again"))
    assert list(store.song_dir(song_id).glob("*.tmp")) == []


def test_a_failed_write_keeps_the_old_file(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    before = store.read_status(song_id)

    def full_disk(src: object, dst: object) -> None:
        raise OSError("disk full")

    with monkeypatch.context() as patch:
        patch.setattr(store_module.os, "replace", full_disk)
        with pytest.raises(OSError, match="disk full"):
            store.update_step(song_id, "separation", state="running")

    assert store.read_status(song_id) == before
    assert list(store.song_dir(song_id).glob("*.tmp")) == []


def test_replace_rides_out_a_briefly_locked_file(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    real_replace = os.replace
    attempts: list[int] = []

    def locked_twice(src: object, dst: object) -> None:
        attempts.append(1)
        if len(attempts) <= 2:
            raise PermissionError("held open by a scanner")
        real_replace(src, dst)

    monkeypatch.setattr(store_module, "_REPLACE_RETRY_S", 0.0)
    with monkeypatch.context() as patch:
        patch.setattr(store_module.os, "replace", locked_twice)
        store.update_step(song_id, "separation", state="running")

    assert len(attempts) == 3
    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.separation.state == "running"


def test_replace_gives_up_after_a_few_attempts(
    store: SongStore, new_song: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = new_song()
    attempts: list[int] = []

    def always_locked(src: object, dst: object) -> None:
        attempts.append(1)
        raise PermissionError("held open")

    monkeypatch.setattr(store_module, "_REPLACE_RETRY_S", 0.0)
    with monkeypatch.context() as patch:
        patch.setattr(store_module.os, "replace", always_locked)
        with pytest.raises(PermissionError):
            store.update_step(song_id, "separation", state="running")

    assert len(attempts) == store_module._REPLACE_ATTEMPTS
    assert list(store.song_dir(song_id).glob("*.tmp")) == []


def test_an_unreadable_status_reads_as_missing_and_heals_on_re_add(
    store: SongStore, new_song: Callable, caplog: pytest.LogCaptureFixture
) -> None:
    song_id = new_song(b"damaged")
    (store.song_dir(song_id) / "status.json").write_text("{not json", "utf-8")
    assert store.read_status(song_id) is None
    assert store.exists(song_id) is False
    assert "unreadable" in caplog.text
    # Adding the same file again rebuilds the song instead of failing for good.
    assert new_song(b"damaged") == song_id
    assert store.read_status(song_id) is not None


def test_update_step_merges_only_the_named_step(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song()
    updated = store.update_step(
        song_id, "separation", state="running", progress=0.25, detail="ignored"
    )
    assert updated.steps.separation.state == "running"
    assert updated.steps.separation.progress == 0.25
    assert updated.steps.separation.detail == "ignored"
    # Other steps are untouched, and the file holds the same thing.
    assert updated.steps.reference.state == "queued"
    assert updated.steps.fetch.state == "skipped"
    assert store.read_status(song_id) == updated
    # A later change keeps what an earlier one set.
    again = store.update_step(song_id, "separation", progress=0.5)
    assert again.steps.separation.state == "running"
    assert again.steps.separation.detail == "ignored"


def test_update_step_rejects_bad_input(store: SongStore, new_song: Callable) -> None:
    song_id = new_song()
    before = store.read_status(song_id)
    with pytest.raises(ValueError, match="step"):
        store.update_step(song_id, "mastering", state="done")
    with pytest.raises(ValueError, match="progres"):
        store.update_step(song_id, "separation", progres=0.5)
    with pytest.raises(ValidationError):
        store.update_step(song_id, "separation", progress=1.5)
    with pytest.raises(ValidationError):
        store.update_step(song_id, "separation", state="paused")
    # A rejected update never reaches the file.
    assert store.read_status(song_id) == before


def test_update_step_needs_an_existing_song(store: SongStore) -> None:
    with pytest.raises(FileNotFoundError):
        store.update_step("4" * 64, "fetch", state="done")


def test_update_step_is_atomic_across_threads(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song()
    steps = list(SongSteps.model_fields)
    # Eight writers each own one (step, field) slot. A lost update, from two
    # threads reading the file before either wrote it back, would leave some
    # slot on an earlier value than the last one written.
    slots = [(step, field) for field in ("detail", "error") for step in steps]
    rounds = 50
    barrier = threading.Barrier(len(slots) + 1)

    def write(slot: tuple[str, str]) -> None:
        step, field = slot
        barrier.wait()
        for n in range(rounds):
            store.update_step(song_id, step, **{field: f"{step}-{field}-{n}"})

    def read() -> None:
        # Polling the status, as the browser does, while the worker writes it.
        barrier.wait()
        for _ in range(rounds * 4):
            assert store.read_status(song_id) is not None

    with ThreadPoolExecutor(max_workers=len(slots) + 1) as pool:
        futures = [pool.submit(write, slot) for slot in slots]
        futures.append(pool.submit(read))
        for future in futures:
            future.result()

    final = store.read_status(song_id)
    assert final is not None
    for step, field in slots:
        value = getattr(getattr(final.steps, step), field)
        assert value == f"{step}-{field}-{rounds - 1}"
    path = store.song_dir(song_id) / "status.json"
    assert json.loads(path.read_text("utf-8"))["song_id"] == song_id
    assert list(path.parent.glob("*.tmp")) == []


def test_source_path_finds_only_a_finished_source_file(
    store: SongStore, new_link: Callable
) -> None:
    song_id = new_link()
    folder = store.song_dir(song_id)
    assert store.source_path(song_id) is None
    # Half-written downloads and unrelated files are not a source.
    (folder / "source.flac.part").write_bytes(b"x")
    (folder / "source.webm").write_bytes(b"x")
    (folder / "source.txt").write_bytes(b"x")
    (folder / "meta.json.tmp").write_bytes(b"x")
    assert store.source_path(song_id) is None
    (folder / "source.flac").write_bytes(b"x")
    assert store.source_path(song_id) == folder / "source.flac"


def test_add_upload_moves_the_part_in_and_writes_meta_and_status(
    store: SongStore,
) -> None:
    song_id = "5" * 64
    part = store.incoming_path()
    part.write_bytes(b"riff")
    meta = SongMeta(source="file", title="Take", duration_s=2.0)
    status = initial_status(song_id, meta)

    stored = store.add_upload(song_id, part, ".mp3", meta, status)

    assert stored == status
    assert not part.exists()
    assert (store.song_dir(song_id) / "source.mp3").read_bytes() == b"riff"
    assert store.source_path(song_id) == store.song_dir(song_id) / "source.mp3"
    assert store.read_meta(song_id) == meta
    assert store.read_status(song_id) == status


def test_add_upload_of_a_cached_song_keeps_the_original(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song(b"first")
    store.update_step(song_id, "separation", state="done", progress=1.0)
    cached = store.read_status(song_id)

    part = store.incoming_path()
    part.write_bytes(b"first")
    meta = SongMeta(source="file", title="other name")
    stored = store.add_upload(
        song_id, part, ".wav", meta, initial_status(song_id, meta)
    )

    assert stored == cached
    assert not part.exists()
    assert store.read_status(song_id) == cached
    stored_meta = store.read_meta(song_id)
    assert stored_meta is not None
    assert stored_meta.title == "song"


def test_add_upload_of_a_cached_song_restores_audio_it_has_lost(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song(b"first")
    folder = store.song_dir(song_id)
    (folder / "source.wav").unlink()
    cached = store.read_status(song_id)

    part = store.incoming_path()
    part.write_bytes(b"first")
    meta = SongMeta(source="file", title="other name")
    stored = store.add_upload(
        song_id, part, ".mp3", meta, initial_status(song_id, meta)
    )

    # The hash says these are the lost bytes, so they become the source; the
    # song itself is as it was.
    assert stored == cached
    assert not part.exists()
    assert store.source_path(song_id) == folder / "source.mp3"
    assert (folder / "source.mp3").read_bytes() == b"first"
    assert store.read_status(song_id) == cached
    stored_meta = store.read_meta(song_id)
    assert stored_meta is not None
    assert stored_meta.title == "song"


def test_add_upload_rejects_an_unknown_extension(store: SongStore) -> None:
    part = store.incoming_path()
    part.write_bytes(b"x")
    meta = SongMeta(source="file")
    with pytest.raises(ValueError, match="extension"):
        store.add_upload("6" * 64, part, ".exe", meta, initial_status("6" * 64, meta))
    assert not store.exists("6" * 64)


def test_incoming_paths_are_unique_part_files_under_the_cache(
    store: SongStore,
) -> None:
    first, second = store.incoming_path(), store.incoming_path()
    assert first != second
    assert first.suffix == ".part"
    assert first.parent == store.root / ".incoming"
    assert first.parent.is_dir()


def test_clear_incoming_removes_only_part_files(store: SongStore) -> None:
    assert store.clear_incoming() == 0
    part = store.incoming_path()
    part.write_bytes(b"half an upload")
    keep = store.root / ".incoming" / "notes.txt"
    keep.write_text("keep", "utf-8")
    assert store.clear_incoming() == 1
    assert not part.exists()
    assert keep.exists()


def test_recover_interrupted_fails_running_steps_and_leaves_the_rest(
    store: SongStore, new_song: Callable
) -> None:
    interrupted = new_song(b"one")
    finished = new_song(b"two")
    store.update_step(interrupted, "separation", state="running", progress=0.4)
    store.update_step(finished, "separation", state="done", progress=1.0)
    before = store.read_status(finished)

    assert store.recover_interrupted() == [interrupted]

    status = store.read_status(interrupted)
    assert status is not None
    step = status.steps.separation
    assert step.state == "failed"
    assert step.error == (
        "Interrupted: the service stopped while this step ran. "
        "Add the song again to retry."
    )
    assert step.error == INTERRUPTED_MESSAGE
    assert step.progress == 0.4  # where it stopped
    assert status.steps.reference.state == "queued"
    assert status.steps.fetch.state == "skipped"
    assert store.read_status(finished) == before
    # Nothing is left running, so a second pass finds nothing.
    assert store.recover_interrupted() == []


def test_recover_interrupted_ignores_what_is_not_a_song(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song()
    store.incoming_path()  # makes .incoming
    (store.root / "notes").mkdir()
    (store.root / "stray.txt").write_text("x", "utf-8")
    broken = store.song_dir("7" * 64)
    broken.mkdir()
    (broken / "status.json").write_text("{not json", "utf-8")
    assert store.recover_interrupted() == []
    assert store.exists(song_id)


def test_recover_interrupted_copes_with_a_missing_cache(tmp_path: Path) -> None:
    assert SongStore(tmp_path / "never-made").recover_interrupted() == []


def test_ids_waiting_to_run_lists_songs_with_a_queued_step_and_no_failure(
    store: SongStore, new_song: Callable
) -> None:
    fresh = new_song(b"fresh")  # every step but fetch still queued
    partly = new_song(b"partly")
    store.update_step(partly, "separation", state="done", progress=1.0)
    settled = new_song(b"settled")
    for step in ("separation", "reference", "lyrics"):
        store.update_step(settled, step, state="skipped")
    failed = new_song(b"failed")
    store.update_step(failed, "separation", state="failed", error="no")

    # Name order, so the result does not depend on how the disk lists folders.
    assert store.ids_waiting_to_run() == sorted([fresh, partly])
    assert settled not in store.ids_waiting_to_run()
    assert failed not in store.ids_waiting_to_run()


def test_a_song_whose_step_was_interrupted_is_not_waiting_to_run(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song()
    store.update_step(song_id, "separation", state="running", progress=0.4)
    store.recover_interrupted()

    status = store.read_status(song_id)
    assert status is not None
    # Its later steps are still queued, but resuming would run the step that
    # was in flight when the service stopped. Adding the song again does that.
    assert status.steps.reference.state == "queued"
    assert store.ids_waiting_to_run() == []


def test_ids_waiting_to_run_ignores_what_is_not_a_song(
    store: SongStore, new_song: Callable
) -> None:
    song_id = new_song()
    store.incoming_path()  # makes .incoming
    (store.root / "notes").mkdir()
    (store.root / "stray.txt").write_text("x", "utf-8")
    broken = store.song_dir("7" * 64)
    broken.mkdir()
    (broken / "status.json").write_text("{not json", "utf-8")
    assert store.ids_waiting_to_run() == [song_id]


def test_ids_waiting_to_run_copes_with_a_missing_cache(tmp_path: Path) -> None:
    assert SongStore(tmp_path / "never-made").ids_waiting_to_run() == []
