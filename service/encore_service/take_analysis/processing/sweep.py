"""What-if sweep: re-run the gate and the bleed rule over a small grid.

The gate is `pitch > 0`, `clarity >= threshold`, and level at or above
`min(floor, ceiling) + margin`. The floor is the one the app recorded in the
health samples; the ceiling re-clamps it, so a ceiling lower than the app's
(-35 dB) is modelled and a higher one changes nothing, because the app's own
floor tracker is not re-run. Grid: margin 4..16 dB, clarity 0.8..0.95 (and the
take's own), ceiling -35..-50 dB.

With marked sections, frames of silent-class sections are "silent" and frames
of singing-class ones "singing" (see `audit.section_class`). A setting is scored
by the share of the silent frames that pass now and are dropped, plus the share
of the singing frames that pass now and are kept; the best is the highest
score that beats the current setting. Without marks only the number of frames
each setting changes is reported.

The bleed rule is re-run on each marked section (else each window) at its best
lag: match cents 20..50, minimum match 0.5..0.8, maximum median 10..25 c, with
the lag steadiness unchanged. The best setting flags the fewest singing
sections, then the most silent-class ones, then differs least from the app's rule.
"""

import numpy as np
from numpy.typing import NDArray

from encore_service.take_analysis.constants import (
    BLEED_MIN_FRAMES,
    FLOOR_CEILING_DB,
)
from encore_service.take_analysis.frames import FrameArrays
from encore_service.take_analysis.match import PreparedRef, compare_at
from encore_service.take_analysis.measure import mask_of
from encore_service.take_analysis.processing.audit import basis_sections, section_class
from encore_service.take_analysis.processing.models import (
    BleedSetting,
    GateSetting,
    SweepResult,
)
from encore_service.take_analysis.results import SectionResult
from encore_service.take_analysis.sections import SectionSpec

MARGINS_DB = (4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0)
CLARITIES = (0.8, 0.85, 0.9, 0.95)
CEILINGS_DB = (-35.0, -40.0, -45.0, -50.0)
MATCH_CENTS = (20.0, 25.0, 30.0, 40.0, 50.0)
MIN_MATCHES = (0.5, 0.6, 0.7, 0.8)
MAX_MEDIANS = (10.0, 15.0, 20.0, 25.0)
# A score must beat the current setting's by this to be called better.
SCORE_EDGE = 1e-9

Mask = NDArray[np.bool_]


def gate_pass(fa: FrameArrays, margin: float, clarity: float, ceiling: float) -> Mask:
    """Which frames the gate would pass at these settings."""
    floor = np.minimum(fa.floor_db, ceiling)
    over = fa.level_db >= floor + margin
    return (fa.pitch > 0) & (fa.clarity >= clarity) & (over | np.isnan(fa.floor_db))


def _gate_rows(
    fa: FrameArrays, silent: Mask | None, singing: Mask | None
) -> list[GateSetting]:
    now = gate_pass(
        fa, fa.tuning.draw_margin_db, fa.clarity_threshold, FLOOR_CEILING_DB
    )
    silent_now = int(np.sum(now & silent)) if silent is not None else 0
    singing_now = int(np.sum(now & singing)) if singing is not None else 0
    clarities = tuple(dict.fromkeys((fa.clarity_threshold, *CLARITIES)))
    rows: list[GateSetting] = []
    # The value in force is always a row, even off the grid.
    for margin in dict.fromkeys((fa.tuning.draw_margin_db, *MARGINS_DB)):
        for clarity in clarities:
            for ceiling in CEILINGS_DB:
                new = gate_pass(fa, margin, clarity, ceiling)
                drop = keep = score = None
                s_pass = g_pass = 0
                if silent is not None and singing is not None:
                    s_pass = int(np.sum(new & silent))
                    g_pass = int(np.sum(new & singing))
                    if silent_now:
                        drop = 1.0 - s_pass / silent_now
                    if singing_now:
                        keep = int(np.sum(new & now & singing)) / singing_now
                    if drop is not None and keep is not None:
                        score = drop + keep
                rows.append(
                    GateSetting(
                        draw_margin_db=margin,
                        clarity=clarity,
                        ceiling_db=ceiling,
                        passing=int(new.sum()),
                        changed=int(np.sum(new != now)),
                        silent_pass=s_pass,
                        singing_pass=g_pass,
                        silent_dropped=drop,
                        singing_kept=keep,
                        score=score,
                    )
                )
    return rows


