"""YouTube access for the fetch step: link parsing, lookup, download, FLAC.

A pasted link becomes an 11-character video id (`parse_youtube_url`), yt-dlp
says what the video is (`lookup`), downloads its best audio stream
(`download_audio`) and ffmpeg writes that as FLAC (`to_flac`). yt-dlp is driven
through its Python API with a fixed set of options and is only ever given
`canonical_url(video_id)`, never the text that was pasted, so no other site or
extractor can be reached through a link. The routes and the fetch step call
these functions through this module, which is where tests replace them, so CI
never touches the network. See "Song sources" in docs/ARCHITECTURE.md.
"""

import re
import shutil
import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yt_dlp
from pydantic import BaseModel

from encore_service.config import Settings

# Called with how far a step has got, from 0 to 1.
Report = Callable[[float], None]
# What yt-dlp calls with each progress event of a download.
ProgressHook = Callable[[Mapping[str, Any]], None]

# A pasted link longer than this is not a link someone typed or copied.
MAX_LINK_CHARS = 2048
# Hosts a link may name, compared whole: a port, a user name or a look-alike
# such as youtube.com.example.org changes the text and so fails the match.
_SHORT_HOST = "youtu.be"
_HOSTS = frozenset(
    {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        _SHORT_HOST,
        "www.youtube-nocookie.com",
    }
)
_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{11}")
# A scheme as written in front of "//". Anything else is read as no scheme.
_SCHEME_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
# /shorts/ID, /embed/ID, /live/ID and /v/ID, each with an optional last slash.
_PATH_ID_PATTERN = re.compile(r"/(?:shorts|embed|live|v)/([^/]+)/?")
_SHORT_PATH_ID_PATTERN = re.compile(r"/([^/]+)/?")
# Two embed paths are exactly 11 characters of the id alphabet and name a
# playlist or a channel's stream, not a video.
_NOT_VIDEO_IDS = frozenset({"videoseries", "live_stream"})

# yt-dlp's live_status values for a video with no finished recording to fetch.
_LIVE_STATUSES = frozenset({"is_live", "is_upcoming", "post_live"})
_SOCKET_TIMEOUT_S = 15
# Fraction of the fetch step that downloading fills; conversion is the rest.
DOWNLOAD_SHARE = 0.85
# yt-dlp names the file after this stem; its extension depends on the format.
_DOWNLOAD_STEM = "download"
# Any extension will do when asking yt-dlp which folder it would save into.
_PROBE_EXT = "webm"
_PARTIAL_SUFFIXES = frozenset({".part", ".ytdl", ".temp"})
_ERROR_PREFIX = re.compile(r"^(?:ERROR:\s*)+")

# ffmpeg converts a 15-minute song in seconds; this only ends a hung process.
_FFMPEG_TIMEOUT_S = 600
_STDERR_TAIL_CHARS = 500
FFMPEG_MISSING = "ffmpeg is not on PATH; see service/README.md (GPU setup, step 1)"
# Shown after every yt-dlp failure: YouTube changes break it every few weeks.
UPDATE_HINT = (
    "If YouTube links keep failing, update yt-dlp: "
    "cd service && uv lock --upgrade-package yt-dlp && uv sync --inexact"
)
NO_RUNTIME_NOTE = (
    "No JavaScript runtime (Node or Deno) was found on PATH, which YouTube "
    "extraction needs; see service/README.md (YouTube links)."
)

# JavaScript runtimes yt-dlp can use to solve YouTube's player challenges, as
# the name it knows them by and the program to look for.
_JS_RUNTIMES = (("deno", "deno"), ("node", "node"))


class YouTubeError(RuntimeError):
    """A YouTube operation failed; the message is worded for the person."""


class YtDlpError(YouTubeError):
    """yt-dlp could not look up or download the video; carries its message."""


class FfmpegError(YouTubeError):
    """ffmpeg is missing or failed to convert; carries why."""


class VideoInfo(BaseModel):
    """What yt-dlp reports about a video, without downloading it."""

    video_id: str
    title: str
    duration_s: float | None = None  # None when YouTube gives no length
    is_live: bool = False  # live, upcoming or just ended: nothing to fetch yet
    uploader: str | None = None


