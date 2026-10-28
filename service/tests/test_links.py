"""HTTP tests for POST /songs/url: the checks, the song it makes, the failures.

`youtube.lookup` is replaced with a fake that answers from a `Lookups`
object, so no request reaches YouTube. A few tests use the real `lookup` over
the fake `YoutubeDL` instead, to prove what the route does with each answer
yt-dlp can give. The app runs with its real lifespan, store and job queue over
a temporary cache.
"""

import json
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
import soundfile as sf
import yt_dlp
from fastapi.testclient import TestClient

from encore_service import pipeline, youtube
from encore_service.app import create_app
from encore_service.config import Settings
from encore_service.fetch import fetch_source
from encore_service.store import INTERRUPTED_MESSAGE
from tests.fakes import SECONDS, FetchFakes, Ydl

WAIT_S = 10.0
VIDEO_ID = "aqz-KE-bpKQ"
SONG_ID = f"yt-{VIDEO_ID}"
URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
NOT_A_LINK = (
    "Not a YouTube video link. Paste a link to one video "
    "(youtube.com/watch?v=..., youtu.be/..., or a Shorts link)."
)
LIVE = "Live streams and premieres cannot be practised; pick a finished video."
UPDATE_HINT = (
    "If YouTube links keep failing, update yt-dlp: "
    "cd service && uv lock --upgrade-package yt-dlp && uv sync --inexact"
)


@contextmanager
def serve(cache: Path, **changes: Any) -> Iterator[TestClient]:
    """The app over `cache`, with its real lifespan, and settings changed."""
    with TestClient(create_app(Settings(cache_dir=cache, **changes))) as client:
        yield client


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with serve(tmp_path) as client:
        yield client


@dataclass
class Lookups:
    """What the fake lookup was asked, and what it is told to answer."""

    calls: list[str] = field(default_factory=list)
    settings: list[Settings] = field(default_factory=list)
    info: youtube.VideoInfo | None = None
    error: Exception | None = None
    inside: Callable[[], None] | None = None


@pytest.fixture
def lookups(monkeypatch: pytest.MonkeyPatch) -> Lookups:
    seen = Lookups()

    def lookup(video_id: str, settings: Settings) -> youtube.VideoInfo:
        seen.calls.append(video_id)
        seen.settings.append(settings)
        if seen.inside is not None:
            seen.inside()
        if seen.error is not None:
            raise seen.error
        return seen.info or youtube.VideoInfo(
            video_id=video_id,
            title="Big Buck Bunny",
            duration_s=635.0,
            uploader="Blender",
        )

    monkeypatch.setattr(youtube, "lookup", lookup)
    return seen


def video(**fields: Any) -> youtube.VideoInfo:
    base: dict[str, Any] = {
        "video_id": VIDEO_ID,
        "title": "Big Buck Bunny",
        "duration_s": 635.0,
    }
    return youtube.VideoInfo(**{**base, **fields})


def post_link(client: TestClient, url: str = URL) -> httpx.Response:
    return client.post("/songs/url", json={"url": url})


def wait_idle(client: TestClient) -> None:
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)


def song_folders(cache: Path) -> list[str]:
    return sorted(
        p.name for p in cache.iterdir() if p.is_dir() and p.name != ".incoming"
    )


def steps(client: TestClient, song_id: str = SONG_ID) -> dict[str, dict[str, Any]]:
    return client.get(f"/songs/{song_id}").json()["steps"]


QUEUED = {"state": "queued", "progress": 0.0, "error": None, "detail": None}


# --- making the song --------------------------------------------------------


