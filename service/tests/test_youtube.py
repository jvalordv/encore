"""Tests for the YouTube helpers: link parsing, lookup, download and FLAC.

yt-dlp and the subprocess module are replaced with fakes that record what
they were given, so nothing here reaches the network. The two tests at the end
run the real ffmpeg on a synthetic file and are skipped where it is absent.
"""

import shutil
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
import yt_dlp

from encore_service import youtube
from encore_service.config import Settings
from tests.fakes import REAL_YOUTUBE_DL, Ydl

ID = "dQw4w9WgXcQ"
CANONICAL = f"https://www.youtube.com/watch?v={ID}"
SETTINGS = Settings()

# Every form of link that must give back its video id: each host, each path,
# parameters that are ignored, and what a pasted link tends to look like.
ACCEPTED = [
    f"https://www.youtube.com/watch?v={ID}",
    f"https://youtube.com/watch?v={ID}",
    f"https://m.youtube.com/watch?v={ID}",
    f"https://music.youtube.com/watch?v={ID}",
    f"https://www.youtube.com/watch?v={ID}&list=PLabcdefghijk&index=3",
    f"https://www.youtube.com/watch?list=PLabcdefghijk&v={ID}&t=42s",
    f"https://www.youtube.com/watch?feature=share&v={ID}",
    f"https://www.youtube.com/watch?v={ID}#t=10",
    f"https://youtu.be/{ID}",
    f"https://youtu.be/{ID}?t=30&si=abcdefghijklmnop",
    f"https://youtu.be/{ID}/",
    f"https://www.youtube.com/shorts/{ID}",
    f"https://www.youtube.com/shorts/{ID}?feature=share",
    f"https://youtube.com/shorts/{ID}/",
    f"https://www.youtube.com/embed/{ID}",
    f"https://www.youtube.com/embed/{ID}?start=10",
    f"https://www.youtube-nocookie.com/embed/{ID}",
    f"https://www.youtube.com/live/{ID}",
    f"https://www.youtube.com/v/{ID}",
    f"https://music.youtube.com/watch?v={ID}&list=RDAMVM{ID}",
    # No scheme, as pasted from an address bar that hides it.
    f"youtu.be/{ID}",
    f"www.youtube.com/watch?v={ID}",
    f"youtube.com/watch?v={ID}",
    f"m.youtube.com/shorts/{ID}",
    # Whitespace around the link is a copy and paste artefact.
    f"  https://youtu.be/{ID}\n",
    f"\thttps://www.youtube.com/watch?v={ID} ",
    # Scheme and host are case-insensitive; the id is not.
    f"HTTPS://WWW.YOUTUBE.COM/watch?v={ID}",
    f"https://www.YouTube.com/watch?v={ID}",
]

