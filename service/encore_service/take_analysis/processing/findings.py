"""Findings: short measured statements a developer can act on.

Each line names the constant or step and the number behind it. Where the take
cannot say, the line says "not enough data" rather than guessing.
"""

from encore_service.take_analysis.constants import FLOOR_CEILING_DB
from encore_service.take_analysis.processing.models import (
    AuditResult,
    BleedSetting,
    GateSetting,
    LatencyCheck,
    SweepResult,
    TrackerComparison,
)
from encore_service.take_analysis.tuning import TuningValues

# A jitter ratio above this is called out.
JITTER_RATIO = 1.5


def _pct(x: float) -> str:
    return f"{x * 100:.0f} %"


def _changes(row: GateSetting, clarity_now: float, margin_now: float) -> str:
    parts = []
    if row.draw_margin_db != margin_now:
        parts.append(f"DRAW_MARGIN_DB {margin_now:g} -> {row.draw_margin_db:g}")
    if row.clarity != clarity_now:
        parts.append(f"clarity threshold {clarity_now:g} -> {row.clarity:g}")
    if row.ceiling_db != FLOOR_CEILING_DB:
        parts.append(f"FLOOR_CEILING_DB {FLOOR_CEILING_DB:g} -> {row.ceiling_db:g}")
    return ", ".join(parts)


def _gate_lines(audit: AuditResult) -> list[str]:
    if not audit.available:
        return [f"Decision audit: {audit.note}."]
    out: list[str] = []
    if audit.gated_in_singing:
        share = audit.too_strict / audit.gated_in_singing
        out.append(
            f"Gate too strict: {audit.too_strict} of {audit.gated_in_singing} frames "
            f"dropped in singing sections ({_pct(share)}) "
            f"had clear pitch near the melody or steady (DRAW_MARGIN_DB, "
            f"clarity threshold)."
        )
    else:
        out.append(
            "Gate too strict: not enough data (no frames dropped in a singing section)."
        )
    if audit.passed_in_silent:
        out.append(
            f"Gate leaked: {audit.leaked} frames passed the gate in silent or bleed "
            f"sections ({audit.basis})."
        )
    else:
        out.append(
            "Gate leaked: none passed in silent or bleed sections, or none exist "
            f"({audit.basis})."
        )
    if audit.bleed_compared:
        out.append(
            f"Bleed state: the app disagreed with the section verdict on "
            f"{audit.bleed_disagree} of {audit.bleed_compared} frames "
            f"({_pct(audit.bleed_disagree / audit.bleed_compared)})."
        )
    else:
        out.append("Bleed state: not enough data (no health samples or no verdicts).")
    return out


def _sweep_lines(
    sweep: SweepResult, clarity_now: float, margin_now: float
) -> list[str]:
    cur = sweep.current
    if cur is None:
        return ["Gate sweep: not enough data."]
    if sweep.best_gate is not None and sweep.best_gate.silent_dropped is not None:
        b = sweep.best_gate
        return [
            f"{_changes(b, clarity_now, margin_now)} would drop "
            f"{_pct(b.silent_dropped)} of the "
            f"frames that pass in the silent sections and keep "
            f"{_pct(b.singing_kept or 0.0)} of those that pass in the singing ones "
            f"({cur.silent_pass} and {cur.singing_pass} frames now)."
        ]
    if sweep.note:
        base = [
            r
            for r in sweep.gate
            if r.clarity == clarity_now and r.ceiling_db == FLOOR_CEILING_DB
        ]
        steps = ", ".join(f"{r.draw_margin_db:g} dB: {r.passing}" for r in base[::2])
        if "need both" in sweep.note:
            return [f"Gate sweep: not enough data ({sweep.note})."]
        return [
            f"Gate sweep (frames passing by DRAW_MARGIN_DB, others as now): {steps}."
        ]
    return [
        f"Gate sweep: no setting separates the silent from the singing sections "
        f"better than DRAW_MARGIN_DB {margin_now:g}, clarity {clarity_now:g} "
        f"({cur.silent_pass} silent frames pass now)."
    ]


