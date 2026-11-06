"""The environment block, the WAV check and the condensed event list.

What the browser granted the mic (echo cancellation, noise suppression, gain
control) comes from `mic.processing`, with the raw track settings kept for the
JSON. The WAV check reads 16-bit or float PCM through soundfile and compares
its length and sample rate with the JSON.
"""

from pathlib import Path

import numpy as np
import soundfile as sf

from encore_service.take_analysis.constants import SILENCE_DB
from encore_service.take_analysis.results import EnvironmentReport, EventLine, WavCheck
from encore_service.take_analysis.schema import TakeFile

# A sample at or beyond this fraction of full scale counts as clipped.
CLIP_LEVEL = 0.9999
# Length differences under this many seconds are rounding, not a mismatch.
LENGTH_TOLERANCE_S = 0.05


def _source(take: TakeFile) -> str | None:
    src = take.mic.source if take.mic else None
    if not src:
        return None
    return str(src.get("videoId") or src.get("name") or src.get("kind"))


def environment_report(take: TakeFile, clarity: float) -> EnvironmentReport:
    """Flatten the mic settings and the trace's environment."""
    mic, trace = take.mic, take.trace
    env = trace.environment if trace else None
    audio = (env.audio if env else None) or {}
    analysis = (env.analysis if env else None) or {}
    cal = trace.calibration if trace else None
    proc = mic.processing if mic else None
    return EnvironmentReport(
        app_version=env.appVersion if env else None,
        skin=env.skin if env else None,
        user_agent=env.userAgent if env else None,
        clock=take.take.clock,
        source=_source(take),
        input_label=mic.inputLabel if mic else None,
        output_label=mic.outputLabel if mic else None,
        monitor=mic.monitor if mic else None,
        mix=(
            f"{mic.mix.choice} guide {mic.mix.guideLevel:g}"
            if mic and mic.mix
            else None
        ),
        speaker_mode=mic.requestedAec if mic else None,
        aec=proc.aec if proc else None,
        ns=proc.ns if proc else None,
        agc=proc.agc if proc else None,
        granted=env.trackSettings if env else None,
        context_sample_rate=audio.get("sampleRate"),
        base_latency_s=audio.get("baseLatencyS"),
        output_latency_s=audio.get("outputLatencyS"),
        latency_s=take.take.latencyS,
        embed_offset_s=mic.embedOffsetS if mic else None,
        calibration_delay_s=cal.delayS if cal else None,
        calibration_confidence=cal.confidence if cal else None,
        calibration_spread_s=cal.spreadS if cal else None,
        clarity_threshold=clarity,
        start_floor_db=mic.noiseFloorDb if mic else None,
        mode=analysis.get("mode"),
        scoring=analysis.get("scoring"),
    )


def check_wav(path: Path, take: TakeFile) -> WavCheck:
    """Peak, clipping, DC offset, and whether it matches the JSON."""
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    duration = len(mono) / rate
    problems: list[str] = []
    if take.take.sampleRate and rate != take.take.sampleRate:
        problems.append(f"sample rate {rate} Hz, JSON says {take.take.sampleRate} Hz")
    if abs(duration - take.take.durationS) > LENGTH_TOLERANCE_S:
        problems.append(
            f"length {duration:.2f} s, JSON says {take.take.durationS:.2f} s"
        )
    return WavCheck(
        sample_rate=int(rate),
        duration_s=duration,
        channels=int(data.shape[1]),
        peak_db=20 * float(np.log10(peak)) if peak > 0 else SILENCE_DB,
        clipped_samples=int(np.sum(np.abs(data) >= CLIP_LEVEL)),
        dc_offset=float(mono.mean()) if len(mono) else 0.0,
        problems=problems,
    )


def event_lines(take: TakeFile, origin: float) -> list[EventLine]:
    """Every event, with its song time moved onto take time."""
    events = take.trace.events if take.trace else []
    return [
        EventLine(
            take_s=round(e.songT - origin, 2),
            at_s=e.at,
            song_s=e.songT,
            kind=e.kind,
            value=e.value,
        )
        for e in sorted(events, key=lambda e: e.at)
    ]