REJECTED = [
    # Nothing there.
    "",
    "   \n",
    "not a link",
    ID,
    # Not https.
    f"http://www.youtube.com/watch?v={ID}",
    f"http://youtu.be/{ID}",
    f"ftp://youtu.be/{ID}",
    f"file:///youtu.be/{ID}",
    f"javascript:alert(1)//youtu.be/{ID}",
    f"data:text/html,https://youtu.be/{ID}",
    f"//youtu.be/{ID}",
    f"https:/youtu.be/{ID}",
    f"<https://youtu.be/{ID}>",
    # Look-alike hosts, other hosts, and addresses.
    f"https://youtube.com.evil.com/watch?v={ID}",
    f"https://evilyoutube.com/watch?v={ID}",
    f"https://notyoutu.be/{ID}",
    f"https://youtu.be.evil.com/{ID}",
    f"https://evil.com/youtube.com/watch?v={ID}",
    f"https://evil.com/watch?v={ID}&u=www.youtube.com",
    f"https://studio.youtube.com/watch?v={ID}",
    f"https://www.youtube.com./watch?v={ID}",
    f"https://127.0.0.1/watch?v={ID}",
    f"https://[::1]/watch?v={ID}",
    "https://[::1/watch",
    f"https://www.youtube.com\\@evil.com/watch?v={ID}",
    # A host whose lower-case form is ASCII only by the Kelvin sign.
    f"https://www.youtube-nocoo\N{KELVIN SIGN}ie.com/embed/{ID}",
    # User information and ports.
    f"https://youtube.com@evil.com/watch?v={ID}",
    f"https://user:secret@www.youtube.com/watch?v={ID}",
    f"https://www.youtube.com:443/watch?v={ID}",
    f"https://www.youtube.com:8080/watch?v={ID}",
    f"https://youtu.be:443/{ID}",
    # Pages that are not one video.
    "https://www.youtube.com/playlist?list=PLabcdefghijk",
    "https://www.youtube.com/watch?list=PLabcdefghijk",
    "https://www.youtube.com/embed/videoseries?list=PLabcdefghijk",
    "https://www.youtube.com/embed/live_stream?channel=UCabcdefghijk",
    "https://www.youtube.com/@Blender",
    "https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg",
    "https://www.youtube.com/user/BlenderFoundation",
    "https://www.youtube.com/c/Blender",
    f"https://www.youtube.com/results?search_query={ID}",
    "https://www.youtube.com/",
    "https://www.youtube.com",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=",
    "https://youtu.be/",
    "https://youtu.be",
    # Ids that are not 11 characters of the id alphabet.
    "https://www.youtube.com/watch?v=dQw4w9WgXc",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXc!",
    "https://www.youtube.com/watch?v=dQw4w9WgXc.",
    "https://www.youtube.com/watch?v=dQw4w9WgXc%51",
    "https://www.youtube.com/watch?v=short",
    "https://youtu.be/dQw4w9WgXc",
    "https://youtu.be/dQw4w9WgXcQQ",
    "https://www.youtube.com/shorts/short",
    "https://youtu.be/d\N{CYRILLIC SMALL LETTER IO}w4w9WgXcQ",
    # A path that is close to a video path but is not one.
    f"https://youtu.be/{ID}/extra",
    f"https://www.youtube.com/shorts/{ID}/extra",
    f"https://www.youtube.com//watch?v={ID}",
    f"https://www.youtube.com/WATCH?v={ID}",
    f"https://www.youtube.com/watch/?v={ID}",
    f"https://www.youtube.com/{ID}",
    f"https://youtu.be/watch?v={ID}",
    # Whitespace or control characters inside the link.
    f"https://youtu.be/{ID} extra",
    "https://youtu.be/dQw4w9\nWgXcQ",
    "https://youtu.be/dQw4w9\tWgXcQ",
    f"https://youtu.be/{ID}\x00",
    f"https://youtu.be/{ID}\N{ZERO WIDTH SPACE}",
    # Over the length cap.
    f"https://youtu.be/{ID}?x=" + "a" * youtube.MAX_LINK_CHARS,
]


@pytest.mark.parametrize("text", ACCEPTED)
def test_a_video_link_gives_its_id(text: str) -> None:
    assert youtube.parse_youtube_url(text) == ID


@pytest.mark.parametrize("text", REJECTED)
def test_anything_else_gives_none(text: str) -> None:
    assert youtube.parse_youtube_url(text) is None


def test_the_table_covers_enough_ground() -> None:
    assert len(ACCEPTED) + len(REJECTED) >= 30


def test_ids_may_hold_dashes_and_underscores_and_keep_their_case() -> None:
    for video_id in ("-_-_-_-_-_-", "a-b_c-d_e-f", "AbCdEfGhIjK", "___________"):
        assert youtube.parse_youtube_url(f"https://youtu.be/{video_id}") == video_id
        url = f"https://www.youtube.com/watch?v={video_id}"
        assert youtube.parse_youtube_url(url) == video_id


def test_the_first_v_parameter_decides() -> None:
    url = f"https://www.youtube.com/watch?v={ID}&v=AbCdEfGhIjK"
    assert youtube.parse_youtube_url(url) == ID
    assert youtube.parse_youtube_url("https://www.youtube.com/watch?v=&v=" + ID) is None


def test_the_length_cap_is_inclusive() -> None:
    prefix = f"https://youtu.be/{ID}?x="
    at_cap = prefix + "a" * (youtube.MAX_LINK_CHARS - len(prefix))
    assert len(at_cap) == youtube.MAX_LINK_CHARS
    assert youtube.parse_youtube_url(at_cap) == ID
    assert youtube.parse_youtube_url(at_cap + "a") is None


def test_a_huge_paste_is_refused_without_being_parsed() -> None:
    assert youtube.parse_youtube_url("x" * 10_000_000) is None


def test_canonical_url_is_the_one_watch_url() -> None:
    assert youtube.canonical_url(ID) == CANONICAL
    assert youtube.canonical_url("-_-_-_-_-_-").endswith("?v=-_-_-_-_-_-")


