"""HTTP tests for song intake: upload, status, audio and restart recovery.

Each test runs the app's real lifespan (`with TestClient(app)`), so the store
and the job queue are the ones the service uses, over a temporary cache.
"""

import hashlib
import io
import json
import logging
import threading
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from encore_service import pipeline
from encore_service.app import create_app
from encore_service.config import Settings
from encore_service.routes import songs
from encore_service.store import (
    AUDIO_MEDIA_TYPES,
    INTERRUPTED_MESSAGE,
    SongStore,
)

RATE = 48_000
SECONDS = 0.5
WAIT_S = 10.0


def make_wav(hz: float = 440.0) -> bytes:
    """Half a second of a sine at 48 kHz, so its duration is known."""
    t = np.arange(int(SECONDS * RATE)) / RATE
    buffer = io.BytesIO()
    sf.write(
        buffer,
        0.3 * np.sin(2 * np.pi * hz * t),
        RATE,
        format="WAV",
        subtype="PCM_16",
    )
    return buffer.getvalue()


WAV = make_wav()
WAV_ID = hashlib.sha256(WAV).hexdigest()
# Different bytes, so a different song.
OTHER_WAV = make_wav(330.0)


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        yield client


def post(
    client: TestClient, name: str = "tone.wav", data: bytes = WAV
) -> httpx.Response:
    return client.post("/songs", files={"file": (name, data, "audio/wav")})


def wait_idle(client: TestClient) -> None:
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)


def song_folders(cache: Path) -> list[str]:
    return sorted(
        p.name for p in cache.iterdir() if p.is_dir() and p.name != ".incoming"
    )


def test_upload_returns_a_status_named_by_the_hash(
    client: TestClient, tmp_path: Path
) -> None:
    response = post(client)

    assert response.status_code == 200
    body = response.json()
    assert body["song_id"] == hashlib.sha256(WAV).hexdigest()
    assert body["source"] == "file"
    assert body["title"] == "tone"
    assert body["duration_s"] == pytest.approx(SECONDS, abs=1e-3)
    assert body["steps"]["fetch"] == {
        "state": "skipped",
        "progress": 0.0,
        "error": None,
        "detail": None,
    }
    assert song_folders(tmp_path) == [body["song_id"]]
    folder = tmp_path / body["song_id"]
    assert (folder / "source.wav").read_bytes() == WAV
    assert json.loads((folder / "meta.json").read_text("utf-8")) == {
        "source": "file",
        "title": "tone",
        "url": None,
        "duration_s": body["duration_s"],
        "video_id": None,
    }


def test_the_other_steps_are_skipped_as_not_built_once_the_queue_drains(
    client: TestClient,
) -> None:
    song_id = post(client).json()["song_id"]
    wait_idle(client)

    steps = client.get(f"/songs/{song_id}").json()["steps"]
    assert steps["fetch"]["state"] == "skipped"
    assert steps["fetch"]["detail"] is None
    for name, task in (
        ("separation", "P2-T2"),
        ("reference", "P2-T3"),
        ("lyrics", "P2-T4"),
    ):
        assert steps[name]["state"] == "skipped"
        assert steps[name]["detail"] == f"Not built yet (ROADMAP {task})"
        assert steps[name]["error"] is None


def test_adding_the_same_bytes_again_is_a_cache_hit(
    client: TestClient, tmp_path: Path
) -> None:
    first = post(client, "tone.wav").json()
    wait_idle(client)
    second = post(client, "renamed copy.wav")

    assert second.status_code == 200
    assert second.json()["song_id"] == first["song_id"]
    # The cached song keeps its first title; nothing was stored twice.
    assert second.json()["title"] == "tone"
    assert song_folders(tmp_path) == [first["song_id"]]
    assert list((tmp_path / ".incoming").iterdir()) == []


