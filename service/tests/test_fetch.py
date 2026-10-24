"""Tests for the fetch step: download, convert, install, and each way to fail.

The runner reaches YouTube only through `youtube.download_audio` and
`youtube.to_flac`, which these tests replace with fakes, so nothing here
touches the network or runs ffmpeg. The fake conversion writes a real FLAC, so
the runner measures a real length from it.
"""

from collections.abc import Callable
from pathlib import Path

import pytest
import soundfile as sf

from encore_service import fetch, pipeline, youtube
from encore_service.config import Settings
from encore_service.fetch import FetchError, fetch_source
from encore_service.pipeline import initial_status, prepare
from encore_service.store import SongMeta, SongStore
from tests.fakes import RATE, SECONDS, FetchFakes, Ydl

VIDEO_ID = "dQw4w9WgXcQ"
UPDATE_HINT = (
    "If YouTube links keep failing, update yt-dlp: "
    "cd service && uv lock --upgrade-package yt-dlp && uv sync --inexact"
)


@pytest.fixture(autouse=True)
def runtime(node_only: dict[str, dict[str, str]]) -> None:
    """Every test here runs as if Node were on PATH."""


def song_files(store: SongStore, song_id: str) -> list[str]:
    return sorted(path.name for path in store.song_dir(song_id).iterdir())


