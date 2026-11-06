"""The Mic check's answer: findings, section verdicts and advised settings.

Wraps a `TakeAnalysis` of a take whose trace carries labelled sections (see
`sections.trace_marks`) into the response `POST /takes/analyse` returns.

Recommendations come from measured evidence only, and each one needs a stated
minimum, else the value stays `None` ("keep current") and `notes` says why:

- Draw margin and clarity: the gate sweep's best separation of the silent
  sections from the sung ones, when the current setting passes at least
  `MIN_SING_FRAMES` sung frames and the best keeps at least `MIN_SING_KEPT` of
  them (a setting that gives up singing to hush the room is not advised).
- The three bleed values: the sweep's best bleed rule, when at least one silent
  section is flagged. It must flag no sung section and every silent section
  the current rule flags, so it never loses a bleed the current rule catches.
- Latency: the take's latency plus the best lag in the `speakers` section, when
  that section had `BLEED_MIN_FRAMES` comparable frames and at least
  `LATENCY_MIN_SHARE` of them followed the melody, and it moves the value by
  `LATENCY_MIN_MOVE_S` or more.

Advised values are clamped to `BOUNDS`, the range the app accepts.
"""

from typing import Literal

from pydantic import BaseModel

from encore_service.take_analysis.constants import BLEED_MIN_FRAMES
from encore_service.take_analysis.frames import clarity_threshold_of
from encore_service.take_analysis.report import render
from encore_service.take_analysis.results import SectionResult, TakeAnalysis
from encore_service.take_analysis.schema import TakeFile
from encore_service.take_analysis.sections import trace_marks
from encore_service.take_analysis.tuning import TuningValues, tuning_of

MIN_SING_FRAMES = 100
MIN_SING_KEPT = 0.9
LATENCY_MIN_SHARE = 0.7
LATENCY_MIN_MOVE_S = 0.005
# (low, high) per setting: the sane range an advised value is clamped to.
BOUNDS: dict[str, tuple[float, float]] = {
    "draw_margin_db": (4.0, 20.0),
    "clarity_threshold": (0.5, 0.98),
    "bleed_match_cents": (10.0, 60.0),
    "bleed_min_match": (0.3, 0.9),
    "bleed_max_median_cents": (5.0, 30.0),
    "latency_s": (0.0, 2.0),
}
SPEAKERS = "speakers"


class Tuning(BaseModel):
    """The settings in force when the check was recorded."""

    draw_margin_db: float
    clarity_threshold: float
    bleed_match_cents: float
    bleed_min_match: float
    bleed_max_median_cents: float
    latency_s: float | None


class TuningRecommendation(BaseModel):
    """Advised settings; `None` means keep the current one."""

    draw_margin_db: float | None = None
    clarity_threshold: float | None = None
    bleed_match_cents: float | None = None
    bleed_min_match: float | None = None
    bleed_max_median_cents: float | None = None
    latency_s: float | None = None


class SectionVerdict(BaseModel):
    """What the analysis made of one labelled section, in song time."""

    label: str
    kind: Literal["silent", "sing"]
    verdict: Literal["silence", "singer", "likely_bleed", "unclear"]
    start_s: float
    end_s: float


class MicCheckAnalysis(BaseModel):
    """The response of `POST /takes/analyse`."""

    report_text: str
    findings: list[str]
    sections: list[SectionVerdict]
    current: Tuning
    recommended: TuningRecommendation
    notes: list[str]


def _clamp(name: str, value: float) -> float:
    low, high = BOUNDS[name]
    return round(min(high, max(low, value)), 3)


def _changed(name: str, value: float, current: float) -> float | None:
    """The clamped value, or None when it equals the current one."""
    clamped = _clamp(name, value)
    return None if abs(clamped - current) < 1e-9 else clamped


def _section_rows(
    take: TakeFile, result: TakeAnalysis
) -> tuple[list[SectionVerdict], dict[str, SectionResult]]:
    """One row per trace section, and the measured result by label."""
    sections = take.trace.sections if take.trace else []
    marked = [s for s in result.sections if s.kind == "marked"]
    # Marks were made from the kept sections in order, so results line up.
    kept = trace_marks(sections, take.frames[0].t)
    by_id = {id(sec): res for (_, sec), res in zip(kept, marked, strict=False)}
    rows: list[SectionVerdict] = []
    by_label: dict[str, SectionResult] = {}
    for sec in sections:
        res = by_id.get(id(sec))
        verdict = res.verdict.replace(" ", "_") if res else "unclear"
        rows.append(
            SectionVerdict(
                label=sec.label,
                kind="silent" if sec.kind == "silent" else "sing",
                verdict=verdict,  # type: ignore[arg-type]
                start_s=sec.startS,
                end_s=sec.endS,
            )
        )
        if res is not None:
            by_label[sec.label] = res
    return rows, by_label


