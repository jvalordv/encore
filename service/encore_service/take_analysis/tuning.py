"""The app's tunable values in force: the baseline of the sweep and the audit.

A version 3 take records them in `trace.environment.tuning`; older takes get
the mirrored constants. Kept apart from `constants.py` so that file stays a
plain list of numbers.
"""

from dataclasses import dataclass

from encore_service.take_analysis.constants import (
    BLEED_MATCH_CENTS,
    BLEED_MAX_MEDIAN_CENTS,
    BLEED_MIN_MATCH,
    DEFAULT_CLARITY,
    DRAW_MARGIN_DB,
)
from encore_service.take_analysis.schema import TakeFile


@dataclass(frozen=True)
class TuningValues:
    """The five settings the Mic check can advise on."""

    draw_margin_db: float = DRAW_MARGIN_DB
    clarity_threshold: float = DEFAULT_CLARITY
    bleed_match_cents: float = BLEED_MATCH_CENTS
    bleed_min_match: float = BLEED_MIN_MATCH
    bleed_max_median_cents: float = BLEED_MAX_MEDIAN_CENTS


def tuning_of(take: TakeFile, clarity_threshold: float) -> TuningValues:
    """What was in force: the trace's tuning where it has a value, else the
    mirrored constants (and the clarity the frames were read with)."""
    base = TuningValues(clarity_threshold=clarity_threshold)
    given = take.trace.environment.tuning if take.trace else None
    if given is None:
        return base
    return TuningValues(
        draw_margin_db=_pick(given.drawMarginDb, base.draw_margin_db),
        clarity_threshold=_pick(given.clarityThreshold, base.clarity_threshold),
        bleed_match_cents=_pick(given.bleedMatchCents, base.bleed_match_cents),
        bleed_min_match=_pick(given.bleedMinMatch, base.bleed_min_match),
        bleed_max_median_cents=_pick(
            given.bleedMaxMedianCents, base.bleed_max_median_cents
        ),
    )


def _pick(value: float | None, fallback: float) -> float:
    return fallback if value is None else value