@pytest.mark.parametrize(
    "video_id",
    [
        "",
        "short",
        ID + "x",
        ID[:-1] + "&",
        f"{ID}&list=PLabcdefghijk",
        ID[:-1] + "\n",
        "../../etc/passwd",
        "https://evil.com",
        "d\N{CYRILLIC SMALL LETTER IO}w4w9WgXcQ",
    ],
)
def test_canonical_url_refuses_anything_that_is_not_an_id(video_id: str) -> None:
    with pytest.raises(ValueError, match="video id"):
        youtube.canonical_url(video_id)


# --- the JavaScript runtime -------------------------------------------------


def test_js_runtimes_lists_what_is_on_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    on_path = {"deno": "/bin/deno", "node": "/bin/node"}
    monkeypatch.setattr(youtube.shutil, "which", on_path.get)
    assert youtube.js_runtimes() == {
        "deno": {"path": "/bin/deno"},
        "node": {"path": "/bin/node"},
    }
    del on_path["deno"]
    assert youtube.js_runtimes() == {"node": {"path": "/bin/node"}}
    on_path.clear()
    assert youtube.js_runtimes() == {}


def test_the_options_are_accepted_by_the_installed_yt_dlp(
    node_only: dict[str, dict[str, str]],
) -> None:
    options = youtube._base_options(SETTINGS)
    # The real class: every other test has the fake or the guard in its place.
    with REAL_YOUTUBE_DL(options) as ydl:
        assert ydl.params["js_runtimes"] == node_only
        assert ydl.params["noplaylist"] is True


def test_a_test_with_no_fake_cannot_reach_yt_dlp(
    no_unfaked_yt_dlp: list[str],
) -> None:
    with pytest.raises(AssertionError, match="without a fake"):
        yt_dlp.YoutubeDL({})
    # lookup() turns any error into a YtDlpError, so the guard also keeps a
    # record, which fails the test afterwards.
    with pytest.raises(youtube.YtDlpError, match="without a fake"):
        youtube.lookup(ID, SETTINGS)
    assert len(no_unfaked_yt_dlp) == 2
    # The guard has done its job; clear its record so this test is not failed.
    no_unfaked_yt_dlp.clear()


# --- failure messages -------------------------------------------------------


def test_a_yt_dlp_failure_reads_what_failed_then_the_update_hint(
    node_only: dict[str, dict[str, str]],
) -> None:
    message = youtube.describe_failure(
        "YouTube lookup failed", youtube.YtDlpError("Video unavailable")
    )
    assert message == (
        "YouTube lookup failed: Video unavailable. "
        "If YouTube links keep failing, update yt-dlp: "
        "cd service && uv lock --upgrade-package yt-dlp && uv sync"
    )


def test_a_message_that_ends_in_a_full_stop_does_not_get_two() -> None:
    message = youtube.describe_failure("It failed", youtube.YtDlpError("Gone."))
    assert message.startswith("It failed: Gone. ")


def test_without_a_javascript_runtime_the_failure_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(youtube, "js_runtimes", dict)
    message = youtube.describe_failure("Failed", youtube.YtDlpError("Forbidden"))
    assert message == (
        f"Failed: Forbidden. {youtube.NO_RUNTIME_NOTE} {youtube.UPDATE_HINT}"
    )
    assert "Node or Deno" in message
    assert "README" in message


# --- yt-dlp, faked ------------------------------------------------------------


BUNNY = {
    "id": "aqz-KE-bpKQ",
    "title": "Big Buck Bunny 60fps 4K",
    "duration": 635,
    "is_live": False,
    "live_status": "not_live",
    "uploader": "Blender",
}


def test_lookup_hands_yt_dlp_only_the_canonical_url(
    ydl: Ydl, node_only: dict[str, dict[str, str]]
) -> None:
    ydl.info = BUNNY
    youtube.lookup(ID, SETTINGS)

    assert ydl.extracted == [(CANONICAL, False)]
    assert ydl.closed == 1


def test_lookup_runs_with_the_fixed_option_set(
    ydl: Ydl, node_only: dict[str, dict[str, str]]
) -> None:
    ydl.info = BUNNY
    youtube.lookup(ID, SETTINGS)

    assert ydl.options == {
        "quiet": True,
        "no_warnings": True,
        "no_color": True,
        "noprogress": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 15,
        "js_runtimes": node_only,
    }