def _gate(
    result: TakeAnalysis, tn: TuningValues, rec: TuningRecommendation
) -> list[str]:
    sweep = result.processing.sweep
    cur, best = sweep.current, sweep.best_gate
    if sweep.note or cur is None:
        return [f"Gate: nothing advised ({sweep.note or 'no current row'})."]
    if cur.singing_pass < MIN_SING_FRAMES:
        return [
            f"Gate: not enough data ({cur.singing_pass} sung frames pass now; "
            f"{MIN_SING_FRAMES} needed)."
        ]
    if best is None:
        return ["Gate: no setting separates silence from singing better than now."]
    kept = best.singing_kept or 0.0
    if kept < MIN_SING_KEPT:
        return [
            f"Gate: the best separation keeps only {kept:.0%} of sung frames; "
            f"not advised ({MIN_SING_KEPT:.0%} needed)."
        ]
    rec.draw_margin_db = _changed(
        "draw_margin_db", best.draw_margin_db, tn.draw_margin_db
    )
    rec.clarity_threshold = _changed(
        "clarity_threshold", best.clarity, tn.clarity_threshold
    )
    return []


def _bleed(
    result: TakeAnalysis, tn: TuningValues, rec: TuningRecommendation
) -> list[str]:
    sweep = result.processing.sweep
    best = sweep.best_bleed
    if best is None:
        return ["Bleed rule: nothing advised (needs labelled sections and a melody)."]
    now = next(
        (
            r
            for r in sweep.bleed
            if (r.match_cents, r.min_match, r.max_median_cents)
            == (tn.bleed_match_cents, tn.bleed_min_match, tn.bleed_max_median_cents)
        ),
        None,
    )
    if best.silent_flagged < 1:
        return ["Bleed rule: no silent section looks like bleed; nothing to tune."]
    if now is not None and best.silent_flagged < now.silent_flagged:
        return ["Bleed rule: every alternative would lose a bleed it now catches."]
    if best.singing_flagged:
        return ["Bleed rule: no rule avoids flagging singing; nothing advised."]
    rec.bleed_match_cents = _changed(
        "bleed_match_cents", best.match_cents, tn.bleed_match_cents
    )
    rec.bleed_min_match = _changed(
        "bleed_min_match", best.min_match, tn.bleed_min_match
    )
    rec.bleed_max_median_cents = _changed(
        "bleed_max_median_cents", best.max_median_cents, tn.bleed_max_median_cents
    )
    return []


def _latency(
    take: TakeFile, by_label: dict[str, SectionResult], rec: TuningRecommendation
) -> list[str]:
    sec = by_label.get(SPEAKERS)
    m = sec.match if sec else None
    if m is None or m.comparable < BLEED_MIN_FRAMES:
        return ["Latency: nothing advised (no usable speakers-only section)."]
    if m.share_exact < LATENCY_MIN_SHARE:
        return [
            f"Latency: nothing advised (only {m.share_exact:.0%} of the speakers "
            f"section followed the melody; {LATENCY_MIN_SHARE:.0%} needed)."
        ]
    now = take.take.latencyS
    implied = _clamp("latency_s", now + m.lag_ms / 1000.0)
    if abs(implied - now) >= LATENCY_MIN_MOVE_S:
        rec.latency_s = implied
    return []


def build_mic_check(take: TakeFile, result: TakeAnalysis) -> MicCheckAnalysis:
    """Section verdicts, the settings in force and what to change."""
    tn = tuning_of(take, clarity_threshold_of(take))
    rows, by_label = _section_rows(take, result)
    rec = TuningRecommendation()
    notes: list[str] = []
    if not rows:
        notes.append("This take has no labelled sections; nothing is advised.")
    else:
        notes += _gate(result, tn, rec)
        notes += _bleed(result, tn, rec)
        notes += _latency(take, by_label, rec)
    current = Tuning(
        draw_margin_db=tn.draw_margin_db,
        clarity_threshold=tn.clarity_threshold,
        bleed_match_cents=tn.bleed_match_cents,
        bleed_min_match=tn.bleed_min_match,
        bleed_max_median_cents=tn.bleed_max_median_cents,
        latency_s=take.take.latencyS,
    )
    return MicCheckAnalysis(
        report_text=render(result),
        findings=result.processing.findings,
        sections=rows,
        current=current,
        recommended=rec,
        notes=notes,
    )
