"""Latency check: the lag the take lines up at, against the latency it got.

A frame's song time already has `latencyS` taken off. If the mic follows the
reference at a lag `L` (positive: the mic is late), the app took off `L` too
little, so the latency that would line the take up is `latencyS + L`. Bleed is
an exact copy of the song, so its lag is the cleaner measure; a singer's lag
also holds their own lead or lag, and the basis says which was used. Each is the
median of the best lags of the sections of that verdict (the marked sections
when there are any, else the windows).
"""

import numpy as np

from encore_service.take_analysis.processing.audit import basis_sections
from encore_service.take_analysis.processing.models import LatencyCheck
from encore_service.take_analysis.results import SectionResult
from encore_service.take_analysis.schema import TakeFile
from encore_service.take_analysis.sections import SectionSpec


def _median(lags: list[int]) -> float | None:
    return float(np.median(lags)) if lags else None


def run_latency(
    take: TakeFile, pairs: list[tuple[SectionSpec, SectionResult]]
) -> LatencyCheck:
    """The implied latency correction, or why there is none."""
    _, chosen = basis_sections(pairs)
    bleed = [
        s.match.lag_ms for _, s in chosen if s.verdict == "likely bleed" and s.match
    ]
    singer = [s.match.lag_ms for _, s in chosen if s.verdict == "singer" and s.match]
    cal = take.trace.calibration if take.trace else None
    bleed_lag, singer_lag = _median(bleed), _median(singer)
    lag, basis, note = None, None, None
    if bleed_lag is not None:
        lag, basis = bleed_lag, "bleed (an exact copy of the song)"
    elif singer_lag is not None:
        lag, basis = singer_lag, "singing (includes the singer's own lead or lag)"
    else:
        note = "not enough data: no bleed or singing section with a lag"
    latency = take.take.latencyS
    return LatencyCheck(
        take_latency_s=latency,
        embed_offset_s=take.mic.embedOffsetS if take.mic else None,
        calibration_delay_s=cal.delayS if cal else None,
        calibration_confidence=cal.confidence if cal else None,
        calibration_spread_s=cal.spreadS if cal else None,
        bleed_lag_ms=bleed_lag,
        bleed_sections=len(bleed),
        singer_lag_ms=singer_lag,
        singer_sections=len(singer),
        implied_latency_s=None if lag is None else latency + lag / 1000.0,
        correction_ms=lag,
        basis=basis,
        note=note,
    )