def test_a_cache_hit_gives_unfinished_steps_another_go(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    song_id = post(client).json()["song_id"]
    wait_idle(client)
    before = client.get(f"/songs/{song_id}").json()["steps"]
    assert before["separation"]["state"] == "skipped"

    # Separation gains a runner, as it will in P2-T2; adding the song again
    # runs it without touching the steps that are still not built.
    monkeypatch.setitem(pipeline.RUNNERS, "separation", lambda *args: None)
    assert post(client).json()["song_id"] == song_id
    wait_idle(client)

    steps = client.get(f"/songs/{song_id}").json()["steps"]
    assert steps["separation"]["state"] == "done"
    assert steps["reference"]["detail"] == "Not built yet (ROADMAP P2-T3)"


def test_status_shows_live_progress_and_a_repeat_does_not_double_run(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    reported, release = threading.Event(), threading.Event()
    runs: list[str] = []

    def separate(
        store: SongStore, song_id: str, report: Callable[[float], None]
    ) -> None:
        runs.append(song_id)
        report(0.5)
        reported.set()
        assert release.wait(WAIT_S)

    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate)
    song_id = post(client).json()["song_id"]
    assert reported.wait(WAIT_S)

    # The worker is mid-step, yet the status answers at once with its progress.
    step = client.get(f"/songs/{song_id}").json()["steps"]["separation"]
    assert (step["state"], step["progress"]) == ("running", 0.5)
    # Adding the song again now neither blocks nor starts a second run.
    again = post(client).json()
    assert again["steps"]["separation"]["state"] == "running"

    release.set()
    wait_idle(client)
    assert runs == [song_id]
    step = client.get(f"/songs/{song_id}").json()["steps"]["separation"]
    assert (step["state"], step["progress"]) == ("done", 1.0)


def test_get_reports_the_status_of_a_known_song(client: TestClient) -> None:
    song_id = post(client).json()["song_id"]
    wait_idle(client)
    response = client.get(f"/songs/{song_id}")
    assert response.status_code == 200
    assert response.json()["song_id"] == song_id
    assert response.json()["title"] == "tone"


def test_get_of_an_unknown_id_is_404(client: TestClient) -> None:
    response = client.get("/songs/" + "0" * 64)
    assert response.status_code == 404
    assert response.json() == {"detail": "No such song."}
    assert client.get("/songs/yt-dQw4w9WgXcQ").status_code == 404


BAD_IDS = [
    "..",
    "..%2F..",
    "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
    "..%5C..%5Cwindows",
    "not-an-id",
    "A" * 64,
    "g" * 64,
    "0" * 63,
    "0" * 65,
    "0" * 64 + "%0A",
    "yt-short",
    "yt-" + "a" * 12,
]


@pytest.mark.parametrize("song_id", BAD_IDS)
def test_malformed_and_traversal_ids_are_404(client: TestClient, song_id: str) -> None:
    assert client.get(f"/songs/{song_id}").status_code == 404
    assert client.get(f"/songs/{song_id}/audio").status_code == 404


@pytest.mark.parametrize("song_id", ["not-an-id", "A" * 64, "yt-short"])
def test_a_malformed_id_gets_the_same_answer_as_an_unknown_one(
    client: TestClient, song_id: str
) -> None:
    unknown = client.get("/songs/" + "0" * 64)
    malformed = client.get(f"/songs/{song_id}")
    assert (malformed.status_code, malformed.json()) == (404, unknown.json())
    audio = client.get(f"/songs/{song_id}/audio")
    assert (audio.status_code, audio.json()) == (404, unknown.json())


def test_audio_serves_the_stored_bytes(client: TestClient) -> None:
    song_id = post(client).json()["song_id"]
    response = client.get(f"/songs/{song_id}/audio")
    assert response.status_code == 200
    assert response.content == WAV
    assert response.headers["content-type"] == "audio/wav"


def test_audio_supports_range_requests_for_seeking(client: TestClient) -> None:
    song_id = post(client).json()["song_id"]
    response = client.get(f"/songs/{song_id}/audio", headers={"Range": "bytes=0-43"})
    assert response.status_code == 206
    assert response.content == WAV[:44]


@pytest.mark.parametrize("ext", sorted(AUDIO_MEDIA_TYPES))
def test_every_accepted_type_is_stored_and_served_with_its_media_type(
    client: TestClient, tmp_path: Path, ext: str
) -> None:
    data = b"not decodable audio, but " + ext.encode()
    response = post(client, f"Song{ext.upper()}", data)

    assert response.status_code == 200, response.text
    body = response.json()
    # soundfile cannot read these bytes, which is fine: duration is a nicety.
    assert body["duration_s"] is None
    assert body["title"] == "Song"
    assert (tmp_path / body["song_id"] / f"source{ext}").read_bytes() == data
    audio = client.get(f"/songs/{body['song_id']}/audio")
    assert audio.content == data
    assert audio.headers["content-type"] == AUDIO_MEDIA_TYPES[ext]


def test_audio_is_409_when_the_song_has_no_source_yet(
    client: TestClient, tmp_path: Path
) -> None:
    song_id = post(client).json()["song_id"]
    (tmp_path / song_id / "source.wav").unlink()
    response = client.get(f"/songs/{song_id}/audio")
    assert response.status_code == 409
    assert response.json() == {"detail": "Song not fetched yet."}


def test_adding_the_file_again_puts_back_audio_that_went_missing(
    client: TestClient, tmp_path: Path
) -> None:
    song_id = post(client).json()["song_id"]
    wait_idle(client)
    (tmp_path / song_id / "source.wav").unlink()
    assert client.get(f"/songs/{song_id}/audio").status_code == 409

    again = post(client, "tone copy.wav")
    wait_idle(client)

    assert again.status_code == 200
    assert again.json()["song_id"] == song_id
    assert again.json()["title"] == "tone"  # the song keeps its first name
    audio = client.get(f"/songs/{song_id}/audio")
    assert (audio.status_code, audio.content) == (200, WAV)
    assert song_folders(tmp_path) == [song_id]
    assert list((tmp_path / ".incoming").iterdir()) == []


def test_a_type_that_is_not_audio_is_415_and_leaves_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    response = post(client, "notes.txt", b"hello")
    assert response.status_code == 415
    detail = response.json()["detail"]
    for ext in (".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"):
        assert ext in detail
    assert song_folders(tmp_path) == []
    assert not (tmp_path / ".incoming").exists() or not list(
        (tmp_path / ".incoming").iterdir()
    )


@pytest.mark.parametrize("name", ["song", ".wav", "song.wav.exe", "song.mp3.txt"])
def test_a_name_without_an_accepted_extension_is_415(
    client: TestClient, name: str
) -> None:
    assert post(client, name, WAV).status_code == 415


def test_an_upload_with_no_file_name_is_refused(
    client: TestClient, tmp_path: Path
) -> None:
    # The multipart parser reads a nameless part as a plain form field, so
    # the framework answers before the route runs; either way, nothing is kept.
    assert post(client, "", WAV).status_code in (415, 422)
    assert song_folders(tmp_path) == []


def test_an_empty_upload_is_400_and_leaves_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    response = post(client, "silence.wav", b"")
    assert response.status_code == 400
    assert song_folders(tmp_path) == []
    assert list((tmp_path / ".incoming").iterdir()) == []


def test_an_oversized_upload_is_413_and_leaves_no_part_file(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(songs, "MAX_UPLOAD_BYTES", 1000)
    response = post(client, "big.wav", b"x" * 1001)
    assert response.status_code == 413
    assert song_folders(tmp_path) == []
    assert list((tmp_path / ".incoming").iterdir()) == []


def test_an_upload_at_the_limit_is_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(songs, "MAX_UPLOAD_BYTES", 1000)
    assert post(client, "edge.wav", b"x" * 1000).status_code == 200


def test_the_limit_is_checked_across_chunks(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Small chunks, so the total only crosses the limit on a later read.
    monkeypatch.setattr(songs, "_CHUNK_BYTES", 100)
    monkeypatch.setattr(songs, "MAX_UPLOAD_BYTES", 450)
    assert post(client, "big.wav", b"x" * 451).status_code == 413
    assert list((tmp_path / ".incoming").iterdir()) == []
    assert post(client, "ok.wav", b"y" * 450).status_code == 200


def test_the_upload_is_hashed_whatever_the_chunk_size(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(songs, "_CHUNK_BYTES", 1000)
    assert post(client).json()["song_id"] == WAV_ID


def test_a_missing_file_field_is_422(client: TestClient) -> None:
    assert client.post("/songs").status_code == 422


@pytest.mark.parametrize(
    ("filename", "title"),
    [
        ("Tone.WAV", "Tone"),
        ("My Song (live).mp3", "My Song (live)"),
        ("  padded  .wav", "padded"),
        ("C:\\music\\Windows Path.flac", "Windows Path"),
        ("some/dir/Posix Path.ogg", "Posix Path"),
        ("Caf\u00e9 \u2014 \u6b4c.opus", "Caf\u00e9 \u2014 \u6b4c"),
        ("a.b.c.m4a", "a.b.c"),
        (" .wav", None),
    ],
)
def test_the_title_comes_from_the_file_name(
    client: TestClient, filename: str, title: str | None
) -> None:
    body = post(client, filename, WAV).json()
    assert body["title"] == title


def test_a_long_title_is_capped(client: TestClient) -> None:
    body = post(client, "a" * 300 + ".wav").json()
    assert body["title"] == "a" * 200


def test_a_title_cut_inside_a_gap_does_not_end_in_space(client: TestClient) -> None:
    body = post(client, "a" * 199 + " tail.wav").json()
    assert body["title"] == "a" * 199


def test_openapi_describes_the_song_routes(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    assert {"/songs", "/songs/{song_id}", "/songs/{song_id}/audio"} <= set(
        spec["paths"]
    )
    step_properties = spec["components"]["schemas"]["SongSteps"]["properties"]
    assert list(step_properties) == ["fetch", "separation", "reference", "lyrics"]
    assert "detail" in spec["components"]["schemas"]["StepStatus"]["properties"]


def test_lifespan_creates_the_cache_and_runs_the_queue(tmp_path: Path) -> None:
    cache = tmp_path / "nested" / "cache"
    app = create_app(Settings(cache_dir=cache))
    with TestClient(app):
        assert cache.is_dir()
        assert isinstance(app.state.store, SongStore)
        assert app.state.jobs.running
    assert not app.state.jobs.running


def test_start_clears_part_files_left_by_a_crash(tmp_path: Path) -> None:
    stale = tmp_path / ".incoming" / "dead.part"
    stale.parent.mkdir()
    stale.write_bytes(b"half an upload")
    with TestClient(create_app(Settings(cache_dir=tmp_path))):
        pass
    assert not stale.exists()


def test_a_step_left_running_fails_on_the_next_start(tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path)
    with TestClient(create_app(settings)) as first:
        song_id = post(first).json()["song_id"]
        wait_idle(first)

    # What a crash mid-separation leaves behind.
    path = tmp_path / song_id / "status.json"
    data = json.loads(path.read_text("utf-8"))
    data["steps"]["separation"].update(state="running", progress=0.3, detail=None)
    path.write_text(json.dumps(data), encoding="utf-8")

    with TestClient(create_app(settings)) as second:
        steps = second.get(f"/songs/{song_id}").json()["steps"]

    assert steps["separation"]["state"] == "failed"
    assert steps["separation"]["error"] == INTERRUPTED_MESSAGE
    assert steps["separation"]["progress"] == 0.3
    # Only the step that was running changed.
    assert steps["reference"]["detail"] == "Not built yet (ROADMAP P2-T3)"


def test_songs_queued_when_the_service_stopped_are_prepared_on_the_next_start(
    tmp_path: Path, new_song: Callable[..., str], monkeypatch: pytest.MonkeyPatch
) -> None:
    # What a stop between "status written" and "job ran" leaves in the cache:
    # songs with every step still queued and no job to run them.
    first, second = new_song(WAV), new_song(OTHER_WAV)
    prepared: list[str] = []

    def separate(
        store: SongStore, song_id: str, report: Callable[[float], None]
    ) -> None:
        prepared.append(song_id)

    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate)

    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        wait_idle(client)
        for song_id in (first, second):
            steps = client.get(f"/songs/{song_id}").json()["steps"]
            # Every step has settled; none is left reading "queued".
            assert {step["state"] for step in steps.values()} <= {"done", "skipped"}
            assert steps["separation"]["state"] == "done"
            assert steps["reference"]["detail"] == "Not built yet (ROADMAP P2-T3)"

    assert sorted(prepared) == sorted([first, second])


def test_a_song_that_cannot_be_resumed_does_not_stop_the_service_starting(
    tmp_path: Path,
    new_song: Callable[..., str],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The queue runs songs in name order; the broken one is the first.
    broken, healthy = sorted([new_song(WAV), new_song(OTHER_WAV)])
    prepared: list[str] = []
    real_reset = pipeline._reset_unfinished

    def reset(store: SongStore, song_id: str) -> object:
        if song_id == broken:
            raise OSError("the disk would not answer")
        return real_reset(store, song_id)

    def separate(
        store: SongStore, song_id: str, report: Callable[[float], None]
    ) -> None:
        prepared.append(song_id)

    monkeypatch.setattr(pipeline, "_reset_unfinished", reset)
    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate)

    with caplog.at_level(logging.INFO, logger="encore_service.app"):
        with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
            wait_idle(client)
            steps = client.get(f"/songs/{healthy}").json()["steps"]
            assert steps["separation"]["state"] == "done"

    # The healthy song was resumed, the broken one was not queued at all, and
    # the log says which one and why.
    assert prepared == [healthy]
    assert f"Could not resume song {broken}" in caplog.text
    assert "the disk would not answer" in caplog.text
    assert "Resuming preparation for 1 queued song(s)" in caplog.text


def test_a_song_with_an_interrupted_step_waits_to_be_added_again(
    tmp_path: Path,
    new_song: Callable[..., str],
    store: SongStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    song_id = new_song(WAV)
    # What a stop mid-separation leaves; reference and lyrics stay queued.
    store.update_step(song_id, "separation", state="running", progress=0.3)
    ran: list[str] = []

    def separate(s: SongStore, sid: str, report: Callable[[float], None]) -> None:
        ran.append(sid)

    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate)
    settings = Settings(cache_dir=tmp_path)

    # Twice: the first start turns "running" into "failed" and the second finds
    # it failed already. Neither resumes the song, so the step that may have
    # stopped the service does not run again on every start.
    for _ in range(2):
        with TestClient(create_app(settings)) as client:
            wait_idle(client)
            steps = client.get(f"/songs/{song_id}").json()["steps"]
            assert steps["separation"]["state"] == "failed"
            assert steps["separation"]["error"] == INTERRUPTED_MESSAGE
            assert steps["reference"]["state"] == "queued"
    assert ran == []

    # Adding the song again is the retry the error message asks for.
    with TestClient(create_app(settings)) as client:
        assert post(client).json()["song_id"] == song_id
        wait_idle(client)
        steps = client.get(f"/songs/{song_id}").json()["steps"]
    assert steps["separation"]["state"] == "done"
    assert steps["separation"]["error"] is None
    assert steps["reference"]["detail"] == "Not built yet (ROADMAP P2-T3)"
    assert ran == [song_id]


def test_songs_survive_a_restart(tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path)
    with TestClient(create_app(settings)) as first:
        song_id = post(first).json()["song_id"]
        wait_idle(first)
    with TestClient(create_app(settings)) as second:
        assert second.get(f"/songs/{song_id}").json()["title"] == "tone"
        assert second.get(f"/songs/{song_id}/audio").content == WAV


def test_a_failed_step_reads_queued_in_the_re_add_response(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail_first(
        store: SongStore, song_id: str, report: Callable[[float], None]
    ) -> None:
        raise RuntimeError("first failure")

    monkeypatch.setitem(pipeline.RUNNERS, "separation", fail_first)
    song_id = post(client).json()["song_id"]
    wait_idle(client)
    failed = client.get(f"/songs/{song_id}").json()["steps"]["separation"]
    assert (failed["state"], failed["error"]) == ("failed", "first failure")

    def fail_second(
        store: SongStore, song_id: str, report: Callable[[float], None]
    ) -> None:
        raise RuntimeError("second failure")

    monkeypatch.setitem(pipeline.RUNNERS, "separation", fail_second)
    steps = post(client).json()["steps"]

    # The retry is queued, so the failure is not shown beside it.
    queued = {"state": "queued", "progress": 0.0, "error": None, "detail": None}
    assert steps["separation"] == queued
    assert steps["reference"] == queued  # it had been skipped for want of audio
    assert steps["lyrics"] == queued
    assert steps["fetch"]["state"] == "skipped"  # an upload has no fetch
    wait_idle(client)
    after = client.get(f"/songs/{song_id}").json()["steps"]["separation"]
    assert (after["state"], after["error"]) == ("failed", "second failure")


def test_a_re_add_of_a_running_song_returns_its_status_unchanged(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    reported, release = threading.Event(), threading.Event()

    def separate(
        store: SongStore, song_id: str, report: Callable[[float], None]
    ) -> None:
        report(0.5)
        reported.set()
        assert release.wait(WAIT_S)

    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate)
    song_id = post(client).json()["song_id"]
    assert reported.wait(WAIT_S)
    running = client.get(f"/songs/{song_id}").json()
    assert running["steps"]["separation"]["state"] == "running"

    again = post(client)

    assert again.json() == running
    assert client.get(f"/songs/{song_id}").json() == running
    release.set()
    wait_idle(client)


def test_a_song_resumed_at_start_does_not_read_as_skipped_while_it_waits(
    tmp_path: Path, new_song: Callable[..., str], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The queue runs songs in name order, so the first one holds up the second.
    first, second = sorted([new_song(WAV), new_song(OTHER_WAV)])
    store = SongStore(tmp_path)
    # What an earlier run left: a step skipped as "not built yet" next to
    # steps still queued, which is why the song is resumed at all.
    store.update_step(
        second, "separation", state="skipped", detail="Not built yet (ROADMAP P2-T2)"
    )
    started, release = threading.Event(), threading.Event()

    def separate(
        store: SongStore, song_id: str, report: Callable[[float], None]
    ) -> None:
        if song_id == first:
            started.set()
            assert release.wait(WAIT_S)

    monkeypatch.setitem(pipeline.RUNNERS, "separation", separate)

    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        assert started.wait(WAIT_S)
        waiting = client.get(f"/songs/{second}").json()["steps"]["separation"]
        # Its turn has not come, and it no longer carries the old note.
        assert waiting == {
            "state": "queued",
            "progress": 0.0,
            "error": None,
            "detail": None,
        }
        release.set()
        wait_idle(client)
        done = client.get(f"/songs/{second}").json()["steps"]["separation"]

    assert done["state"] == "done"
    assert done["detail"] is None
