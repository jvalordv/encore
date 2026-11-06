"""Measuring one section and giving it a verdict.

Pitch for analysis is `rawF0` when the frame has one, else `f0`. A frame is
*usable* when its pitch is above zero and its clarity meets the app's
threshold; *active* when it is also at least `DRAW_MARGIN_DB` above the floor
(the floor from the health samples, or the mic's starting floor, or none:
then level is not judged and the reason says so).

The verdict, in this order:

1. likely bleed: at least `BLEED_MIN_FRAMES` usable frames comparable with the
   reference, at the best lag at least `BLEED_MIN_MATCH` of them within
   `BLEED_MATCH_CENTS` octave-exact, their median absolute error under
   `BLEED_MAX_MEDIAN_CENTS`, and the lag steady: each 2.5 s sub-window's best
   lag within 30 ms of the section's (not judged when fewer than two
   sub-windows have 50 frames; the reason says so). The mic then follows the
   melody as tightly as a recording of it would. The level is not part of this
   rule: speakers reach the mic quietly, under the app's own gate.
2. silence: otherwise, under 15 % of the frames active.
3. no reference: otherwise "unclear", saying it cannot tell bleed from
   singing; level and voicing are all there is.
4. singer: at least 30 % of the frames active, with a looser match or a
   lag that drifts.
5. unclear: anything else (too few frames to compare, or in between).
"""

import numpy as np
from numpy.typing import NDArray

from encore_service.take_analysis.constants import (
    BLEED_MATCH_CENTS,
    BLEED_MAX_MEDIAN_CENTS,
    BLEED_MIN_FRAMES,
    BLEED_MIN_MATCH,
    DRAW_MARGIN_DB,
    SILENCE_MAX_ACTIVE,
    SINGER_MIN_ACTIVE,
)
from encore_service.take_analysis.frames import FrameArrays
from encore_service.take_analysis.match import PreparedRef, match_stats
from encore_service.take_analysis.results import MatchStats, SectionResult, Verdict
from encore_service.take_analysis.schema import HealthSample
from encore_service.take_analysis.sections import SectionSpec


def mask_of(spec: SectionSpec, fa: FrameArrays) -> NDArray[np.bool_]:
    """The frames whose take time falls in the section."""
    return (fa.take_t >= spec.take_start) & (fa.take_t < spec.take_end)


def active_mask(
    fa: FrameArrays, margin_db: float = DRAW_MARGIN_DB
) -> NDArray[np.bool_]:
    """Usable frames over the floor (all usable ones where no floor is known)."""
    over = fa.level_db >= fa.floor_db + margin_db
    return fa.usable & (over | np.isnan(fa.floor_db))


def bleed_signature(m: MatchStats | None) -> bool:
    """True when the match numbers meet the app's bleed rule with a steady lag."""
    return (
        m is not None
        and m.comparable >= BLEED_MIN_FRAMES
        and m.share_exact >= BLEED_MIN_MATCH
        and m.median_abs_cents < BLEED_MAX_MEDIAN_CENTS
        and m.lag_steady is not False
    )


def decide(
    frames: int,
    active: float,
    m: MatchStats | None,
    has_reference: bool,
    has_floor: bool,
) -> tuple[Verdict, str]:
    """The verdict and the plain reason for it."""
    if frames == 0:
        return "unclear", "no frames in this stretch"
    if bleed_signature(m):
        assert m is not None
        steady = "steady lag" if m.lag_steady else "lag not checked (short)"
        return "likely bleed", (
            f"{m.share_exact:.0%} within {BLEED_MATCH_CENTS} c of the melody at "
            f"{m.lag_ms:+d} ms, median {m.median_abs_cents:.0f} c, {steady}"
        )
    level = "" if has_floor else " (level not judged: no floor known)"
    if active < SILENCE_MAX_ACTIVE:
        return "silence", f"{active:.0%} of frames voiced and over the floor{level}"
    if not has_reference or m is None:
        why = "no reference" if not has_reference else "too few frames to compare"
        return "unclear", (
            f"{active:.0%} voiced and over the floor; {why}, so it cannot "
            f"tell bleed from singing{level}"
        )
    if active >= SINGER_MIN_ACTIVE:
        drift = "lag drifts" if m.lag_steady is False else "looser match"
        return "singer", (
            f"{active:.0%} active, {m.share_exact:.0%} within "
            f"{BLEED_MATCH_CENTS} c at {m.lag_ms:+d} ms, median "
            f"{m.median_abs_cents:.0f} c, {drift}{level}"
        )
    return "unclear", f"{active:.0%} active, between silence and singing{level}"


def _pct(values: NDArray[np.float64], q: float) -> float | None:
    return float(np.percentile(values, q)) if len(values) else None


def analyse_section(
    spec: SectionSpec,
    fa: FrameArrays,
    ref: PreparedRef | None,
    health: list[HealthSample],
) -> SectionResult:
    """All numbers and the verdict for one section."""
    mask = mask_of(spec, fa)
    n = int(mask.sum())
    song_start, song_end = spec.take_start + fa.origin, spec.take_end + fa.origin
    base = {
        "kind": spec.kind,
        "label": spec.label,
        "mark": spec.mark,
        "take_start_s": spec.take_start,
        "take_end_s": spec.take_end,
        "song_start_s": song_start,
        "song_end_s": song_end,
        "frames": n,
    }
    if n == 0:
        return SectionResult(
            **base, voiced_share=None, gate_pass_share=None, gate_reasons=None,
            level_median_db=None, level_p90_db=None, floor_db=None,
            active_share=None, match=None, bleed_state_share=None,
            verdict="unclear", reason="no frames in this stretch",
        )  # fmt: skip
    pitch, level = fa.pitch[mask], fa.level_db[mask]
    floors = fa.floor_db[mask]
    floor = None if np.isnan(floors).all() else float(np.nanmedian(floors))
    gate_share: float | None = None
    reasons: dict[str, int] | None = None
    if fa.has_gate:
        gates = fa.gate[mask]
        gate_share = float(np.mean(gates == ""))
        reasons = {g: int(np.sum(gates == g)) for g in sorted(set(gates)) if g}
    active = float(np.mean(active_mask(fa)[mask]))
    usable = fa.usable[mask]
    match = (
        match_stats(fa.t[mask][usable], pitch[usable], ref) if ref is not None else None
    )
    inside = [h for h in health if song_start <= h.t < song_end]
    state = float(np.mean([h.bleed == "suspected" for h in inside])) if inside else None
    verdict, reason = decide(n, active, match, ref is not None, floor is not None)
    return SectionResult(
        **base,
        voiced_share=float(np.mean(pitch > 0)),
        gate_pass_share=gate_share,
        gate_reasons=reasons,
        level_median_db=_pct(level, 50),
        level_p90_db=_pct(level, 90),
        floor_db=floor,
        active_share=active,
        match=match,
        bleed_state_share=state,
        verdict=verdict,
        reason=reason,
    )
