"""The plain-text report: headline, environment, sections, events, processing.

About 60 lines for a one-minute take without the Processing part and about 80
with it; the JSON holds the rest. ASCII only, so a Windows console prints it.
"""

from encore_service.take_analysis.results import (
    EnvironmentReport,
    SectionResult,
    TakeAnalysis,
)

MAX_EVENTS = 16
MAX_AUDIT_ROWS = 8
HIDDEN_EVENT_KINDS = frozenset({"truncated"})


def _pct(x: float | None) -> str:
    return "  - " if x is None else f"{x * 100:3.0f}%"


def _num(x: float | None, fmt: str = "{:.0f}") -> str:
    return "-" if x is None else fmt.format(x)


def _ms(seconds: float | None) -> str:
    return "-" if seconds is None else f"{seconds * 1000:.0f}"


def _flag(value: bool | None) -> str:
    return "?" if value is None else ("on" if value else "off")


def _environment(e: EnvironmentReport, a: TakeAnalysis) -> list[str]:
    lines = [
        "Environment",
        f"  app {e.app_version or '?'}, skin {e.skin or '?'}, clock {e.clock}, "
        f"source {e.source or '?'}, mode {e.mode or '?'}/{e.scoring or '?'}",
        f"  input {e.input_label or '?'} | output {e.output_label or '?'} | "
        f"monitor {e.monitor or '?'} | mix {e.mix or '?'}",
        f"  browser gave: echo cancel {_flag(e.aec)}, noise suppress {_flag(e.ns)}, "
        f"auto gain {_flag(e.agc)}; speaker mode asked {_flag(e.speaker_mode)}; "
        f"clarity {e.clarity_threshold:g}; start floor {_num(e.start_floor_db)} dB",
        f"  latency {e.latency_s * 1000:.0f} ms (embed offset "
        f"{_num((e.embed_offset_s or 0) * 1000)} ms); calibration "
        f"{_ms(e.calibration_delay_s)} ms, "
        f"confidence {_num(e.calibration_confidence, '{:.2f}')}, spread "
        f"{_ms(e.calibration_spread_s)} ms; "
        f"audio {_num(e.context_sample_rate)} Hz, base "
        f"{_ms(e.base_latency_s)} ms, output "
        f"{_ms(e.output_latency_s)} ms",
    ]
    w = a.wav
    if w is not None:
        problems = (
            "; PROBLEM: " + "; ".join(w.problems)
            if w.problems
            else "; matches the JSON"
        )
        lines.append(
            f"  WAV {w.sample_rate} Hz {w.duration_s:.1f} s, peak {w.peak_db:.1f} dB, "
            f"clipped {w.clipped_samples}, DC {w.dc_offset:+.4f}{problems}"
        )
    return lines


def _row(s: SectionResult) -> str:
    m = s.match
    tag = {"marked": "M", "window": "W", "span": "S"}[s.kind]
    label = s.label[:18]
    level = (
        "    -/-   "
        if s.level_median_db is None
        else f"{s.level_median_db:4.0f}/{s.level_p90_db or 0:<4.0f}"
    )
    match = (
        "    -     -    -     -"
        if m is None
        else (
            f"{_pct(m.share_exact)} {_pct(m.share_any_octave)} "
            f"{m.median_abs_cents:4.0f} {m.lag_ms:+5d}"
        )
    )
    return (
        f"  {tag} {label:<18} {s.take_start_s:5.1f}-{s.take_end_s:<5.1f} "
        f"({s.song_start_s:5.1f}) {s.frames:5d} {_pct(s.voiced_share)} "
        f"{_pct(s.gate_pass_share)} {level} {_num(s.floor_db):>4} "
        f"{match} {_pct(s.bleed_state_share)}  {s.verdict}"
    )


def _sections(sections: list[SectionResult]) -> list[str]:
    lines = [
        "Sections: take s (song s), frames, voiced, gate pass, level med/p90 dB, "
        "floor, match 30c / any-octave 50c / median c / lag ms, app bleed",
    ]
    for s in sections:
        lines.append(_row(s))
        if s.kind == "marked":
            reasons = ""
            if s.gate_reasons is not None:
                shown = ", ".join(f"{k} {v}" for k, v in s.gate_reasons.items())
                reasons = f"gated: {shown or 'none'}; "
            lines.append(f"      {reasons}{s.reason}")
    return lines


def _events(a: TakeAnalysis) -> list[str]:
    events = [e for e in a.events if e.kind not in HIDDEN_EVENT_KINDS]
    if not events:
        return ["Events: none recorded"]
    shown = [f"{e.take_s:.1f}s {e.kind}={e.value}" for e in events[:MAX_EVENTS]]
    lines = ["Events (take time)"]
    for i in range(0, len(shown), 3):
        lines.append("  " + " | ".join(shown[i : i + 3]))
    if len(events) > MAX_EVENTS:
        lines.append(f"  ... {len(events) - MAX_EVENTS} more in the JSON")
    return lines


def _processing(a: TakeAnalysis) -> list[str]:
    p = a.processing
    lines = ["Processing (feedback for development, not for the singer)"]
    if p.audit.available:
        lines.append(
            f"  Audit over {p.audit.basis}: class, frames, passed, "
            "gated quiet/unclear, "
            "too strict, leaked, app suspected/ok, disagree"
        )
        for r in p.audit.rows[:MAX_AUDIT_ROWS]:
            lines.append(
                f"    {r.label:<12} {r.section_class:<7} {r.frames:5d} {r.passed:5d} "
                f"{r.gated_quiet:4d}/{r.gated_unclear:<4d} {r.too_strict:5d} "
                f"{r.leaked:5d} {r.app_suspected:5d}/{r.app_ok:<5d} "
                f"{r.bleed_disagree:5d}"
            )
    lines.append("Findings")
    lines += [f"  - {f}" for f in p.findings]
    return lines


def render(a: TakeAnalysis) -> str:
    """The whole text report."""
    lines = [
        f"Take {a.song_name or a.file}: version {a.version}, {a.duration_s:.1f} s, "
        f"{a.frames} frames",
        *a.headline,
    ]
    lines += [f"Cannot give: {m}." for m in a.missing]
    lines += _environment(a.environment, a)
    lines += _sections(a.sections)
    lines += _events(a)
    lines += _processing(a)
    return "\n".join(lines) + "\n"
