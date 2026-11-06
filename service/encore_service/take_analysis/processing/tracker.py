"""Tracker check: the browser's pitch frames against the service's tracker.

`--wav` and `--crepe` run torchcrepe (the service's optional `pitch` extra,
imported only here and only when asked) over the take's WAV at a 10 ms hop. A
tracker is any function `(mono samples, sample rate) -> f0 in Hz per 10 ms
frame, 0 where unvoiced`, so tests pass a stand-in and need no torchcrepe.

Time base: the WAV's sample `i` is at song time `startedAtSongS + i / rate -
latencyS`, the same song time the frames use, so frame `t` maps to tracker
frame `round((t - startedAtSongS + latencyS) / 0.01)`. Without `startedAtSongS`
the first frame is taken to sit at the WAV's start, and the note says so.

That map holds only while song time runs 1:1 with the WAV. A pause, buffering
or ad stops the frames while the WAV keeps recording, and a seek or a loop
wrap jumps song time, so only frames before the first such boundary are
compared, and the note says where it cut. A loop wrap is not logged as an
event, so a loop being set and a backward jump in frame time count too.

Numbers over frames both trackers have a pitch for:

- voicing agreement: share of all compared frames where both or neither are
  voiced;
- octave-error share: pairs whose difference is within 100 c of 1200 c;
- median cents difference: of the pairs that are not octave errors;
- jitter: std of the frame-to-frame cents step inside held spans (at least 10
  steps in a row where both trackers move under 50 c), browser and service
  measured on the same steps.
"""

import importlib
from collections.abc import Callable

import numpy as np
from numpy.typing import NDArray

from encore_service.take_analysis.constants import (
    FRAME_S,
    MAX_FRAME_GAP_S,
    TRACKER_MIN_FRAMES,
)
from encore_service.take_analysis.frames import FrameArrays
from encore_service.take_analysis.processing.models import TrackerComparison
from encore_service.take_analysis.schema import Event

Tracker = Callable[[NDArray[np.float32], int], NDArray[np.float64]]

OCTAVE_TOLERANCE_CENTS = 100
HELD_STEP_CENTS = 50
HELD_MIN_STEPS = 10
# Periodicity at or above which the service's tracker calls a frame voiced.
CREPE_VOICED = 0.5
INSTALL_HINT = "cd service && uv sync --inexact --extra pitch"


def crepe_tracker() -> tuple[Tracker | None, str | None]:
    """The torchcrepe tracker, or None and a one-line reason it is missing."""
    try:
        torch = importlib.import_module("torch")
        importlib.import_module("torchcrepe")
    except (ImportError, OSError) as exc:
        return None, f"torchcrepe is not available ({INSTALL_HINT}): {exc}"
    from encore_service.reference import CREPE_MODEL, CrepeTracker

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = CrepeTracker(CREPE_MODEL, device)

    def run(samples: NDArray[np.float32], rate: int) -> NDArray[np.float64]:
        f0, periodicity = model.track(samples, rate, lambda _: None)
        voiced = (periodicity >= CREPE_VOICED) & (f0 > 0)
        return np.where(voiced, f0, 0.0).astype(np.float64)

    return run, None


def _held_steps(sb: NDArray, sc: NDArray) -> NDArray[np.bool_]:
    """Steps inside runs of at least HELD_MIN_STEPS steps both move little."""
    small = (np.abs(sb) <= HELD_STEP_CENTS) & (np.abs(sc) <= HELD_STEP_CENTS)
    out = np.zeros(len(small), dtype=bool)
    start = None
    for i in range(len(small) + 1):
        on = i < len(small) and small[i]
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start >= HELD_MIN_STEPS:
                out[start:i] = True
            start = None
    return out


def first_boundary(
    fa: FrameArrays, events: list[Event], latency_s: float
) -> tuple[float, str] | None:
    """Frame time and a reason for the first break in song-time-equals-WAV-time."""
    found: list[tuple[float, str]] = []
    for e in events:
        # `songT` is raw transport time; frame `t` has the latency taken off.
        at = e.songT - latency_s
        if at < fa.origin:
            continue
        if e.kind == "player" and e.value != "playing":
            found.append((at, f"player {e.value}"))
        elif e.kind == "seek":
            found.append((at, "seek"))
        elif e.kind == "loop" and e.value:
            found.append((at, "loop set"))
    back = np.flatnonzero(np.diff(fa.t) < -MAX_FRAME_GAP_S)
    if len(back):
        found.append((float(fa.t[back[0]]), "jump back in frame time"))
    return min(found, key=lambda f: f[0]) if found else None


def compare_trackers(
    fa: FrameArrays,
    samples: NDArray[np.float32],
    rate: int,
    started_at_song_s: float | None,
    latency_s: float,
    tracker: Tracker,
    events: list[Event] | None = None,
) -> TrackerComparison:
    """Compare the browser's frames with `tracker` run over the WAV."""
    theirs = np.asarray(tracker(samples, rate), dtype=np.float64)
    zero = fa.origin if started_at_song_s is None else started_at_song_s - latency_s
    idx = np.rint((fa.t - zero) / FRAME_S).astype(np.int64)
    ok = (idx >= 0) & (idx < len(theirs))
    notes = (
        []
        if started_at_song_s is not None
        else ["no startedAtSongS: the WAV is assumed to start at the first frame"]
    )
    cut = first_boundary(fa, events or [], latency_s)
    if cut is not None:
        ok &= fa.t < cut[0]
        notes.append(
            f"compared only frames before {cut[1]} at song {cut[0]:.1f} s: the WAV "
            "and song time part ways after it"
        )
        if int(ok.sum()) < TRACKER_MIN_FRAMES:
            return TrackerComparison(
                available=False,
                note="; ".join(notes) + f"; fewer than {TRACKER_MIN_FRAMES} frames "
                "remain, so no comparison",
                frames_compared=0,
            )
    note = "; ".join(notes) or None
    if not ok.any():
        return TrackerComparison(
            available=False, note="no frame falls inside the WAV", frames_compared=0
        )
    b = np.where(ok, fa.pitch, 0.0)
    c = np.where(ok, theirs[np.clip(idx, 0, len(theirs) - 1)], 0.0)
    n = int(ok.sum())
    agree = float(np.sum(ok & ((b > 0) == (c > 0))) / n)
    both = ok & (b > 0) & (c > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        diff = 1200 * np.log2(b / c)
    octave = both & (np.abs(np.abs(diff) - 1200) <= OCTAVE_TOLERANCE_CENTS)
    plain = both & (np.abs(diff) < 600)
    pairs = int(both.sum())
    contiguous = np.diff(fa.t) <= MAX_FRAME_GAP_S
    usable = plain[:-1] & plain[1:] & contiguous & (np.diff(fa.t) > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        sb = 1200 * np.log2(b[1:] / b[:-1])
        sc = 1200 * np.log2(c[1:] / c[:-1])
    held = usable & _held_steps(np.where(usable, sb, 1e9), np.where(usable, sc, 1e9))
    jitter_b = float(np.std(sb[held])) if held.sum() > 1 else None
    jitter_c = float(np.std(sc[held])) if held.sum() > 1 else None
    return TrackerComparison(
        available=True,
        note=note,
        frames_compared=n,
        voicing_agreement=agree,
        octave_error_share=float(octave.sum() / pairs) if pairs else None,
        median_cents_diff=float(np.median(diff[plain])) if plain.any() else None,
        jitter_browser_cents=jitter_b,
        jitter_tracker_cents=jitter_c,
        jitter_samples=int(held.sum()),
    )