def test_lookup_never_lets_a_bad_id_reach_yt_dlp(ydl: Ydl) -> None:
    for video_id in (f"{ID}&list=PLabcdefghijk", "https://evil.com", ""):
        with pytest.raises(ValueError, match="video id"):
            youtube.lookup(video_id, SETTINGS)
    assert ydl.extracted == []


def test_lookup_reads_the_video_from_yt_dlp_info(ydl: Ydl) -> None:
    ydl.info = BUNNY
    info = youtube.lookup("aqz-KE-bpKQ", SETTINGS)

    assert info == youtube.VideoInfo(
        video_id="aqz-KE-bpKQ",
        title="Big Buck Bunny 60fps 4K",
        duration_s=635.0,
        is_live=False,
        uploader="Blender",
    )
    assert isinstance(info.duration_s, float)


@pytest.mark.parametrize(
    ("extra", "is_live"),
    [
        ({"is_live": True}, True),
        ({"live_status": "is_live"}, True),
        ({"live_status": "is_upcoming"}, True),
        ({"live_status": "post_live"}, True),
        ({"is_live": True, "live_status": "is_live"}, True),
        ({"is_live": False, "live_status": "not_live"}, False),
        ({"live_status": "was_live"}, False),
        ({"is_live": None, "live_status": None}, False),
        ({}, False),
    ],
)
def test_lookup_flags_live_upcoming_and_just_ended_streams(
    ydl: Ydl, extra: dict[str, Any], is_live: bool
) -> None:
    ydl.info = {"title": "T", "duration": 100, **extra}
    assert youtube.lookup(ID, SETTINGS).is_live is is_live


@pytest.mark.parametrize("duration", [None, 0, -5, "635", float("nan")])
def test_lookup_reports_a_missing_or_nonsense_length_as_none(
    ydl: Ydl, duration: Any
) -> None:
    ydl.info = {"title": "T", "duration": duration}
    info = youtube.lookup(ID, SETTINGS)
    # NaN is not above zero either, so it can never pass as a length.
    assert info.duration_s is None


def test_lookup_keeps_a_fractional_length(ydl: Ydl) -> None:
    ydl.info = {"title": "T", "duration": 12.5}
    assert youtube.lookup(ID, SETTINGS).duration_s == 12.5


def test_lookup_names_a_video_that_has_no_title_by_its_id(ydl: Ydl) -> None:
    ydl.info = {"duration": 10}
    info = youtube.lookup(ID, SETTINGS)
    assert (info.title, info.uploader) == (ID, None)


def test_lookup_wraps_a_yt_dlp_error_without_its_prefix(ydl: Ydl) -> None:
    ydl.error = yt_dlp.utils.DownloadError("ERROR: [youtube] x: Video unavailable")
    with pytest.raises(youtube.YtDlpError) as raised:
        youtube.lookup(ID, SETTINGS)
    assert str(raised.value) == "[youtube] x: Video unavailable"
    assert isinstance(raised.value.__cause__, yt_dlp.utils.DownloadError)
    assert ydl.closed == 1


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (OSError("network is down"), "network is down"),
        (TimeoutError(), "TimeoutError"),
        (KeyError("formats"), "'formats'"),
    ],
)
def test_lookup_wraps_any_other_failure_too(
    ydl: Ydl, error: Exception, message: str
) -> None:
    ydl.error = error
    with pytest.raises(youtube.YtDlpError) as raised:
        youtube.lookup(ID, SETTINGS)
    assert str(raised.value) == message


@pytest.mark.parametrize("info", [None, "text", ["a"], 7])
def test_lookup_refuses_an_answer_that_is_not_a_video(ydl: Ydl, info: Any) -> None:
    ydl.info = info
    with pytest.raises(youtube.YtDlpError, match="nothing"):
        youtube.lookup(ID, SETTINGS)


# --- the download -------------------------------------------------------------


def saves(name: str, *extra: str) -> Callable[[dict[str, Any]], None]:
    """A download that writes `name` where the output template says."""

    def write(options: dict[str, Any]) -> None:
        folder = Path(str(options["outtmpl"]).rsplit("/", 1)[0].replace("%%", "%"))
        (folder / name).write_bytes(b"audio")
        for other in extra:
            (folder / other).write_bytes(b"x")

    return write


