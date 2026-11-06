"""Result models of the Processing part: audit, tracker, latency, sweep.

Kept apart from `results.py` so the processing modules can import them
without importing the section models.
"""

from pydantic import BaseModel


class AuditRow(BaseModel):
    """What the app decided in one section, against what the frames show."""

    label: str
    verdict: str
    section_class: str
    frames: int
    passed: int
    gated_quiet: int
    gated_unclear: int
    too_strict: int
    leaked: int
    app_suspected: int
    app_ok: int
    bleed_disagree: int


class AuditResult(BaseModel):
    """The decision audit: one row per section and the totals."""

    available: bool
    note: str | None
    basis: str
    rows: list[AuditRow]
    too_strict: int
    gated_in_singing: int
    leaked: int
    passed_in_silent: int
    bleed_disagree: int
    bleed_compared: int


class TrackerComparison(BaseModel):
    """The browser's tracker against the service's, on the take's time base."""

    available: bool
    note: str | None
    frames_compared: int = 0
    voicing_agreement: float | None = None
    octave_error_share: float | None = None
    median_cents_diff: float | None = None
    jitter_browser_cents: float | None = None
    jitter_tracker_cents: float | None = None
    jitter_samples: int = 0


class LatencyCheck(BaseModel):
    """The lag at which the take lines up, against the latency it was given."""

    take_latency_s: float
    embed_offset_s: float | None
    calibration_delay_s: float | None
    calibration_confidence: float | None
    calibration_spread_s: float | None
    bleed_lag_ms: float | None
    bleed_sections: int
    singer_lag_ms: float | None
    singer_sections: int
    implied_latency_s: float | None
    correction_ms: float | None
    basis: str | None
    note: str | None


class GateSetting(BaseModel):
    """One gate setting and how many frames pass it."""

    draw_margin_db: float
    clarity: float
    ceiling_db: float
    passing: int
    changed: int
    silent_pass: int
    singing_pass: int
    silent_dropped: float | None
    singing_kept: float | None
    score: float | None


class BleedSetting(BaseModel):
    """One bleed rule setting and which sections it calls bleed."""

    match_cents: float
    min_match: float
    max_median_cents: float
    bleed_sections: int
    silent_flagged: int
    singing_flagged: int
    flips: int


class SweepResult(BaseModel):
    """The what-if sweep over the gate and the bleed rule."""

    classes_from: str
    note: str | None
    current: GateSetting | None
    best_gate: GateSetting | None
    gate: list[GateSetting]
    best_bleed: BleedSetting | None
    bleed: list[BleedSetting]


class ProcessingResult(BaseModel):
    """The Processing part: audit, tracker check, latency, sweep, findings."""

    audit: AuditResult
    tracker: TrackerComparison
    latency: LatencyCheck
    sweep: SweepResult
    findings: list[str]
