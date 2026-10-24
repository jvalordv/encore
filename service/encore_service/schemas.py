"""Pydantic models for the data the service exchanges with the browser.

These mirror the "Shared schemas" block in docs/ARCHITECTURE.md field for
field; `src/service/types.ts` mirrors them by hand, so change both together.
Feature names follow the "What we measure" table in docs/COACHING.md. The
helper models (MidiRange, SongSteps, Alignment, Evidence, and the feature
groups) exist only to give the nested objects in that block a name.
"""

from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator

# Lifecycle of one song preparation step.
StepState = Literal["queued", "running", "done", "failed", "skipped"]
# The preparation steps, in the order they run.
StepName = Literal["fetch", "separation", "reference", "lyrics"]
# How a song entered the service; only linked songs have a fetch step to run.
SongSource = Literal["file", "youtube"]
# General judges a take alone; match judges it against the original vocal.
RecommendationMode = Literal["general", "match"]
# How loudly the report card presents a recommendation.
Severity = Literal["info", "work_on", "priority"]


class Contour(BaseModel):
    """Frame-by-frame f0 track; hop_s apart, starting at t0_s."""

    hop_s: float = Field(default=0.01, gt=0)
    t0_s: float = 0.0
    f0_hz: list[float]  # 0 means unvoiced
    confidence: list[float]

    @model_validator(mode="after")
    def _same_length(self) -> Self:
        if len(self.confidence) != len(self.f0_hz):
            raise ValueError("confidence and f0_hz must have the same length")
        return self


class Vibrato(BaseModel):
    """Vibrato measured on one sustained note."""

    rate_hz: float
    extent_cents: float  # peak to peak
    regularity: float  # std of cycle period, seconds; lower is steadier


class Note(BaseModel):
    """One segmented note with its intonation and optional vibrato."""

    onset_s: float
    offset_s: float
    midi: float  # fractional
    cents_mean: float
    cents_std: float
    scoop_cents: float
    vibrato: Vibrato | None = None


class MidiRange(BaseModel):
    """A low and high pitch as fractional MIDI note numbers."""

    low_midi: float
    high_midi: float


class Reference(BaseModel):
    """The original vocal: contour, notes, range, and non-pitched regions."""

    contour: Contour
    notes: list[Note]
    range: MidiRange
    unpitched_regions: list[tuple[float, float]] = Field(default_factory=list)


class LyricWord(BaseModel):
    """One word with its timing and the lyric line it belongs to."""

    start_s: float
    end_s: float
    text: str
    line: int


class Lyrics(BaseModel):
    """Word-level lyrics for a song."""

    words: list[LyricWord]
    language: str


class StepStatus(BaseModel):
    """State and progress of one song preparation step."""

    state: StepState = "queued"
    progress: float = Field(default=0.0, ge=0, le=1)
    error: str | None = None  # why a step failed
    detail: str | None = None  # why a step was skipped, shown to the user


class SongSteps(BaseModel):
    """The four preparation steps in run order; fetch is skipped for uploads."""

    fetch: StepStatus = Field(default_factory=StepStatus)
    separation: StepStatus = Field(default_factory=StepStatus)
    reference: StepStatus = Field(default_factory=StepStatus)
    lyrics: StepStatus = Field(default_factory=StepStatus)


class SongStatus(BaseModel):
    """Preparation status of one song, polled by the browser."""

    song_id: str
    title: str | None = None
    duration_s: float | None = None
    source: SongSource = "file"
    steps: SongSteps = Field(default_factory=SongSteps)


class IntonationFeatures(BaseModel):
    """How close the take is to the notes it aims at."""

    bias_cents: float | None = None  # mean signed error; negative is flat
    stability_cents: float | None = None  # std within notes over 400 ms
    scoop_cents: float | None = None  # first 150 ms vs steady state, median
    drift_cents_per_s: float | None = None  # slope on notes over 1 s
    in_tune_rate: float | None = None  # share of notes within 50 cents


class TimingFeatures(BaseModel):
    """How the take sits against the reference in time."""

    onset_delta_s: list[float] | None = None  # per note, positive is late
    onset_bias_s: float | None = None  # median of onset_delta_s


class VibratoFeatures(BaseModel):
    """Vibrato summarised over notes longer than 500 ms."""

    rate_hz: float | None = None
    extent_cents: float | None = None
    regularity: float | None = None


class DynamicsFeatures(BaseModel):
    """Loudness shape of the take."""

    envelope: list[float] | None = None  # RMS at 50 ms hop, / take p95
    phrase_end_fade_db: list[float] | None = None  # per phrase, last 300 ms
    dynamic_range_db: float | None = None  # p95 minus p05


class RangeFeatures(BaseModel):
    """Where the voice sits compared with where the song sits."""

    tessitura: MidiRange | None = None  # p10 to p90 over the singer's takes
    song_range: MidiRange | None = None


class VowelFormants(BaseModel):
    """First two formants measured on one sustained vowel."""

    note_index: int
    f1_hz: float
    f2_hz: float


class TimbreFeatures(BaseModel):
    """Tone colour proxies; not a judgement of tone quality."""

    brightness_hz: float | None = None  # spectral centroid, voiced frames
    breathiness_hnr_db: float | None = None  # harmonics-to-noise ratio
    vowel_shape: list[VowelFormants] | None = None


class BreathFeatures(BaseModel):
    """Where the singer pauses."""

    gaps_s: list[tuple[float, float]] | None = None  # gaps over 250 ms


class Features(BaseModel):
    """Every measured feature of a take, grouped as in docs/COACHING.md."""

    intonation: IntonationFeatures | None = None
    timing: TimingFeatures | None = None
    vibrato: VibratoFeatures | None = None
    dynamics: DynamicsFeatures | None = None
    range: RangeFeatures | None = None
    timbre: TimbreFeatures | None = None
    breath: BreathFeatures | None = None


class Evidence(BaseModel):
    """What a recommendation rests on, so the UI can jump to the moment."""

    note_indices: list[int] = Field(default_factory=list)
    value: float
    reference_value: float | None = None


class Recommendation(BaseModel):
    """One coaching item produced by a rule from measured features."""

    rule_id: str
    mode: RecommendationMode
    severity: Severity
    message_key: str
    evidence: Evidence


class Alignment(BaseModel):
    """How the take was lined up with the reference."""

    offset_s: float
    dtw_path: list[tuple[int, int]] | None = None  # (take frame, ref frame)


class TakeAnalysis(BaseModel):
    """Post-take analysis returned by POST /analyze."""

    contour: Contour
    notes: list[Note]
    alignment: Alignment
    features: Features
    recommendations: list[Recommendation] = Field(default_factory=list)


class DuetSinger(BaseModel):
    """One singer's contour pulled out of a shared take."""

    id: str
    contour: Contour
    confidence: list[float]  # per-frame confidence of the assignment


class HarmonyMoment(BaseModel):
    """A stretch where both singers hold a stable harmonic interval."""

    start_s: float
    end_s: float
    interval_semitones: float


class DuetSplit(BaseModel):
    """Result of splitting a one-mic duet take into two singers."""

    singers: list[DuetSinger]
    harmony: list[HarmonyMoment] = Field(default_factory=list)