def test_download_audio_asks_for_the_best_audio_with_a_fixed_name(
    ydl: Ydl, tmp_path: Path, node_only: dict[str, dict[str, str]]
) -> None:
    ydl.on_download = saves("download.webm")
    path = youtube.download_audio(ID, tmp_path, lambda value: None, SETTINGS)

    assert path == tmp_path / "download.webm"
    assert ydl.downloaded == [[CANONICAL]]
    assert ydl.closed == 1
    options = ydl.options
    assert options["format"] == "bestaudio/best"
    assert options["outtmpl"] == f"{tmp_path.as_posix()}/download.%(ext)s"
    assert options["noplaylist"] is True
    assert options["js_runtimes"] == node_only
    assert "skip_download" not in options
    # No postprocessing: converting to FLAC is ffmpeg's job, run by us.
    assert "postprocessors" not in options
    assert len(options["progress_hooks"]) == 1


@pytest.mark.parametrize(
    "name", ["100% (live)", "%(title)s", "%%", "%PATH%", "50%", "a b", "(1)"]
)
def test_a_percent_in_the_folder_name_is_not_a_template_field(
    ydl: Ydl, tmp_path: Path, name: str
) -> None:
    folder = tmp_path / name
    folder.mkdir()
    ydl.on_download = saves("download.m4a")

    path = youtube.download_audio(ID, folder, lambda value: None, SETTINGS)

    template = ydl.options["outtmpl"]
    # What yt-dlp's formatting turns the template into.
    assert template % {"ext": "m4a"} == f"{folder.as_posix()}/download.m4a"
    assert path == folder / "download.m4a"


