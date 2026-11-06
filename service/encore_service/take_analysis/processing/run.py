"""Runs the Processing part: audit, tracker check, latency, sweep, findings.

Entry point `run_processing`. The WAV and the tracker are optional; without
them the tracker check reports why it did not run.
"""

import numpy as np
from numpy.typing import NDArray

from encore_service.take_analysis.frames import FrameArrays
from encore_service.take_analysis.match import PreparedRef
from encore_service.take_analysis.processing.audit import run_audit
from encore_service.take_analysis.processing.findings import build_findings
from encore_service.take_analysis.processing.latency import run_latency
from encore_service.take_analysis.processing.models import (
    ProcessingResult,
    TrackerComparison,
)
from encore_service.take_analysis.processing.sweep import run_sweep
from encore_service.take_analysis.processing.tracker import Tracker, compare_trackers
from encore_service.take_analysis.results import SectionResult
from encore_service.take_analysis.schema import TakeFile
from encore_service.take_analysis.sections import SectionSpec


def run_processing(
    take: TakeFile,
    fa: FrameArrays,
    pairs: list[tuple[SectionSpec, SectionResult]],
    audio: tuple[NDArray[np.float32], int] | None,
    tracker: Tracker | None,
    tracker_note: str | None,
    ref: PreparedRef | None = None,
) -> ProcessingResult:
    """Everything the Processing part reports, with the findings."""
    audit = run_audit(fa, pairs, ref)
    sweep = run_sweep(fa, pairs, ref)
    latency = run_latency(take, pairs)
    if tracker is not None and audio is not None:
        samples, rate = audio
        comparison = compare_trackers(
            fa,
            samples,
            rate,
            take.take.startedAtSongS,
            take.take.latencyS,
            tracker,
            take.trace.events if take.trace else [],
        )
    else:
        why = tracker_note or "not run: pass --wav and --crepe to compare trackers"
        comparison = TrackerComparison(available=False, note=why)
    findings = build_findings(audit, sweep, latency, comparison, fa.clarity_threshold)
    return ProcessingResult(
        audit=audit,
        tracker=comparison,
        latency=latency,
        sweep=sweep,
        findings=findings,
    )