def test_a_link_makes_a_song_named_after_the_video(
    client: TestClient, tmp_path: Path, lookups: Lookups
) -> None:
    response = post_link(client)

    assert response.status_code == 200
    body = response.json()
    assert body["song_id"] == SONG_ID
    assert body["source"] == "youtube"
    assert body["title"] == "Big Buck Bunny"
    assert body["duration_s"] == 635.0
    # Every step still waits, fetch included: no fetch runner is registered
    # here, and the answer is the status as the link was queued.
    assert body["steps"] == {
        "fetch": QUEUED,
        "separation": QUEUED,
        "key": QUEUED,
        "reference": QUEUED,
        "lyrics": QUEUED,
    }
    assert lookups.calls == [VIDEO_ID]
    assert lookups.settings == [client.app.state.settings]
    assert song_folders(tmp_path) == [SONG_ID]
    folder = tmp_path / SONG_ID
    assert json.loads((folder / "meta.json").read_text("utf-8")) == {
        "source": "youtube",
        "title": "Big Buck Bunny",
        "url": URL,
        "duration_s": 635.0,
        "video_id": VIDEO_ID,
        "stem_gain": 1.0,
    }
    assert client.get(f"/songs/{SONG_ID}").json()["title"] == "Big Buck Bunny"


def test_the_stored_url_is_the_canonical_one_whatever_was_pasted(
    client: TestClient, tmp_path: Path, lookups: Lookups
) -> None:
    pasted = f"  https://youtu.be/{VIDEO_ID}?list=PLabcdefghijk&t=30&si=tracking\n"
    assert post_link(client, pasted).status_code == 200

    meta = json.loads((tmp_path / SONG_ID / "meta.json").read_text("utf-8"))
    assert meta["url"] == URL


def test_a_scheme_less_paste_works(client: TestClient, lookups: Lookups) -> None:
    assert post_link(client, f"youtu.be/{VIDEO_ID}").json()["song_id"] == SONG_ID


def test_every_form_of_link_to_one_video_is_the_same_song(
    client: TestClient, tmp_path: Path, lookups: Lookups
) -> None:
    forms = [
        URL,
        f"https://youtu.be/{VIDEO_ID}",
        f"https://www.youtube.com/shorts/{VIDEO_ID}",
        f"https://www.youtube.com/embed/{VIDEO_ID}",
        f"https://music.youtube.com/watch?v={VIDEO_ID}&list=RDAMVM{VIDEO_ID}",
        f"https://m.youtube.com/watch?v={VIDEO_ID}",
    ]
    ids = {post_link(client, form).json()["song_id"] for form in forms}

    assert ids == {SONG_ID}
    assert song_folders(tmp_path) == [SONG_ID]
    # Only the first needed to ask YouTube anything.
    assert lookups.calls == [VIDEO_ID]


def test_a_long_title_is_capped_and_a_padded_one_trimmed(
    client: TestClient, lookups: Lookups
) -> None:
    lookups.info = video(title="  " + "a" * 300 + "  ")
    assert post_link(client).json()["title"] == "a" * 200


# --- links that are refused ---------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "hello",
        VIDEO_ID,
        f"http://www.youtube.com/watch?v={VIDEO_ID}",
        f"https://example.com/watch?v={VIDEO_ID}",
        f"https://youtube.com.evil.com/watch?v={VIDEO_ID}",
        f"https://youtube.com@evil.com/watch?v={VIDEO_ID}",
        "https://www.youtube.com/playlist?list=PLabcdefghijk",
        "https://www.youtube.com/@Blender",
        "https://www.youtube.com/watch?v=short",
        "javascript:alert(1)",
        "x" * 5000,
    ],
)
def test_something_that_is_not_a_video_link_is_422_and_leaves_nothing(
    client: TestClient, tmp_path: Path, lookups: Lookups, url: str
) -> None:
    response = post_link(client, url)

    assert response.status_code == 422
    assert response.json() == {"detail": NOT_A_LINK}
    assert lookups.calls == []
    assert song_folders(tmp_path) == []


@pytest.mark.parametrize(
    "body",
    [{}, {"url": None}, {"url": 12345}, {"link": URL}, [URL], "just text"],
)
def test_a_body_without_a_text_url_is_422_before_anything_happens(
    client: TestClient, tmp_path: Path, lookups: Lookups, body: Any
) -> None:
    response = client.post("/songs/url", json=body)
    assert response.status_code == 422
    assert lookups.calls == []
    assert song_folders(tmp_path) == []


def test_a_body_that_is_not_json_is_422(client: TestClient, lookups: Lookups) -> None:
    response = client.post(
        "/songs/url",
        content=b"url=" + URL.encode(),
        headers={"Content-Type": "text/plain"},
    )
    assert response.status_code == 422
    assert lookups.calls == []


