"""Comparing the mic's pitch with the reference melody, and the lag between.

Cents are `1200 * log2(f / ref)`: octave-exact. The octave-folded error wraps
that into +-600. The lag scan runs from -400 to +400 ms in 10 ms steps; at lag
`L` a frame at song time `t` is compared with the reference at `t - L`, so a
positive lag means the mic is late (the song's own vocal arriving through the
speakers is the usual case). The best lag maximises the share of comparable
frames within 30 cents, octave-exact; shares within 1 % of each other go to
the lower median error, then to the lag nearest zero.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from encore_service.take_analysis.constants import (
    ANY_OCTAVE_CENTS,
    BLEED_MATCH_CENTS,
    LAG_MIN_COMPARABLE,
    LAG_RANGE_MS,
    LAG_STEADY_MS,
    LAG_STEP_MS,
    LAG_WINDOW_MIN_FRAMES,
    LAG_WINDOW_S,
)
from encore_service.take_analysis.results import MatchStats
from encore_service.take_analysis.schema import Reference

Floats = NDArray[np.float64]
LAGS_MS = np.arange(-LAG_RANGE_MS, LAG_RANGE_MS + 1, LAG_STEP_MS)


def fold(cents: Floats) -> Floats:
    """Octave-folded error: cents wrapped into [-600, 600)."""
    return (cents + 600.0) % 1200.0 - 600.0


@dataclass(frozen=True)
class PreparedRef:
    """The reference melody as one float array, built once per take.

    Converting the JSON list on every `compare_at` call cost 20 s of a 23 s
    analysis of a five-minute take.
    """

    hz: Floats
    t0_s: float
    hop_s: float

    @classmethod
    def of(cls, ref: Reference) -> "PreparedRef":
        """Prepare a parsed reference."""
        return cls(np.asarray(ref.f0Hz, dtype=np.float64), ref.t0S, ref.hopS)


@dataclass
class Lagged:
    """The comparable frames at one lag: their cents and which frames they are."""

    cents: Floats
    which: NDArray[np.bool_]


def compare_at(t: Floats, pitch: Floats, ref: PreparedRef, lag_ms: float) -> Lagged:
    """Octave-exact error of each frame against the reference at one lag."""
    idx = np.rint((t - lag_ms / 1000.0 - ref.t0_s) / ref.hop_s).astype(np.int64)
    ok = (idx >= 0) & (idx < len(ref.hz)) & (pitch > 0)
    r = np.zeros(len(t))
    r[ok] = ref.hz[idx[ok]]
    ok &= r > 0
    return Lagged(1200.0 * np.log2(pitch[ok] / r[ok]), ok)


def best_lag(
    t: Floats, pitch: Floats, ref: PreparedRef
) -> tuple[int, float, int] | None:
    """(lag in ms, share within 30 c, comparable frames) at the best lag."""
    best: tuple[tuple[float, float, int], int, float, int] | None = None
    for lag in LAGS_MS:
        cents = compare_at(t, pitch, ref, float(lag)).cents
        if len(cents) < LAG_MIN_COMPARABLE:
            continue
        share = float(np.mean(np.abs(cents) <= BLEED_MATCH_CENTS))
        # Within a plateau of equal shares the lag with the smallest typical
        # error is the middle of it; the shares alone would pick its edge.
        key = (round(share, 2), -float(np.median(np.abs(cents))), -abs(int(lag)))
        if best is None or key > best[0]:
            best = (key, int(lag), share, len(cents))
    return None if best is None else best[1:]


def window_lags(t: Floats, pitch: Floats, ref: PreparedRef) -> list[int]:
    """The best lag of each 2.5 s sub-window with enough frames to say."""
    lags: list[int] = []
    if len(t) == 0:
        return lags
    start = float(t.min())
    while start <= float(t.max()):
        inside = (t >= start) & (t < start + LAG_WINDOW_S)
        if int(inside.sum()) >= LAG_WINDOW_MIN_FRAMES:
            found = best_lag(t[inside], pitch[inside], ref)
            if found:
                lags.append(found[0])
        start += LAG_WINDOW_S
    return lags


def match_stats(t: Floats, pitch: Floats, ref: PreparedRef) -> MatchStats | None:
    """Match numbers over frames that are voiced and clear, or None."""
    found = best_lag(t, pitch, ref)
    if found is None:
        return None
    lag, share, count = found
    cents = compare_at(t, pitch, ref, float(lag)).cents
    folded = fold(cents)
    at_zero = compare_at(t, pitch, ref, 0.0).cents
    lags = window_lags(t, pitch, ref)
    steady: bool | None = None
    if len(lags) >= 2:
        steady = all(abs(w - lag) <= LAG_STEADY_MS for w in lags)
    return MatchStats(
        comparable=count,
        lag_ms=lag,
        share_exact=share,
        share_any_octave=float(np.mean(np.abs(folded) <= ANY_OCTAVE_CENTS)),
        median_abs_cents=float(np.median(np.abs(cents))),
        median_folded_cents=float(np.median(np.abs(folded))),
        share_at_zero_lag=(
            float(np.mean(np.abs(at_zero) <= BLEED_MATCH_CENTS))
            if len(at_zero)
            else 0.0
        ),
        lag_steady=steady,
        window_lags_ms=lags,
    )