def parse_youtube_url(text: str) -> str | None:
    """The video id in a pasted YouTube link, or None when it is not one.

    Takes a link to exactly one video on a known YouTube host over https, or
    the same without its scheme (`youtu.be/ID`), whose path is /watch?v=ID,
    /shorts/ID, /embed/ID, /live/ID or /v/ID, or /ID on youtu.be. Other
    parameters, such as a playlist or a start time, are ignored. Playlists,
    channels, other hosts and plain http are all refused.
    """
    text = text.strip()
    if not text or len(text) > MAX_LINK_CHARS:
        return None
    # No whitespace or control character belongs inside a link. urlsplit
    # would silently drop a tab or newline and accept what was not pasted.
    if any(char.isspace() or not char.isprintable() for char in text):
        return None

    scheme = _SCHEME_PATTERN.match(text)
    if scheme is None:
        text = f"https://{text}"
    elif scheme.group().lower() != "https://":
        return None
    try:
        parts = urlsplit(text)
    except ValueError:
        return None

    # ASCII only: str.lower() maps some other characters, such as the Kelvin
    # sign, onto ASCII letters and would let a look-alike host through.
    host = parts.netloc.lower() if parts.netloc.isascii() else ""
    if host not in _HOSTS:
        return None

    candidate: str | None
    if host == _SHORT_HOST:
        match = _SHORT_PATH_ID_PATTERN.fullmatch(parts.path)
        candidate = match.group(1) if match else None
    elif parts.path == "/watch":
        candidate = _first_param(parts.query, "v")
    else:
        match = _PATH_ID_PATTERN.fullmatch(parts.path)
        candidate = match.group(1) if match else None

    if candidate is None or candidate in _NOT_VIDEO_IDS:
        return None
    return candidate if _ID_PATTERN.fullmatch(candidate) else None


def _first_param(query: str, name: str) -> str | None:
    """The raw value of the first `name=` in a query string, or None."""
    # Not unquoted: an id is plain characters, so an escape never makes one.
    for pair in query.split("&"):
        key, _, value = pair.partition("=")
        if key == name:
            return value
    return None


def canonical_url(video_id: str) -> str:
    """The one URL yt-dlp is ever given for a video; ValueError for a bad id."""
    if _ID_PATTERN.fullmatch(video_id) is None:
        raise ValueError(f"Not a YouTube video id: {video_id!r}")
    return f"https://www.youtube.com/watch?v={video_id}"


def js_runtimes() -> dict[str, dict[str, str]]:
    """JavaScript runtimes on PATH, in the form yt-dlp's option takes them.

    YouTube hides its stream addresses behind challenges that yt-dlp solves
    by running YouTube's own player script, which needs a runtime. yt-dlp
    enables only Deno unless told otherwise, so every runtime found here is
    passed, and it uses the best one that is new enough.
    """
    found: dict[str, dict[str, str]] = {}
    for name, program in _JS_RUNTIMES:
        path = shutil.which(program)
        if path is not None:
            found[name] = {"path": path}
    return found


def describe_failure(what: str, error: Exception) -> str:
    """'<what>: <message>' for a yt-dlp failure, with what to try about it."""
    message = str(error).strip().rstrip(".") or type(error).__name__
    notes = [] if js_runtimes() else [NO_RUNTIME_NOTE]
    return f"{what}: {message}. {' '.join([*notes, UPDATE_HINT])}"


def _message_of(error: BaseException) -> str:
    """yt-dlp's message for an error, without its "ERROR:" prefix."""
    text = _ERROR_PREFIX.sub("", str(error).strip()).strip()
    return text or type(error).__name__


def _base_options(settings: Settings) -> dict[str, Any]:
    """The options every yt-dlp call gets; the request never adds to them.

    `settings` is taken so that an option derived from configuration has a
    place to go; none of the current settings applies to yt-dlp.
    """
    return {
        "quiet": True,
        "no_warnings": True,
        # Without this the error text of a terminal run carries colour codes.
        "no_color": True,
        # "quiet" does not stop the download bar, which would fill the
        # service log; the progress hook still reports to the status file.
        "noprogress": True,
        # A canonical URL is a single video, but a stray list= must never
        # turn into a playlist download.
        "noplaylist": True,
        "socket_timeout": _SOCKET_TIMEOUT_S,
        "js_runtimes": js_runtimes(),
    }


