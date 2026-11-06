"""The take export as Pydantic models, versions 1 to 3.

Mirrors `takeExportJson` in `src/app/take-export.ts` and the trace types in
`src/app/take-trace.ts`. Every model ignores fields it does not know, and
everything an older file lacks (the trace, per-frame `rawF0` and `gate`, a
version 3 file's `kind`, `sections` and `tuning`) has a default, so one reader
serves all versions.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict


class _Lenient(BaseModel):
    model_config = ConfigDict(extra="ignore")


class TakeInfo(_Lenient):
    """The take's summary: song, length, latency and the clock behind it."""

    id: str = ""
    songName: str = ""
    songHash: str = ""
    createdAt: str = ""
    durationS: float = 0.0
    latencyS: float = 0.0
    sampleRate: int = 0
    startedAtSongS: float | None = None
    clock: str = "engine"
    kind: str = "song"


class Processing(_Lenient):
    """What the browser says it applied to the mic."""

    aec: bool | None = None
    ns: bool | None = None
    agc: bool | None = None


class Mix(_Lenient):
    """The mix in force as the take began."""

    choice: str = ""
    guideLevel: float = 0.0


class MicSettings(_Lenient):
    """The mic and mix settings captured as the take began."""

    inputLabel: str = ""
    monitor: str = ""
    processing: Processing = Processing()
    requestedAec: bool = False
    clarityThreshold: float | None = None
    latencyS: float | None = None
    embedOffsetS: float = 0.0
    outputLabel: str = ""
    mix: Mix | None = None
    source: dict[str, Any] | None = None
    noiseFloorDb: float | None = None


class Frame(_Lenient):
    """One pitch frame; `t` is song time with the latency taken off."""

    t: float
    f0: float
    clarity: float
    rms: float
    rawF0: float | None = None
    gate: str | None = None


class HealthSample(_Lenient):
    """The mic's condition at one song time."""

    t: float
    floorDb: float
    micState: str = ""
    bleed: str = "unknown"


class Event(_Lenient):
    """One entry of the timed log: `at` wall seconds, `songT` song seconds."""

    at: float
    songT: float
    kind: str
    value: str | float | bool | None = None


class TraceSection(_Lenient):
    """A stretch the Mic check labelled; times are song time like frame `t`."""

    label: str
    kind: str
    startS: float
    endS: float


class TuningIn(_Lenient):
    """The tunable values in force as the take was recorded (version 3)."""

    drawMarginDb: float | None = None
    clarityThreshold: float | None = None
    bleedMatchCents: float | None = None
    bleedMinMatch: float | None = None
    bleedMaxMedianCents: float | None = None


class Environment(_Lenient):
    """What the browser and the app were running on."""

    appVersion: str = ""
    userAgent: str = ""
    skin: str | None = None
    trackSettings: dict[str, Any] | None = None
    audio: dict[str, Any] | None = None
    analysis: dict[str, Any] | None = None
    tuning: TuningIn | None = None


class Reference(_Lenient):
    """The reference melody over the take; `f0Hz[i]` is at `t0S + i * hopS`."""

    hopS: float
    t0S: float
    f0Hz: list[float]


class Calibration(_Lenient):
    """The calibration behind the take's latency."""

    delayS: float
    confidence: float = 0.0
    spreadS: float = 0.0
    trials: list[Any] = []


class Trace(_Lenient):
    """The analysis track of a version 2 take."""

    health: list[HealthSample] = []
    events: list[Event] = []
    environment: Environment = Environment()
    reference: Reference | None = None
    key: dict[str, Any] | None = None
    calibration: Calibration | None = None
    sections: list[TraceSection] = []


class TakeFile(_Lenient):
    """A saved take: summary, mic settings, trace and frames."""

    format: str = ""
    version: int = 0
    take: TakeInfo = TakeInfo()
    mic: MicSettings | None = None
    report: dict[str, Any] | None = None
    trace: Trace | None = None
    frames: list[Frame] = []
