"""A take's frames as numpy arrays on one time base, plus the floor under them.

Time bases (confirmed in `src/app/session/input.ts` `onFrame` and
`src/app/session/takes.ts` `saveTake`): a frame's `t`, a health sample's `t`,
an event's `songT` and the reference contour (`t0S + i * hopS`) are all song
time, with the recording latency already taken off the frame. An event's `at`
is wall seconds since the take started. The WAV's sample `i` sits at song
time `startedAtSongS + i / sampleRate - latencyS`.

*Take time*, the clock sections are given in, is song time minus the song time
of the first frame, so 0 is where the frames begin. It equals the WAV's clock
when the song played straight through; a pause or seek makes the two differ,
which is why every section prints both.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from encore_service.take_analysis.constants import DEFAULT_CLARITY, SILENCE_DB
from encore_service.take_analysis.schema import TakeFile

Floats = NDArray[np.float64]


@dataclass
class FrameArrays:
    """Per-frame arrays, in the order the frames arrived."""

    origin: float
    t: Floats
    take_t: Floats
    pitch: Floats
    published: Floats
    clarity: Floats
    level_db: Floats
    floor_db: Floats
    gate: NDArray[np.str_]
    app_bleed: NDArray[np.str_]
    has_gate: bool
    clarity_threshold: float

    @property
    def usable(self) -> NDArray[np.bool_]:
        """Voiced and clear enough to compare, whatever the level."""
        return (self.pitch > 0) & (self.clarity >= self.clarity_threshold)


def rms_to_db(rms: Floats) -> Floats:
    """Level in dB re full scale; silence and junk read as SILENCE_DB."""
    safe = np.where(rms > 0, rms, 1.0)
    return np.where(rms > 0, np.maximum(SILENCE_DB, 20 * np.log10(safe)), SILENCE_DB)


def clarity_threshold_of(take: TakeFile) -> float:
    """The app's clarity threshold for the take, or the app's default."""
    if take.mic and take.mic.clarityThreshold is not None:
        return take.mic.clarityThreshold
    analysis = take.trace.environment.analysis if take.trace else None
    value = (analysis or {}).get("clarityThreshold")
    return float(value) if isinstance(value, int | float) else DEFAULT_CLARITY


def _step_lookup(times: Floats, values: NDArray, at: Floats) -> NDArray:
    """The value of the latest sample at or before each `at` (first if none)."""
    order = np.argsort(times, kind="stable")
    idx = np.searchsorted(times[order], at, side="right") - 1
    return values[order][np.clip(idx, 0, len(times) - 1)]


def build_frames(take: TakeFile) -> FrameArrays:
    """Arrays for every frame, with the floor and app bleed state looked up."""
    frames = take.frames
    t = np.array([f.t for f in frames], dtype=np.float64)
    published = np.array([f.f0 for f in frames], dtype=np.float64)
    # The tracker's own reading when the app kept one, else what it published.
    pitch = np.array(
        [f.rawF0 if f.rawF0 is not None else f.f0 for f in frames], dtype=np.float64
    )
    clarity = np.array([f.clarity for f in frames], dtype=np.float64)
    rms = np.array([f.rms for f in frames], dtype=np.float64)
    gate = np.array([f.gate or "" for f in frames], dtype=np.str_)
    health = take.trace.health if take.trace else []
    if health:
        ht = np.array([h.t for h in health], dtype=np.float64)
        floor = _step_lookup(ht, np.array([h.floorDb for h in health]), t)
        bleed = _step_lookup(ht, np.array([h.bleed for h in health], dtype=np.str_), t)
    else:
        start = take.mic.noiseFloorDb if take.mic else None
        floor = np.full(len(frames), np.nan if start is None else start)
        bleed = np.full(len(frames), "", dtype=np.str_)
    origin = float(t[0])
    return FrameArrays(
        origin=origin,
        t=t,
        take_t=t - origin,
        pitch=pitch,
        published=published,
        clarity=clarity,
        level_db=rms_to_db(rms),
        floor_db=np.asarray(floor, dtype=np.float64),
        gate=gate,
        app_bleed=np.asarray(bleed, dtype=np.str_),
        has_gate=take.version >= 2,
        clarity_threshold=clarity_threshold_of(take),
    )