@pytest.mark.parametrize(
    "info",
    [
        video(is_live=True),
        video(is_live=True, duration_s=None),
        video(duration_s=None),
    ],
)
def test_a_live_stream_or_a_video_with_no_length_is_422(
    client: TestClient, tmp_path: Path, lookups: Lookups, info: youtube.VideoInfo
) -> None:
    lookups.info = info

    response = post_link(client)

    assert response.status_code == 422
    assert response.json() == {"detail": LIVE}
    assert song_folders(tmp_path) == []


@pytest.mark.parametrize(
    ("answer", "refused"),
    [
        ({"duration": 600, "is_live": True}, True),
        ({"duration": None, "live_status": "is_live"}, True),
        ({"duration": None, "live_status": "is_upcoming"}, True),
        ({"duration": 300, "live_status": "is_upcoming"}, True),
        ({"duration": 300, "live_status": "post_live"}, True),
        ({"live_status": "not_live"}, True),
        ({"duration": 0}, True),
        ({"duration": 300, "live_status": "not_live"}, False),
        ({"duration": 300, "live_status": "was_live"}, False),
    ],
)
def test_the_route_refuses_what_yt_dlp_reports_as_live_or_unfinished(
    client: TestClient,
    tmp_path: Path,
    ydl: Ydl,
    node_only: dict[str, dict[str, str]],
    answer: dict[str, Any],
    refused: bool,
) -> None:
    # The real lookup, over a fake yt-dlp.
    ydl.info = {"id": VIDEO_ID, "title": "A video", **answer}

    response = post_link(client)

    assert ydl.extracted == [(URL, False)]
    if refused:
        assert (response.status_code, response.json()) == (422, {"detail": LIVE})
        assert song_folders(tmp_path) == []
    else:
        assert response.status_code == 200
        assert song_folders(tmp_path) == [SONG_ID]


@pytest.mark.parametrize(
    ("duration_s", "max_song_s", "detail"),
    [
        (
            901,
            900,
            "This video is 16 min long; the limit is 15 min (ENCORE_MAX_SONG_S).",
        ),
        (
            631,
            600,
            "This video is 11 min long; the limit is 10 min (ENCORE_MAX_SONG_S).",
        ),
        (
            3601,
            3600,
            "This video is 61 min long; the limit is 60 min (ENCORE_MAX_SONG_S).",
        ),
        # Both round up, so the two can read alike; the limit is what decides.
        (61, 60, "This video is 2 min long; the limit is 1 min (ENCORE_MAX_SONG_S)."),
        (60.5, 60, "This video is 2 min long; the limit is 1 min (ENCORE_MAX_SONG_S)."),
        (130, 61, "This video is 3 min long; the limit is 2 min (ENCORE_MAX_SONG_S)."),
    ],
)
def test_a_video_over_the_limit_is_422_with_both_lengths_rounded_up(
    tmp_path: Path,
    lookups: Lookups,
    duration_s: float,
    max_song_s: int,
    detail: str,
) -> None:
    lookups.info = video(duration_s=duration_s)
    with serve(tmp_path, max_song_s=max_song_s) as client:
        response = post_link(client)

    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    assert song_folders(tmp_path) == []


@pytest.mark.parametrize(
    ("duration_s", "max_song_s"), [(900, 900), (899.5, 900), (1, 1)]
)
def test_a_video_exactly_at_the_limit_is_accepted(
    tmp_path: Path, lookups: Lookups, duration_s: float, max_song_s: int
) -> None:
    lookups.info = video(duration_s=duration_s)
    with serve(tmp_path, max_song_s=max_song_s) as client:
        assert post_link(client).status_code == 200


def test_the_limit_comes_from_the_settings(tmp_path: Path, lookups: Lookups) -> None:
    lookups.info = video(duration_s=1000)
    with serve(tmp_path) as client:
        assert post_link(client).status_code == 422
    with serve(tmp_path, max_song_s=1200) as client:
        assert post_link(client).status_code == 200


# --- YouTube cannot answer ----------------------------------------------------


