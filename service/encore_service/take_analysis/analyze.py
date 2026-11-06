"""Builds the whole `TakeAnalysis` for one take.

Order: read the frames onto one time base, cut the sections, measure each,
check the WAV, then the Processing part. The headline sums up the sections the
singer marked (what the speakers or the room put on the mic) and tallies the
fixed windows. `missing` lists, in plain words, what this file cannot give.
"""

from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf
from numpy.typing import NDArray

from encore_service.take_analysis.constants import BLEED_MATCH_CENTS
from encore_service.take_analysis.environment import (
    check_wav,
    environment_report,
    event_lines,
)
from encore_service.take_analysis.frames import FrameArrays, build_frames
from encore_service.take_analysis.match import PreparedRef
from encore_service.take_analysis.measure import analyse_section
from encore_service.take_analysis.processing.run import run_processing
from encore_service.take_analysis.processing.tracker import Tracker
from encore_service.take_analysis.results import SectionResult, TakeAnalysis
from encore_service.take_analysis.schema import TakeFile
from encore_service.take_analysis.sections import (
    SectionSpec,
    build_specs,
    trace_marks,
)


def missing_notes(take: TakeFile, fa: FrameArrays) -> list[str]:
    """What this file cannot give, in plain words."""
    out: list[str] = []
    if take.trace is None:
        out.append(
            f"version {take.version} file has no trace: no health samples (the floor "
            "is the mic's starting one), events, environment, reference melody or "
            "calibration, so no match, lag, bleed-state or event-span numbers"
        )
    elif take.trace.reference is None:
        out.append(
            "no reference melody in the trace: no match or lag; the verdict uses "
            "level and voicing only and cannot tell bleed from singing"
        )
    if not fa.has_gate:
        out.append(
            "no per-frame gate or raw pitch (version 1): no gate pass share, "
            "reasons or decision audit, and frames the app gated read as unvoiced"
        )
    if take.mic is None:
        out.append("no mic settings in the file")
    return out


def _phrase(sec: SectionResult) -> str:
    m = sec.match
    if sec.verdict == "likely bleed" and m is not None:
        return (
            f"{m.share_exact:.0%} of frames followed the melody within "
            f"{BLEED_MATCH_CENTS} c at {m.lag_ms:+d} ms: the speakers reached the mic"
        )
    if sec.verdict == "silence":
        return "silence, nothing over the floor"
    return sec.verdict if sec.verdict != "unclear" else f"unclear ({sec.reason})"


def headline(sections: list[SectionResult]) -> list[str]:
    """One or two lines: the marked sections, then the windows' tally."""
    out: list[str] = []
    marked = [s for s in sections if s.kind == "marked"]
    if marked:
        parts = [
            f"{s.label}{' ' + s.mark if s.mark else ''}: {_phrase(s)}" for s in marked
        ]
        out.append("Sections you marked: " + "; ".join(parts) + ".")
    windows = [s for s in sections if s.kind == "window"]
    if windows:
        tally = Counter(s.verdict for s in windows)
        words = ", ".join(f"{n} {v}" for v, n in tally.most_common())
        out.append(f"Whole take, {len(windows)} windows: {words}.")
    return out or ["No sections to summarise."]


def read_audio(path: Path) -> tuple[NDArray[np.float32], int]:
    """The WAV as mono float32 samples and its rate."""
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    return np.ascontiguousarray(data.mean(axis=1), dtype=np.float32), int(rate)


def analyse_take(
    take: TakeFile,
    name: str,
    wav: Path | None = None,
    marks: list[str] | None = None,
    window_s: float = 5.0,
    tracker: Tracker | None = None,
    tracker_note: str | None = None,
) -> TakeAnalysis:
    """Analyse a parsed take; raises `SectionError` for a bad mark or window.

    With no `marks`, the sections the app labelled in the trace (a Mic check)
    are used, already marked silent or sing.
    """
    fa = build_frames(take)
    trace = take.trace
    if not marks and trace and trace.sections:
        marks = [m for m, _ in trace_marks(trace.sections, fa.origin)]
    ref = PreparedRef.of(trace.reference) if trace and trace.reference else None
    health = trace.health if trace else []
    duration = float(fa.take_t.max()) + 0.01
    specs = build_specs(
        marks or [],
        window_s,
        duration,
        trace.events if trace else [],
        fa.origin,
        take.take.latencyS,
    )
    sections = [analyse_section(s, fa, ref, health) for s in specs]
    pairs: list[tuple[SectionSpec, SectionResult]] = list(
        zip(specs, sections, strict=True)
    )
    audio = read_audio(wav) if wav is not None else None
    result = run_processing(take, fa, pairs, audio, tracker, tracker_note, ref)
    return TakeAnalysis(
        file=name,
        version=take.version,
        song_name=take.take.songName,
        duration_s=take.take.durationS,
        frames=len(take.frames),
        missing=missing_notes(take, fa),
        headline=headline(sections),
        environment=environment_report(take, fa.clarity_threshold),
        wav=check_wav(wav, take) if wav is not None else None,
        sections=sections,
        events=event_lines(take, fa.origin),
        processing=result,
    )