def _bleed_lines(sweep: SweepResult, tn: TuningValues) -> list[str]:
    b: BleedSetting | None = sweep.best_bleed
    if b is None:
        return [
            "Bleed rule sweep: not enough data (needs marked sections and a reference)."
        ]
    now = next(
        (
            r
            for r in sweep.bleed
            if (r.match_cents, r.min_match, r.max_median_cents)
            == (tn.bleed_match_cents, tn.bleed_min_match, tn.bleed_max_median_cents)
        ),
        None,
    )
    if now is not None and now.singing_flagged == 0:
        return [
            f"Bleed rule: flags no singing section at BLEED_MATCH_CENTS "
            f"{tn.bleed_match_cents:g}, BLEED_MIN_MATCH {tn.bleed_min_match:g}, "
            f"BLEED_MAX_MEDIAN_CENTS {tn.bleed_max_median_cents:g}; "
            f"{now.silent_flagged} silent section(s) flagged."
        ]
    count = now.singing_flagged if now else 0
    return [
        f"Bleed rule false alarm: {count} singing section(s) flagged; "
        f"BLEED_MATCH_CENTS "
        f"{b.match_cents:g}, BLEED_MIN_MATCH {b.min_match:g}, BLEED_MAX_MEDIAN_CENTS "
        f"{b.max_median_cents:g} flags {b.singing_flagged}; it flags "
        f"{b.silent_flagged} silent section(s) against "
        f"{now.silent_flagged if now else 0} now."
    ]


def _latency_line(lat: LatencyCheck) -> str:
    cal = (
        f"calibration {lat.calibration_delay_s * 1000:.0f} ms "
        f"(confidence {lat.calibration_confidence:.2f}, spread "
        f"{(lat.calibration_spread_s or 0) * 1000:.0f} ms)"
        if lat.calibration_delay_s is not None
        else "no calibration kept"
    )
    if lat.correction_ms is None or lat.implied_latency_s is None:
        return (
            f"Latency: take used {lat.take_latency_s * 1000:.0f} ms, {cal}; {lat.note}."
        )
    return (
        f"Latency: take used {lat.take_latency_s * 1000:.0f} ms, {cal}; {lat.basis} "
        f"lines up at {lat.correction_ms:+.0f} ms, implying "
        f"{lat.implied_latency_s * 1000:.0f} ms."
    )


def _tracker_line(t: TrackerComparison) -> str:
    if not t.available or t.voicing_agreement is None:
        return f"Tracker check: {t.note or 'not run'}."
    cut = f" ({t.note})" if t.note else ""
    parts = [
        f"voicing agrees on {_pct(t.voicing_agreement)} of {t.frames_compared} frames",
        "octave errors "
        + (
            "not enough data"
            if t.octave_error_share is None
            else _pct(t.octave_error_share)
        ),
        "median difference "
        + (
            "not enough data"
            if t.median_cents_diff is None
            else f"{t.median_cents_diff:+.0f} c"
        ),
    ]
    if t.jitter_browser_cents is not None and t.jitter_tracker_cents:
        ratio = t.jitter_browser_cents / t.jitter_tracker_cents
        parts.append(
            f"held-note jitter {t.jitter_browser_cents:.1f} c browser vs "
            f"{t.jitter_tracker_cents:.1f} c service ({ratio:.1f}x"
            f"{', browser noisier' if ratio > JITTER_RATIO else ''})"
        )
    else:
        parts.append("jitter: not enough held notes")
    return "Tracker check: " + "; ".join(parts) + cut + "."


def build_findings(
    audit: AuditResult,
    sweep: SweepResult,
    latency: LatencyCheck,
    tracker: TrackerComparison,
    clarity_now: float,
    tuning: TuningValues | None = None,
) -> list[str]:
    """The findings, in the order a developer would act on them."""
    tn = tuning or TuningValues(clarity_threshold=clarity_now)
    return [
        *_gate_lines(audit),
        *_sweep_lines(sweep, clarity_now, tn.draw_margin_db),
        *_bleed_lines(sweep, tn),
        _latency_line(latency),
        _tracker_line(tracker),
    ]