def test_a_lookup_failure_is_502_with_the_message_and_the_update_hint(
    client: TestClient,
    tmp_path: Path,
    lookups: Lookups,
    node_only: dict[str, dict[str, str]],
) -> None:
    lookups.error = youtube.YtDlpError("[youtube] aqz-KE-bpKQ: Video unavailable")

    response = post_link(client)

    assert response.status_code == 502
    assert response.json() == {
        "detail": (
            "YouTube lookup failed: [youtube] aqz-KE-bpKQ: Video unavailable. "
            + UPDATE_HINT
        )
    }
    assert song_folders(tmp_path) == []


def test_a_lookup_failure_without_a_javascript_runtime_says_so_too(
    client: TestClient, lookups: Lookups, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(youtube, "js_runtimes", dict)
    lookups.error = youtube.YtDlpError("Sign in to confirm you are not a bot")

    detail = post_link(client).json()["detail"]

    assert youtube.NO_RUNTIME_NOTE in detail
    assert detail.startswith("YouTube lookup failed: Sign in to confirm")
    assert detail.endswith(UPDATE_HINT)


def test_the_route_turns_a_yt_dlp_error_into_502_with_its_text(
    client: TestClient,
    tmp_path: Path,
    ydl: Ydl,
    node_only: dict[str, dict[str, str]],
) -> None:
    # The real lookup, over a fake yt-dlp that fails the way the real one does.
    ydl.error = yt_dlp.utils.DownloadError(
        "ERROR: [youtube] aqz-KE-bpKQ: Private video. Sign in if you have access"
    )

    response = post_link(client)

    assert response.status_code == 502
    assert response.json() == {
        "detail": (
            "YouTube lookup failed: [youtube] aqz-KE-bpKQ: Private video. "
            "Sign in if you have access. " + UPDATE_HINT
        )
    }
    assert song_folders(tmp_path) == []


def test_a_failed_lookup_can_be_tried_again(
    client: TestClient, lookups: Lookups
) -> None:
    lookups.error = youtube.YtDlpError("Network is unreachable")
    assert post_link(client).status_code == 502

    lookups.error = None
    assert post_link(client).status_code == 200
    assert len(lookups.calls) == 2


# --- links that are already songs -------------------------------------------


def test_a_repeat_of_a_cached_video_makes_no_lookup(
    client: TestClient, tmp_path: Path, lookups: Lookups
) -> None:
    first = post_link(client).json()
    wait_idle(client)
    assert lookups.calls == [VIDEO_ID]

    # If the lookup ran again it would fail; it must not run at all.
    lookups.error = youtube.YtDlpError("YouTube is down")
    second = post_link(client, f"https://youtu.be/{VIDEO_ID}")

    assert second.status_code == 200
    assert second.json()["song_id"] == first["song_id"]
    assert second.json()["title"] == first["title"]
    assert lookups.calls == [VIDEO_ID]
    assert song_folders(tmp_path) == [SONG_ID]


def test_a_repeat_keeps_the_first_title_and_length(
    client: TestClient, lookups: Lookups
) -> None:
    post_link(client)
    wait_idle(client)
    lookups.info = video(title="Renamed upload", duration_s=700.0)

    second = post_link(client).json()

    assert (second["title"], second["duration_s"]) == ("Big Buck Bunny", 635.0)


def test_a_repeat_after_a_failed_fetch_reads_queued_and_tries_again(
    client: TestClient, lookups: Lookups, monkeypatch: pytest.MonkeyPatch
) -> None:
    attempts: list[str] = []

    def fetch(store: Any, song_id: str, report: Callable[[float], None]) -> None:
        attempts.append(f"attempt {len(attempts) + 1}")
        raise RuntimeError(f"failure of attempt {len(attempts)}")

    monkeypatch.setitem(pipeline.RUNNERS, "fetch", fetch)
    post_link(client)
    wait_idle(client)
    failed = steps(client)["fetch"]
    assert (failed["state"], failed["error"]) == ("failed", "failure of attempt 1")

    again = post_link(client).json()

    # The failure is not shown beside a retry that is already waiting.
    assert again["steps"]["fetch"] == QUEUED
    wait_idle(client)
    failed = steps(client)["fetch"]
    assert (failed["state"], failed["error"]) == ("failed", "failure of attempt 2")
    assert attempts == ["attempt 1", "attempt 2"]
    assert lookups.calls == [VIDEO_ID]


def test_a_repeat_after_the_audio_went_missing_fetches_it_again(
    client: TestClient,
    tmp_path: Path,
    lookups: Lookups,
    fakes: FetchFakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "fetch", fetch_source)
    post_link(client)
    wait_idle(client)
    assert steps(client)["fetch"]["state"] == "done"
    assert client.get(f"/songs/{SONG_ID}/audio").status_code == 200
    # The fetch is done, and then the file goes: a cache cleaned by hand, say.
    (tmp_path / SONG_ID / "source.flac").unlink()
    assert client.get(f"/songs/{SONG_ID}/audio").status_code == 409

    again = post_link(client).json()

    # The status must not go on saying the download is done.
    assert again["steps"]["fetch"] == QUEUED
    wait_idle(client)
    assert steps(client)["fetch"]["state"] == "done"
    audio = client.get(f"/songs/{SONG_ID}/audio")
    assert (audio.status_code, audio.content[:4]) == (200, b"fLaC")
    assert len(fakes.downloads) == 2
    assert lookups.calls == [VIDEO_ID]


def test_a_repeat_while_the_fetch_runs_returns_the_status_unchanged(
    client: TestClient, lookups: Lookups, monkeypatch: pytest.MonkeyPatch
) -> None:
    started, release = threading.Event(), threading.Event()
    runs: list[str] = []

    def fetch(store: Any, song_id: str, report: Callable[[float], None]) -> None:
        runs.append(song_id)
        report(0.5)
        started.set()
        assert release.wait(WAIT_S)

    monkeypatch.setitem(pipeline.RUNNERS, "fetch", fetch)
    post_link(client)
    assert started.wait(WAIT_S)
    running = client.get(f"/songs/{SONG_ID}").json()
    assert (
        running["steps"]["fetch"]["state"],
        running["steps"]["fetch"]["progress"],
    ) == (
        "running",
        0.5,
    )

    again = post_link(client)

    assert again.json() == running
    release.set()
    wait_idle(client)
    assert runs == [SONG_ID]
    assert steps(client)["fetch"]["state"] == "done"


def test_two_requests_for_one_new_video_make_one_song_and_one_fetch(
    client: TestClient,
    tmp_path: Path,
    lookups: Lookups,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runs: list[str] = []
    monkeypatch.setitem(
        pipeline.RUNNERS, "fetch", lambda store, sid, report: runs.append(sid)
    )
    # Both requests are inside the lookup before either goes on to create the
    # song, which is the window the creation has to be safe in.
    both_looked_up = threading.Barrier(2)
    lookups.inside = lambda: both_looked_up.wait(WAIT_S)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: post_link(client), range(2)))
    wait_idle(client)

    assert [r.status_code for r in responses] == [200, 200]
    assert {r.json()["song_id"] for r in responses} == {SONG_ID}
    assert len(lookups.calls) == 2
    assert song_folders(tmp_path) == [SONG_ID]
    assert sorted(p.name for p in (tmp_path / SONG_ID).iterdir()) == [
        "meta.json",
        "status.json",
    ]
    assert runs == [SONG_ID]


