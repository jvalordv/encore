"""Decision audit: what the app decided against what the raw frames show.

Per section, from the app's stored gate verdicts (version 2 only):

- *too strict*: in a singing section, frames the gate dropped as `quiet` or
  `unclear` that still carry clear pitch (clarity at least 0.7, raw pitch above
  zero) near the reference (within 50 c octave-exact at the section's best
  lag), or, with no reference, steady pitch (within 50 c of both neighbours).
- *leaked*: frames that passed the gate in a section that is silent (marked
  silent, or judged silence or likely bleed).
- *bleed disagree*: frames where the app's bleed state contradicts the
  section's verdict (app says ok in a likely-bleed section, or suspected in
  one judged otherwise); only frames with an app state of ok or suspected and
  sections with a verdict other than unclear are compared.

A section's class is its mark (`silent`, `sing`) or, unmarked, silent for
silence and likely bleed, singing for singer. Totals add up the marked
sections when there are any, else the fixed windows (which tile the take once).
"""

import numpy as np
from numpy.typing import NDArray

from encore_service.take_analysis.frames import FrameArrays
from encore_service.take_analysis.match import PreparedRef, compare_at
from encore_service.take_analysis.measure import mask_of
from encore_service.take_analysis.processing.models import AuditResult, AuditRow
from encore_service.take_analysis.results import SectionResult
from encore_service.take_analysis.sections import SectionSpec

# Clarity a gated frame needs to count as carrying clear pitch.
CLEAR_CLARITY = 0.7
# Near the melody, or steady, in cents.
NEAR_CENTS = 50


def section_class(sec: SectionResult) -> str:
    """'silent', 'singing' or 'other', from the mark or else the verdict."""
    if sec.mark == "silent":
        return "silent"
    if sec.mark == "sing":
        return "singing"
    if sec.verdict in ("silence", "likely bleed"):
        return "silent"
    return "singing" if sec.verdict == "singer" else "other"


def basis_sections(
    pairs: list[tuple[SectionSpec, SectionResult]],
) -> tuple[str, list[tuple[SectionSpec, SectionResult]]]:
    """The sections totals are summed over, and the word for which they are."""
    marked = [p for p in pairs if p[0].kind == "marked"]
    if marked:
        return "marked sections", marked
    return "fixed windows", [p for p in pairs if p[0].kind == "window"]


def _steady(pitch: NDArray[np.float64]) -> NDArray[np.bool_]:
    """Frames within 50 c of both neighbours."""
    ok = np.zeros(len(pitch), dtype=bool)
    if len(pitch) < 3:
        return ok
    with np.errstate(divide="ignore", invalid="ignore"):
        step = np.abs(1200 * np.log2(pitch[1:] / pitch[:-1]))
    good = np.isfinite(step) & (step <= NEAR_CENTS)
    ok[1:-1] = good[:-1] & good[1:]
    return ok


def _near(
    fa: FrameArrays, mask: NDArray[np.bool_], ref: PreparedRef | None, lag_ms: int
) -> NDArray[np.bool_]:
    """For the section's frames: near the reference, or steady without one."""
    pitch = fa.pitch[mask]
    if ref is None:
        return _steady(pitch)
    lagged = compare_at(fa.t[mask], pitch, ref, float(lag_ms))
    near = np.zeros(len(pitch), dtype=bool)
    near[lagged.which] = np.abs(lagged.cents) <= NEAR_CENTS
    return near


def _row(
    spec: SectionSpec, sec: SectionResult, fa: FrameArrays, ref: PreparedRef | None
) -> AuditRow:
    mask = mask_of(spec, fa)
    cls = section_class(sec)
    gate = fa.gate[mask]
    quiet, unclear = int(np.sum(gate == "quiet")), int(np.sum(gate == "unclear"))
    passed = int(np.sum(gate == ""))
    strict = 0
    if cls == "singing" and quiet + unclear:
        dropped = ((gate == "quiet") | (gate == "unclear")) & (
            (fa.pitch[mask] > 0) & (fa.clarity[mask] >= CLEAR_CLARITY)
        )
        lag = sec.match.lag_ms if sec.match else 0
        strict = int(np.sum(dropped & _near(fa, mask, ref, lag)))
    bleed = fa.app_bleed[mask]
    suspected, ok = int(np.sum(bleed == "suspected")), int(np.sum(bleed == "ok"))
    disagree = 0
    if sec.verdict != "unclear":
        disagree = ok if sec.verdict == "likely bleed" else suspected
    return AuditRow(
        label=sec.label,
        verdict=sec.verdict,
        section_class=cls,
        frames=sec.frames,
        passed=passed,
        gated_quiet=quiet,
        gated_unclear=unclear,
        too_strict=strict,
        leaked=passed if cls == "silent" else 0,
        app_suspected=suspected,
        app_ok=ok,
        bleed_disagree=disagree,
    )


def run_audit(
    fa: FrameArrays,
    pairs: list[tuple[SectionSpec, SectionResult]],
    ref: PreparedRef | None,
) -> AuditResult:
    """The audit rows for the basis sections and their totals."""
    basis, chosen = basis_sections(pairs)
    if not fa.has_gate:
        return AuditResult(
            available=False,
            note="version 1 frames carry no gate verdict, so nothing to audit",
            basis=basis,
            rows=[],
            too_strict=0,
            gated_in_singing=0,
            leaked=0,
            passed_in_silent=0,
            bleed_disagree=0,
            bleed_compared=0,
        )
    rows = [_row(spec, sec, fa, ref) for spec, sec in chosen]
    return AuditResult(
        available=True,
        note=None,
        basis=basis,
        rows=rows,
        too_strict=sum(r.too_strict for r in rows),
        gated_in_singing=sum(
            r.gated_quiet + r.gated_unclear
            for r in rows
            if r.section_class == "singing"
        ),
        leaked=sum(r.leaked for r in rows),
        passed_in_silent=sum(r.passed for r in rows if r.section_class == "silent"),
        bleed_disagree=sum(r.bleed_disagree for r in rows),
        bleed_compared=sum(
            r.app_ok + r.app_suspected for r in rows if r.verdict != "unclear"
        ),
    )
