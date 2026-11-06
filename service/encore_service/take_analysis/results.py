"""What the analysis finds, as Pydantic models; `--json` dumps `TakeAnalysis`.

Shares are fractions from 0 to 1, levels dB re full scale, times seconds.
A number the file cannot give is `None` and the report says why in
`TakeAnalysis.missing`.
"""

from typing import Literal

from pydantic import BaseModel

from encore_service.take_analysis.processing.models import ProcessingResult

Verdict = Literal["silence", "singer", "likely bleed", "unclear"]
SectionKind = Literal["marked", "window", "span"]


class MatchStats(BaseModel):
    """How the mic's pitch follows the reference melody, at the best lag."""

    comparable: int
    lag_ms: int
    share_exact: float
    share_any_octave: float
    median_abs_cents: float
    median_folded_cents: float
    share_at_zero_lag: float
    lag_steady: bool | None
    window_lags_ms: list[int]


class SectionResult(BaseModel):
    """One section's numbers and verdict."""

    kind: SectionKind
    label: str
    mark: str | None = None
    take_start_s: float
    take_end_s: float
    song_start_s: float
    song_end_s: float
    frames: int
    voiced_share: float | None
    gate_pass_share: float | None
    gate_reasons: dict[str, int] | None
    level_median_db: float | None
    level_p90_db: float | None
    floor_db: float | None
    active_share: float | None
    match: MatchStats | None
    bleed_state_share: float | None
    verdict: Verdict
    reason: str


class EnvironmentReport(BaseModel):
    """What the take was recorded with, in one flat record."""

    app_version: str | None
    skin: str | None
    user_agent: str | None
    clock: str
    source: str | None
    input_label: str | None
    output_label: str | None
    monitor: str | None
    mix: str | None
    speaker_mode: bool | None
    aec: bool | None
    ns: bool | None
    agc: bool | None
    granted: dict[str, object] | None
    context_sample_rate: float | None
    base_latency_s: float | None
    output_latency_s: float | None
    latency_s: float
    embed_offset_s: float | None
    calibration_delay_s: float | None
    calibration_confidence: float | None
    calibration_spread_s: float | None
    clarity_threshold: float
    start_floor_db: float | None
    mode: str | None
    scoring: str | None


class WavCheck(BaseModel):
    """The WAV against itself and against the JSON."""

    sample_rate: int
    duration_s: float
    channels: int
    peak_db: float
    clipped_samples: int
    dc_offset: float
    problems: list[str]


class EventLine(BaseModel):
    """One event, in take time."""

    take_s: float
    at_s: float
    song_s: float
    kind: str
    value: str | float | bool | None


class TakeAnalysis(BaseModel):
    """Everything the command found about one take."""

    file: str
    version: int
    song_name: str
    duration_s: float
    frames: int
    missing: list[str]
    headline: list[str]
    environment: EnvironmentReport
    wav: WavCheck | None
    sections: list[SectionResult]
    events: list[EventLine]
    processing: ProcessingResult