def test_a_link_interrupted_by_a_restart_is_retried_by_adding_it_again(
    tmp_path: Path, lookups: Lookups, monkeypatch: pytest.MonkeyPatch
) -> None:
    with serve(tmp_path) as first:
        post_link(first)
        wait_idle(first)
    # What a stop in the middle of the download leaves in the status file.
    path = tmp_path / SONG_ID / "status.json"
    data = json.loads(path.read_text("utf-8"))
    data["steps"]["fetch"].update(state="running", progress=0.4, detail=None)
    path.write_text(json.dumps(data), encoding="utf-8")
    ran: list[str] = []
    monkeypatch.setitem(
        pipeline.RUNNERS, "fetch", lambda store, sid, report: ran.append(sid)
    )

    with serve(tmp_path) as second:
        wait_idle(second)
        after_start = steps(second)["fetch"]
        assert (after_start["state"], after_start["error"]) == (
            "failed",
            INTERRUPTED_MESSAGE,
        )
        assert ran == []

        again = post_link(second).json()
        assert again["steps"]["fetch"] == QUEUED
        wait_idle(second)

        assert steps(second)["fetch"]["state"] == "done"
    assert ran == [SONG_ID]
    assert lookups.calls == [VIDEO_ID]


# --- the fetch, end to end --------------------------------------------------