def lookup(video_id: str, settings: Settings) -> VideoInfo:
    """Ask yt-dlp about a video, without downloading; YtDlpError on failure."""
    url = canonical_url(video_id)
    options = {**_base_options(settings), "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise YtDlpError(_message_of(exc)) from exc
    if not isinstance(info, Mapping):
        raise YtDlpError("YouTube returned nothing about this video")

    duration = info.get("duration")
    return VideoInfo(
        video_id=video_id,
        title=str(info.get("title") or video_id),
        # A length of zero is YouTube not knowing, the same as no length.
        duration_s=(
            float(duration)
            if isinstance(duration, int | float) and duration > 0
            else None
        ),
        is_live=bool(info.get("is_live")) or info.get("live_status") in _LIVE_STATUSES,
        uploader=info.get("uploader") or None,
    )


def download_audio(
    video_id: str,
    dest_dir: Path,
    report: Report,
    settings: Settings,
) -> Path:
    """Download the best audio stream into `dest_dir`; returns the file.

    Progress goes to `report` from 0 up to DOWNLOAD_SHARE. The file is named
    `download.<ext>`, so a title never becomes a path, and is left exactly as
    YouTube served it: converting it is `to_flac`'s job.
    """
    url = canonical_url(video_id)
    options = {
        **_base_options(settings),
        "format": "bestaudio/best",
        "outtmpl": _output_template(dest_dir),
        "progress_hooks": [_progress_hook(report)],
    }
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            _require_destination(ydl, dest_dir)
            ydl.download([url])
    except YouTubeError:
        # Already worded for the person, and not yt-dlp's doing.
        raise
    except Exception as exc:
        raise YtDlpError(_message_of(exc)) from exc

    saved = [
        path
        for path in dest_dir.glob(f"{_DOWNLOAD_STEM}.*")
        if path.is_file() and path.suffix not in _PARTIAL_SUFFIXES
    ]
    if not saved:
        raise YtDlpError("yt-dlp finished without saving any audio")
    return max(saved, key=lambda path: path.stat().st_size)


def _output_template(dest_dir: Path) -> str:
    """yt-dlp's output template for `download.<ext>` inside `dest_dir`."""
    # A "%" in the folder name would be read as a template field.
    return f"{dest_dir.as_posix().replace('%', '%%')}/{_DOWNLOAD_STEM}.%(ext)s"


def _require_destination(ydl: yt_dlp.YoutubeDL, dest_dir: Path) -> None:
    """Refuse a folder that yt-dlp would save into somewhere else.

    yt-dlp expands $NAME and ${NAME} in an output template as a shell does,
    and has no way to write a literal $ ("$$" stays "$$"), so "%" can be
    escaped in `_output_template` but "$" cannot. A cache folder with one in
    its path would be downloaded into a different folder from the one read
    afterwards, and the step would fail with "saved no audio", hiding why.
    Asking yt-dlp where the file goes covers whatever else it expands, and
    lets through a $ it leaves alone, such as the one in a share named `c$`.
    """
    saved_to = ydl.prepare_filename({"ext": _PROBE_EXT})
    folder = Path(saved_to).parent if saved_to else None
    if folder == dest_dir:
        return
    raise YouTubeError(
        f"yt-dlp would save into {folder or 'an unknown folder'} instead of "
        f"{dest_dir}, because it expands things like $NAME in a folder path. "
        "Set ENCORE_CACHE_DIR to a path without a $."
    )


def _progress_hook(report: Report) -> ProgressHook:
    """A progress hook that reports 0 to DOWNLOAD_SHARE, never backwards."""
    best = 0.0

    def hook(event: Mapping[str, Any]) -> None:
        nonlocal best
        status = event.get("status")
        if status == "finished":
            fraction = 1.0
        elif status == "downloading":
            done = event.get("downloaded_bytes")
            total = event.get("total_bytes") or event.get("total_bytes_estimate")
            if not done or not total:
                return
            fraction = min(done / total, 1.0)
        else:
            return
        value = fraction * DOWNLOAD_SHARE
        # yt-dlp revises an estimated total as it goes, which can pull the
        # fraction back; the status file should only ever move forward.
        if value > best:
            best = value
            report(value)

    return hook


def to_flac(src: Path, dst: Path) -> None:
    """Convert `src` to 16-bit FLAC, at most stereo, at `dst`; FfmpegError."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise FfmpegError(FFMPEG_MISSING)
    # An argument list, never a shell string: nothing in a path is parsed.
    # Absolute paths, so one that starts with "-" is not read as an option.
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src.absolute()),
        "-vn",
        "-map",
        "0:a:0",
        "-c:a",
        "flac",
        "-sample_fmt",
        "s16",
        # At most stereo. YouTube's best stream can be 5.1, with the vocal in
        # the centre channel: keeping the first two channels would lose it,
        # while this downmix folds the centre into both. Mono and stereo pass
        # unchanged ("-ac 2" would upmix mono 3 dB quieter per side).
        "-af",
        "aformat=channel_layouts=mono|stereo",
        str(dst.absolute()),
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=_FFMPEG_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        dst.unlink(missing_ok=True)
        raise FfmpegError(
            f"ffmpeg did not finish within {_FFMPEG_TIMEOUT_S} s"
        ) from exc
    except OSError as exc:
        raise FfmpegError(f"ffmpeg could not be started: {exc}") from exc
    if result.returncode != 0:
        # A failed run can leave a stub that looks like a result.
        dst.unlink(missing_ok=True)
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        detail = f": {stderr[-_STDERR_TAIL_CHARS:]}" if stderr else ""
        raise FfmpegError(f"ffmpeg failed (exit status {result.returncode}){detail}")