def is_current(row: GateSetting, fa: FrameArrays) -> bool:
    """True for the setting the app ran with."""
    return (
        row.draw_margin_db == fa.tuning.draw_margin_db
        and row.clarity == fa.clarity_threshold
        and row.ceiling_db == FLOOR_CEILING_DB
    )


def _bleed_flag(
    abs_cents: NDArray[np.float64], steady: bool | None, mc: float, mm: float, md: float
) -> bool:
    if len(abs_cents) < BLEED_MIN_FRAMES or steady is False:
        return False
    return bool(np.mean(abs_cents <= mc) >= mm and np.median(abs_cents) < md)


def _bleed_rows(
    fa: FrameArrays, chosen: list[tuple[SectionSpec, SectionResult]], ref: PreparedRef
) -> list[BleedSetting]:
    data = []
    for spec, sec in chosen:
        mask = mask_of(spec, fa) & fa.usable
        lag = sec.match.lag_ms if sec.match else 0
        cents = np.abs(compare_at(fa.t[mask], fa.pitch[mask], ref, float(lag)).cents)
        steady = sec.match.lag_steady if sec.match else None
        data.append((section_class(sec), cents, steady))
    tn = fa.tuning
    base = [
        _bleed_flag(
            c, st, tn.bleed_match_cents, tn.bleed_min_match, tn.bleed_max_median_cents
        )
        for _, c, st in data
    ]
    rows: list[BleedSetting] = []
    for mc in dict.fromkeys((tn.bleed_match_cents, *MATCH_CENTS)):
        for mm in dict.fromkeys((tn.bleed_min_match, *MIN_MATCHES)):
            for md in dict.fromkeys((tn.bleed_max_median_cents, *MAX_MEDIANS)):
                flags = [_bleed_flag(c, st, mc, mm, md) for _, c, st in data]
                rows.append(
                    BleedSetting(
                        match_cents=mc,
                        min_match=mm,
                        max_median_cents=md,
                        bleed_sections=sum(flags),
                        silent_flagged=sum(
                            f
                            for f, d in zip(flags, data, strict=True)
                            if d[0] == "silent"
                        ),
                        singing_flagged=sum(
                            f
                            for f, d in zip(flags, data, strict=True)
                            if d[0] == "singing"
                        ),
                        flips=sum(f != b for f, b in zip(flags, base, strict=True)),
                    )
                )
    return rows


def pick_best_bleed(rows: list[BleedSetting]) -> BleedSetting:
    """Fewest singing sections flagged, then most silent-class ones, then fewest flips.

    A stricter rule that also stops flagging the true bleed section must not
    win a tie on singing false alarms, so detection ranks second.
    """
    return min(rows, key=lambda r: (r.singing_flagged, -r.silent_flagged, r.flips))


def run_sweep(
    fa: FrameArrays,
    pairs: list[tuple[SectionSpec, SectionResult]],
    ref: PreparedRef | None,
) -> SweepResult:
    """The gate and bleed sweeps, with the best setting of each when marks allow."""
    basis, chosen = basis_sections(pairs)
    marked = basis == "marked sections"
    silent = singing = None
    note = None
    if marked:
        silent = np.zeros(len(fa.t), dtype=bool)
        singing = np.zeros(len(fa.t), dtype=bool)
        for spec, sec in chosen:
            cls = section_class(sec)
            if cls == "silent":
                silent |= mask_of(spec, fa)
            elif cls == "singing":
                singing |= mask_of(spec, fa)
        if not silent.any() or not singing.any():
            note = "need both a silent and a singing marked section to separate them"
    else:
        note = "no sections marked: frames each setting would change only"
    gate = _gate_rows(fa, silent, singing)
    current = next((r for r in gate if is_current(r, fa)), None)
    best = None
    if current is not None and current.score is not None:
        edge = current.score + SCORE_EDGE
        scored = [r for r in gate if r.score is not None and r.score > edge]
        best = max(scored, key=lambda r: (r.score or 0.0, -r.changed), default=None)
    bleed = _bleed_rows(fa, chosen, ref) if ref is not None else []
    best_bleed = None
    if bleed and marked:
        best_bleed = pick_best_bleed(bleed)
    return SweepResult(
        classes_from=basis,
        note=note,
        current=current,
        best_gate=best,
        gate=gate,
        best_bleed=best_bleed,
        bleed=bleed,
    )