@pytest.mark.parametrize("name", ["a$ZZ_ENCORE_SET", "a${ZZ_ENCORE_SET}b"])
def test_a_dollar_that_yt_dlp_would_expand_is_refused_before_it_downloads(
    ydl: Ydl, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    monkeypatch.setenv("ZZ_ENCORE_SET", "EXPANDED")
    folder = tmp_path / name
    folder.mkdir()
    ydl.on_download = saves("download.webm")

    with pytest.raises(youtube.YouTubeError) as raised:
        youtube.download_audio(ID, folder, lambda value: None, SETTINGS)

    message = str(raised.value)
    # Says where yt-dlp was going, what to change, and does not blame yt-dlp's
    # version: updating it would not help.
    assert str(folder) in message
    assert "EXPANDED" in message
    assert "ENCORE_CACHE_DIR" in message
    assert not isinstance(raised.value, youtube.YtDlpError)
    assert ydl.downloaded == []
    assert ydl.closed == 1


@pytest.mark.parametrize(
    "name",
    ["a$ZZ_ENCORE_UNSET", "a$$b", "share$", "$", "a$1", "a${", "${ZZ_ENCORE_UNSET}"],
)
def test_a_dollar_that_yt_dlp_leaves_alone_does_not_stop_the_download(
    ydl: Ydl, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    # Only a variable that is set is replaced; the rest is kept as written.
    monkeypatch.delenv("ZZ_ENCORE_UNSET", raising=False)
    folder = tmp_path / name
    folder.mkdir()
    ydl.on_download = saves("download.webm")

    path = youtube.download_audio(ID, folder, lambda value: None, SETTINGS)

    assert path == folder / "download.webm"
    assert ydl.downloaded == [[CANONICAL]]


@pytest.mark.parametrize(
    "folder",
    [
        Path("//nas/c$/cache/yt-x/.fetch"),
        Path("relative/cache/yt-x/.fetch"),
        Path("../up/cache/yt-x/.fetch"),
        Path("/srv/encore/cache/yt-x/.fetch"),
    ],
)
def test_the_destination_check_holds_for_every_kind_of_path(folder: Path) -> None:
    options = {"outtmpl": youtube._output_template(folder), "quiet": True}
    with REAL_YOUTUBE_DL(options) as real:
        youtube._require_destination(real, folder)


def test_the_destination_check_reads_the_folder_from_yt_dlp_itself(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ZZ_ENCORE_SET", "EXPANDED")
    folder = tmp_path / "x$ZZ_ENCORE_SET"
    options = {"outtmpl": youtube._output_template(folder), "quiet": True}
    with REAL_YOUTUBE_DL(options) as real:
        with pytest.raises(youtube.YouTubeError) as raised:
            youtube._require_destination(real, folder)
    assert str(tmp_path / "xEXPANDED") in str(raised.value)


def test_download_audio_returns_the_finished_file_not_a_partial_one(
    ydl: Ydl, tmp_path: Path
) -> None:
    ydl.on_download = saves("download.webm", "download.webm.part", "download.ytdl")
    path = youtube.download_audio(ID, tmp_path, lambda value: None, SETTINGS)
    assert path.name == "download.webm"


def test_download_audio_without_a_file_is_an_error(ydl: Ydl, tmp_path: Path) -> None:
    ydl.on_download = saves("download.webm.part")
    with pytest.raises(youtube.YtDlpError, match="without saving"):
        youtube.download_audio(ID, tmp_path, lambda value: None, SETTINGS)


def test_download_audio_wraps_a_failure(ydl: Ydl, tmp_path: Path) -> None:
    ydl.error = yt_dlp.utils.DownloadError("ERROR: unable to download: HTTP 403")
    with pytest.raises(youtube.YtDlpError, match="HTTP 403") as raised:
        youtube.download_audio(ID, tmp_path, lambda value: None, SETTINGS)
    assert not str(raised.value).startswith("ERROR")


def test_download_audio_never_lets_a_bad_id_reach_yt_dlp(
    ydl: Ydl, tmp_path: Path
) -> None:
    with pytest.raises(ValueError, match="video id"):
        youtube.download_audio("x&y", tmp_path, lambda value: None, SETTINGS)
    assert ydl.downloaded == []


def run_events(
    ydl: Ydl, tmp_path: Path, events: list[Mapping[str, Any]]
) -> list[float]:
    """Feed yt-dlp progress events to a download and return what it reported."""
    reported: list[float] = []

    def emit(options: dict[str, Any]) -> None:
        (tmp_path / "download.webm").write_bytes(b"audio")
        [hook] = options["progress_hooks"]
        for event in events:
            hook(event)

    ydl.on_download = emit
    youtube.download_audio(ID, tmp_path, reported.append, SETTINGS)
    return reported


def downloading(done: int, **fields: Any) -> dict[str, Any]:
    return {"status": "downloading", "downloaded_bytes": done, **fields}


def test_progress_maps_downloaded_over_total_onto_the_download_share(
    ydl: Ydl, tmp_path: Path
) -> None:
    reported = run_events(
        ydl,
        tmp_path,
        [
            downloading(0, total_bytes=1000),
            downloading(250, total_bytes=1000),
            downloading(500, total_bytes=1000),
            downloading(1000, total_bytes=1000),
            {"status": "finished", "downloaded_bytes": 1000, "total_bytes": 1000},
        ],
    )
    assert youtube.DOWNLOAD_SHARE == 0.85
    # 0 bytes is no progress yet, and the finish repeats the last value.
    assert reported == pytest.approx([0.2125, 0.425, 0.85])


def test_a_finished_download_reports_the_whole_share_whatever_came_before(
    ydl: Ydl, tmp_path: Path
) -> None:
    reported = run_events(
        ydl,
        tmp_path,
        [
            downloading(900, total_bytes=1000),
            # The last update fell short of the total; the end event does not.
            {"status": "finished", "downloaded_bytes": 1000, "total_bytes": 1000},
        ],
    )
    assert reported == pytest.approx([0.765, 0.85])


def test_progress_falls_back_to_the_estimate_of_the_total(
    ydl: Ydl, tmp_path: Path
) -> None:
    reported = run_events(
        ydl,
        tmp_path,
        [
            downloading(100, total_bytes_estimate=400),
            downloading(200, total_bytes=None, total_bytes_estimate=400),
        ],
    )
    assert reported == pytest.approx([0.2125, 0.425])


def test_progress_ignores_events_it_cannot_use(ydl: Ydl, tmp_path: Path) -> None:
    reported = run_events(
        ydl,
        tmp_path,
        [
            downloading(100),  # no total at all
            downloading(100, total_bytes=0),
            {"status": "downloading"},
            {"status": "error"},
            {"status": "something new"},
            {},
        ],
    )
    assert reported == []


def test_progress_only_moves_forward_and_stays_inside_the_share(
    ydl: Ydl, tmp_path: Path
) -> None:
    reported = run_events(
        ydl,
        tmp_path,
        [
            downloading(500, total_bytes_estimate=1000),
            # The estimate grows, so the fraction would fall; it is held.
            downloading(520, total_bytes_estimate=2000),
            downloading(800, total_bytes_estimate=2000),
            # More bytes than the total said: capped, not above the share.
            downloading(5000, total_bytes=1000),
        ],
    )
    assert reported == pytest.approx([0.425, 0.85])
    assert reported == sorted(reported)
    assert all(0.0 <= value <= youtube.DOWNLOAD_SHARE for value in reported)


# --- ffmpeg, faked ----------------------------------------------------------


@dataclass
class Run:
    """What the fake subprocess.run was given."""

    commands: list[list[str]] = field(default_factory=list)
    kwargs: list[dict[str, Any]] = field(default_factory=list)


@pytest.fixture
def ffmpeg_on_path(monkeypatch: pytest.MonkeyPatch) -> str:
    path = str(Path("/opt/ffmpeg/bin/ffmpeg"))
    monkeypatch.setattr(
        youtube.shutil, "which", lambda name: path if name == "ffmpeg" else None
    )
    return path


def fake_run(
    monkeypatch: pytest.MonkeyPatch,
    *,
    returncode: int = 0,
    stderr: bytes = b"",
    raises: BaseException | None = None,
) -> Run:
    seen = Run()

    def run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        seen.commands.append(command)
        seen.kwargs.append(kwargs)
        if raises is not None:
            raise raises
        return subprocess.CompletedProcess(command, returncode, b"", stderr)

    monkeypatch.setattr(youtube.subprocess, "run", run)
    return seen


def test_to_flac_runs_ffmpeg_with_an_argument_list(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    seen = fake_run(monkeypatch)
    src, dst = tmp_path / "download.webm", tmp_path / "source.flac"

    youtube.to_flac(src, dst)

    assert seen.commands == [
        [
            ffmpeg_on_path,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(src),
            "-vn",
            "-map",
            "0:a:0",
            "-c:a",
            "flac",
            "-sample_fmt",
            "s16",
            "-af",
            "aformat=channel_layouts=mono|stereo",
            str(dst),
        ]
    ]
    [kwargs] = seen.kwargs
    # Never a shell: a path with a quote or a semicolon in it is just a path.
    assert not kwargs.get("shell")
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["capture_output"] is True
    assert kwargs["timeout"] > 0


def test_to_flac_does_not_parse_the_paths(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    seen = fake_run(monkeypatch)
    src = tmp_path / "a b; echo hi & c'd.webm"
    dst = tmp_path / "out put.flac"

    youtube.to_flac(src, dst)

    command = seen.commands[0]
    assert command[command.index("-i") + 1] == str(src)
    assert command[-1] == str(dst)


def test_to_flac_makes_a_relative_path_absolute(
    monkeypatch: pytest.MonkeyPatch,
    ffmpeg_on_path: str,
    tmp_path: Path,
) -> None:
    seen = fake_run(monkeypatch)
    monkeypatch.chdir(tmp_path)

    # A path starting with "-" would be read by ffmpeg as an option.
    youtube.to_flac(Path("-odd") / "in.webm", Path("-odd") / "out.flac")

    command = seen.commands[0]
    source, target = Path(command[command.index("-i") + 1]), Path(command[-1])
    assert source.is_absolute() and target.is_absolute()
    # Resolved, as the folder the test runs in may be reached by two names.
    assert source.resolve() == (tmp_path / "-odd" / "in.webm").resolve()
    assert target.resolve() == (tmp_path / "-odd" / "out.flac").resolve()


def test_to_flac_without_ffmpeg_says_where_to_get_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(youtube.shutil, "which", lambda name: None)
    seen = fake_run(monkeypatch)

    with pytest.raises(youtube.FfmpegError) as raised:
        youtube.to_flac(tmp_path / "in.webm", tmp_path / "out.flac")

    assert str(raised.value) == (
        "ffmpeg is not on PATH; see service/README.md (GPU setup, step 1)"
    )
    assert seen.commands == []


def test_to_flac_failure_carries_the_last_500_characters_of_stderr(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    stderr = b"x" * 700 + b"the real reason\n"
    fake_run(monkeypatch, returncode=1, stderr=stderr)
    dst = tmp_path / "out.flac"
    dst.write_bytes(b"a stub the failed run left")

    with pytest.raises(youtube.FfmpegError) as raised:
        youtube.to_flac(tmp_path / "in.webm", dst)

    message = str(raised.value)
    assert message.startswith("ffmpeg failed (exit status 1): ")
    detail = message.split(": ", 1)[1]
    assert len(detail) == 500
    assert detail.endswith("the real reason")
    assert not dst.exists()


def test_to_flac_failure_with_no_stderr_still_says_the_exit_status(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    fake_run(monkeypatch, returncode=3)
    with pytest.raises(youtube.FfmpegError) as raised:
        youtube.to_flac(tmp_path / "in.webm", tmp_path / "out.flac")
    assert str(raised.value) == "ffmpeg failed (exit status 3)"


def test_to_flac_reads_stderr_that_is_not_utf8(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    fake_run(monkeypatch, returncode=1, stderr=b"caf\xe9 not found")
    with pytest.raises(youtube.FfmpegError, match="not found"):
        youtube.to_flac(tmp_path / "in.webm", tmp_path / "out.flac")


def test_to_flac_gives_up_on_a_hung_ffmpeg(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    fake_run(monkeypatch, raises=subprocess.TimeoutExpired("ffmpeg", 600))
    dst = tmp_path / "out.flac"
    dst.write_bytes(b"partial")
    with pytest.raises(youtube.FfmpegError, match="did not finish"):
        youtube.to_flac(tmp_path / "in.webm", dst)
    assert not dst.exists()


def test_to_flac_reports_an_ffmpeg_that_cannot_start(
    monkeypatch: pytest.MonkeyPatch, ffmpeg_on_path: str, tmp_path: Path
) -> None:
    fake_run(monkeypatch, raises=PermissionError("access denied"))
    with pytest.raises(youtube.FfmpegError, match="could not be started"):
        youtube.to_flac(tmp_path / "in.webm", tmp_path / "out.flac")


# --- ffmpeg, for real -------------------------------------------------------

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg is not on PATH"
)


@needs_ffmpeg
def test_to_flac_converts_a_synthetic_wav_with_the_real_ffmpeg(tmp_path: Path) -> None:
    rate, seconds = 22_050, 0.5
    t = np.arange(int(rate * seconds)) / rate
    src, dst = tmp_path / "tone.wav", tmp_path / "tone.flac"
    # 32-bit float in, so the 16-bit output shows the conversion happened.
    sf.write(str(src), 0.3 * np.sin(2 * np.pi * 440 * t), rate, subtype="FLOAT")

    youtube.to_flac(src, dst)

    info = sf.info(str(dst))
    assert (info.format, info.subtype) == ("FLAC", "PCM_16")
    assert info.samplerate == rate
    assert info.duration == pytest.approx(seconds, abs=0.01)
    data, _ = sf.read(str(dst))
    # Mono stays mono at its level: no upmix, no 3 dB loss.
    assert info.channels == 1
    assert float(np.max(np.abs(data))) == pytest.approx(0.3, abs=0.01)


@needs_ffmpeg
def test_to_flac_folds_a_five_one_centre_channel_into_stereo(tmp_path: Path) -> None:
    rate, seconds = 48_000, 0.5
    t = np.arange(int(rate * seconds)) / rate
    # 5.1 order is FL FR FC LFE BL BR; a vocal lives in FC. Only FC has sound.
    six = np.zeros((t.size, 6))
    six[:, 2] = 0.5 * np.sin(2 * np.pi * 440 * t)
    src, dst = tmp_path / "six.wav", tmp_path / "six.flac"
    sf.write(str(src), six, rate, subtype="FLOAT")

    youtube.to_flac(src, dst)

    data, _ = sf.read(str(dst), always_2d=True)
    assert data.shape[1] == 2
    left, right = np.abs(data[:, 0]).max(), np.abs(data[:, 1]).max()
    # Dropping channels 3 to 6 would leave silence; the downmix keeps the
    # centre, equally on both sides.
    assert left > 0.1
    assert left == pytest.approx(right, abs=1e-3)


@needs_ffmpeg
def test_to_flac_with_the_real_ffmpeg_fails_on_a_file_that_is_not_audio(
    tmp_path: Path,
) -> None:
    src, dst = tmp_path / "junk.webm", tmp_path / "junk.flac"
    src.write_bytes(b"this is not a media file at all")

    with pytest.raises(youtube.FfmpegError, match=r"ffmpeg failed \(exit status"):
        youtube.to_flac(src, dst)

    assert not dst.exists()