def test_fetch_installs_the_audio_as_source_flac(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    song_id = new_link(VIDEO_ID)
    folder = store.song_dir(song_id)

    fetch_source(store, song_id, lambda value: None)

    source = folder / "source.flac"
    assert store.source_path(song_id) == source
    info = sf.info(str(source))
    assert (info.format, info.samplerate) == ("FLAC", RATE)
    assert info.duration == pytest.approx(SECONDS, abs=0.01)
    # Only the song's own files remain: the scratch folder is gone.
    assert song_files(store, song_id) == ["meta.json", "source.flac", "status.json"]

    [(video_id, dest_dir, settings)] = fakes.downloads
    assert (video_id, dest_dir) == (VIDEO_ID, folder / ".fetch")
    assert isinstance(settings, Settings)
    assert fakes.conversions == [
        (folder / ".fetch" / "download.webm", folder / ".fetch" / "source.flac")
    ]


def test_fetch_reports_steady_progress_ending_at_one(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    song_id = new_link(VIDEO_ID)
    reports: list[float] = []

    fetch_source(store, song_id, reports.append)

    # The download's own share, then the conversion, then the saved file.
    assert reports == [0.2, 0.85, 0.95, 1.0]
    assert reports == sorted(reports)


def test_fetch_records_the_length_the_audio_really_has(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    song_id = new_link(VIDEO_ID)  # the link said 200 s
    before = store.read_status(song_id)
    assert before is not None and before.duration_s == 200.0

    fetch_source(store, song_id, lambda value: None)

    meta = store.read_meta(song_id)
    status = store.read_status(song_id)
    assert meta is not None and status is not None
    assert meta.duration_s == pytest.approx(SECONDS, abs=0.01)
    assert status.duration_s == meta.duration_s
    # Nothing else about the song changed.
    assert (meta.title, meta.url, meta.video_id) == (
        "Linked",
        f"https://youtu.be/{VIDEO_ID}",
        VIDEO_ID,
    )
    assert status.steps == before.steps
    assert (status.title, status.source) == (before.title, before.source)


def test_fetch_clears_what_an_earlier_attempt_left_in_its_scratch_folder(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    song_id = new_link(VIDEO_ID)
    work = store.song_dir(song_id) / ".fetch"
    (work / "nested").mkdir(parents=True)
    (work / "download.webm").write_bytes(b"a crashed run's file")
    (work / "nested" / "x").write_bytes(b"x")

    fetch_source(store, song_id, lambda value: None)

    assert fakes.in_work_dir == [[]]
    assert not work.exists()


def test_a_failed_download_names_what_failed_and_how_to_update(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    fakes.download_error = youtube.YtDlpError("[youtube] x: Video unavailable")
    song_id = new_link(VIDEO_ID)

    with pytest.raises(FetchError) as raised:
        fetch_source(store, song_id, lambda value: None)

    assert str(raised.value) == (
        "Downloading from YouTube failed: [youtube] x: Video unavailable. "
        + UPDATE_HINT
    )
    assert isinstance(raised.value.__cause__, youtube.YtDlpError)
    assert song_files(store, song_id) == ["meta.json", "status.json"]
    assert store.source_path(song_id) is None
    assert fakes.conversions == []


def test_a_failed_download_without_a_javascript_runtime_says_so(
    store: SongStore,
    new_link: Callable,
    fakes: FetchFakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(youtube, "js_runtimes", dict)
    fakes.download_error = youtube.YtDlpError("Sign in to confirm you are not a bot")

    with pytest.raises(FetchError) as raised:
        fetch_source(store, new_link(VIDEO_ID), lambda value: None)

    message = str(raised.value)
    assert youtube.NO_RUNTIME_NOTE in message
    assert message.endswith(UPDATE_HINT)


def test_a_failed_conversion_names_ffmpeg_and_does_not_blame_yt_dlp(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    fakes.convert_error = youtube.FfmpegError(youtube.FFMPEG_MISSING)
    song_id = new_link(VIDEO_ID)

    with pytest.raises(FetchError) as raised:
        fetch_source(store, song_id, lambda value: None)

    assert str(raised.value) == (
        "Converting the download to FLAC failed: "
        "ffmpeg is not on PATH; see service/README.md (GPU setup, step 1)"
    )
    assert "yt-dlp" not in str(raised.value)
    assert song_files(store, song_id) == ["meta.json", "status.json"]


def test_a_conversion_that_ffmpeg_rejects_carries_its_message(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    fakes.convert_error = youtube.FfmpegError(
        "ffmpeg failed (exit status 1): Invalid data found when processing input"
    )
    with pytest.raises(FetchError) as raised:
        fetch_source(store, new_link(VIDEO_ID), lambda value: None)
    assert str(raised.value) == (
        "Converting the download to FLAC failed: "
        "ffmpeg failed (exit status 1): Invalid data found when processing input"
    )


def test_any_other_failure_in_the_download_is_worded_the_same_way(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    fakes.download_error = OSError("No space left on device")
    song_id = new_link(VIDEO_ID)

    with pytest.raises(FetchError) as raised:
        fetch_source(store, song_id, lambda value: None)

    # Not yt-dlp's doing, so no advice to update it.
    assert (
        str(raised.value) == "Downloading from YouTube failed: No space left on device"
    )
    assert song_files(store, song_id) == ["meta.json", "status.json"]


def test_a_cache_folder_yt_dlp_would_expand_fails_with_the_reason(
    tmp_path: Path, ydl: Ydl, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ZZ_ENCORE_SET", "EXPANDED")
    store = SongStore(tmp_path / "cache$ZZ_ENCORE_SET")
    song_id = f"yt-{VIDEO_ID}"
    meta = SongMeta(
        source="youtube", title="Linked", video_id=VIDEO_ID, duration_s=200.0
    )
    store.song_dir(song_id).mkdir(parents=True)
    store.write_meta(song_id, meta)
    store.write_status(song_id, initial_status(song_id, meta))

    with pytest.raises(FetchError) as raised:
        fetch_source(store, song_id, lambda value: None)

    # Worded for the person who set ENCORE_CACHE_DIR, and no advice to update
    # yt-dlp, which would change nothing.
    message = str(raised.value)
    assert message.startswith(
        "Downloading from YouTube failed: yt-dlp would save into "
    )
    assert message.endswith("Set ENCORE_CACHE_DIR to a path without a $.")
    assert "update yt-dlp" not in message
    assert ydl.downloaded == []
    assert song_files(store, song_id) == ["meta.json", "status.json"]


def test_an_error_with_no_message_still_says_something(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    fakes.download_error = TimeoutError()
    with pytest.raises(
        FetchError, match=r"^Downloading from YouTube failed: TimeoutError$"
    ):
        fetch_source(store, new_link(VIDEO_ID), lambda value: None)


def test_audio_that_cannot_be_read_is_never_installed(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    fakes.unreadable_audio = True
    song_id = new_link(VIDEO_ID)

    with pytest.raises(FetchError, match="^Reading the converted audio failed: "):
        fetch_source(store, song_id, lambda value: None)

    assert song_files(store, song_id) == ["meta.json", "status.json"]


def test_a_failed_refetch_leaves_the_earlier_source_alone(
    store: SongStore, new_link: Callable, fakes: FetchFakes
) -> None:
    song_id = new_link(VIDEO_ID)
    source = store.song_dir(song_id) / "source.flac"
    source.write_bytes(b"fLaC the earlier download")
    fakes.convert_error = youtube.FfmpegError("ffmpeg failed (exit status 1)")

    with pytest.raises(FetchError):
        fetch_source(store, song_id, lambda value: None)

    assert source.read_bytes() == b"fLaC the earlier download"
    assert not (store.song_dir(song_id) / ".fetch").exists()


def test_a_failure_while_saving_is_worded_like_the_others(
    store: SongStore,
    new_link: Callable,
    fakes: FetchFakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(song_id: str, finished: Path, ext: str) -> Path:
        raise PermissionError("held open by a scanner")

    song_id = new_link(VIDEO_ID)
    monkeypatch.setattr(store, "install_source", refuse)

    with pytest.raises(FetchError, match="^Saving the audio failed: held open"):
        fetch_source(store, song_id, lambda value: None)

    assert song_files(store, song_id) == ["meta.json", "status.json"]


def test_a_song_without_a_video_cannot_be_fetched(
    store: SongStore, new_song: Callable, fakes: FetchFakes
) -> None:
    song_id = new_song()  # an upload: no video id
    with pytest.raises(FetchError, match="no YouTube video"):
        fetch_source(store, song_id, lambda value: None)
    assert fakes.downloads == []
    assert song_files(store, song_id) == ["meta.json", "source.wav", "status.json"]


def test_a_song_that_is_gone_cannot_be_fetched(
    store: SongStore, fakes: FetchFakes
) -> None:
    with pytest.raises(FetchError, match="no YouTube video"):
        fetch_source(store, "yt-dQw4w9WgXcQ", lambda value: None)


# --- through the pipeline ---------------------------------------------------


def test_the_fetch_runner_is_the_one_registered_for_the_fetch_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.undo()  # the real registry, not the emptied one
    assert pipeline.RUNNERS["fetch"] is fetch.fetch_source


def test_prepare_marks_a_fetched_link_done_and_moves_on(
    store: SongStore,
    new_link: Callable,
    fakes: FetchFakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "fetch", fetch_source)
    separated: list[Path | None] = []

    def separate(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        separated.append(s.source_path(sid))

    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate)
    song_id = new_link(VIDEO_ID)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.fetch.state, status.steps.fetch.progress) == ("done", 1.0)
    assert status.steps.separation.state == "done"
    # Separation found the audio in place when it started.
    assert separated == [store.song_dir(song_id) / "source.flac"]
    assert status.duration_s == pytest.approx(SECONDS, abs=0.01)


def test_prepare_marks_a_failed_fetch_failed_with_the_message(
    store: SongStore,
    new_link: Callable,
    fakes: FetchFakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "fetch", fetch_source)
    separated: list[str] = []
    monkeypatch.setitem(
        pipeline.RUNNERS, "separation", lambda s, sid, report: separated.append(sid)
    )
    fakes.download_error = youtube.YtDlpError("HTTP Error 403: Forbidden")
    song_id = new_link(VIDEO_ID)

    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert status.steps.fetch.state == "failed"
    assert status.steps.fetch.error == (
        "Downloading from YouTube failed: HTTP Error 403: Forbidden. " + UPDATE_HINT
    )
    assert status.steps.separation.detail == "Needs fetch"
    assert separated == []
    assert song_files(store, song_id) == ["meta.json", "status.json"]


def test_a_failed_fetch_is_retried_by_preparing_again(
    store: SongStore,
    new_link: Callable,
    fakes: FetchFakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "fetch", fetch_source)
    fakes.download_error = youtube.YtDlpError("HTTP Error 403: Forbidden")
    song_id = new_link(VIDEO_ID)
    prepare(store, song_id)

    fakes.download_error = None
    prepare(store, song_id)

    status = store.read_status(song_id)
    assert status is not None
    assert (status.steps.fetch.state, status.steps.fetch.error) == ("done", None)
    assert store.source_path(song_id) is not None