def test_a_fetched_link_is_served_as_flac(
    client: TestClient,
    tmp_path: Path,
    lookups: Lookups,
    fakes: FetchFakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "fetch", fetch_source)

    created = post_link(client).json()
    wait_idle(client)

    assert created["duration_s"] == 635.0  # what the lookup said
    status = client.get(f"/songs/{SONG_ID}").json()
    assert status["steps"]["fetch"] == {
        "state": "done",
        "progress": 1.0,
        "error": None,
        "detail": None,
    }
    # The real length of the audio replaced the looked-up one.
    assert status["duration_s"] == pytest.approx(SECONDS, abs=0.01)
    meta = json.loads((tmp_path / SONG_ID / "meta.json").read_text("utf-8"))
    assert meta["duration_s"] == status["duration_s"]

    audio = client.get(f"/songs/{SONG_ID}/audio")
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/flac"
    assert audio.content[:4] == b"fLaC"
    assert audio.content == (tmp_path / SONG_ID / "source.flac").read_bytes()
    assert sf.info(str(tmp_path / SONG_ID / "source.flac")).format == "FLAC"
    assert not (tmp_path / SONG_ID / ".fetch").exists()

    ranged = client.get(f"/songs/{SONG_ID}/audio", headers={"Range": "bytes=0-3"})
    assert (ranged.status_code, ranged.content) == (206, b"fLaC")


def test_a_link_whose_fetch_failed_serves_no_audio(
    client: TestClient,
    tmp_path: Path,
    lookups: Lookups,
    fakes: FetchFakes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(pipeline.RUNNERS, "fetch", fetch_source)
    fakes.download_error = youtube.YtDlpError("HTTP Error 403: Forbidden")

    post_link(client)
    wait_idle(client)

    fetch_step = steps(client)["fetch"]
    assert fetch_step["state"] == "failed"
    assert fetch_step["error"].startswith(
        "Downloading from YouTube failed: HTTP Error 403: Forbidden."
    )
    assert fetch_step["error"].endswith(UPDATE_HINT)
    # Separation waits on the audio, so it says why it did not run.
    assert steps(client)["separation"]["detail"] == "Not built yet (ROADMAP P2-T2)"
    response = client.get(f"/songs/{SONG_ID}/audio")
    assert (response.status_code, response.json()) == (
        409,
        {"detail": "Song not fetched yet."},
    )
    assert sorted(p.name for p in (tmp_path / SONG_ID).iterdir()) == [
        "meta.json",
        "status.json",
    ]


def test_the_audio_of_a_link_is_409_until_it_has_been_fetched(
    client: TestClient, lookups: Lookups
) -> None:
    post_link(client)
    wait_idle(client)
    response = client.get(f"/songs/{SONG_ID}/audio")
    assert (response.status_code, response.json()) == (
        409,
        {"detail": "Song not fetched yet."},
    )


def test_the_audio_route_serves_a_flac_source_with_its_media_type(
    client: TestClient, tmp_path: Path, lookups: Lookups
) -> None:
    post_link(client)
    wait_idle(client)
    (tmp_path / SONG_ID / "source.flac").write_bytes(b"fLaC and some more")

    response = client.get(f"/songs/{SONG_ID}/audio")

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/flac"
    assert response.content == b"fLaC and some more"


# --- the contract -----------------------------------------------------------


def test_openapi_describes_the_link_route(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    operation = spec["paths"]["/songs/url"]["post"]
    assert {"200", "422", "502"} <= set(operation["responses"])
    body = spec["components"]["schemas"]["SongLinkRequest"]
    assert list(body["properties"]) == ["url"]
    assert body["required"] == ["url"]


def test_the_link_route_does_not_shadow_the_song_routes(client: TestClient) -> None:
    # "/songs/url" is a fixed path next to "/songs/{song_id}".
    assert client.get("/songs/url").status_code == 404
    assert client.get("/songs/" + "0" * 64).status_code == 404
