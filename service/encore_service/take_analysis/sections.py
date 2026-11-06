"""Which stretches of a take get a row: marked ranges, windows, event spans.

`--section a-b` is in *take time*: seconds from the first frame (see
`frames.py`), the clock a listener counts on the saved WAV when the song ran
straight through. Every section prints its song time too. An optional suffix,
`a-b:silent` or `a-b:sing`, says what the singer meant; the Processing part
uses it to judge the gate, and unlabelled sections take their class from the
verdict. Fixed windows tile the take from 0. Spans run from one event to the
next in *song time*, for the kinds that change what reaches the mic: player
(play, pause), seek, mix, monitor and input.
"""

import re
from dataclasses import dataclass

from encore_service.take_analysis.constants import MIN_SPAN_S
from encore_service.take_analysis.results import SectionKind
from encore_service.take_analysis.schema import Event

SPAN_KINDS = frozenset({"player", "seek", "mix", "monitor", "input"})
_MARK = re.compile(
    r"^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?::\s*(silent|sing))?\s*$"
)


class SectionError(ValueError):
    """A `--section` or `--window` value that cannot be used."""


@dataclass
class SectionSpec:
    """A stretch of take time to analyse."""

    kind: SectionKind
    label: str
    take_start: float
    take_end: float
    mark: str | None = None


def parse_mark(text: str) -> SectionSpec:
    """`a-b` or `a-b:silent|sing` in seconds of take time."""
    found = _MARK.match(text)
    if not found:
        raise SectionError(f"Bad --section {text!r}: use SECONDS-SECONDS, e.g. 0-10.")
    start, end = float(found.group(1)), float(found.group(2))
    if end <= start:
        raise SectionError(f"Bad --section {text!r}: the end must be after the start.")
    label = f"{start:g}-{end:g}"
    return SectionSpec("marked", label, start, end, found.group(3))


def build_specs(
    marks: list[str],
    window_s: float,
    duration_s: float,
    events: list[Event],
    origin: float,
    latency_s: float = 0.0,
) -> list[SectionSpec]:
    """Marked sections, then event spans, then fixed windows."""
    if window_s < 0:
        raise SectionError("--window must be zero or more seconds.")
    specs = [parse_mark(m) for m in marks]
    specs += _spans(events, origin, duration_s, latency_s)
    if window_s > 0:
        start = 0.0
        while start < duration_s:
            end = min(start + window_s, duration_s)
            specs.append(SectionSpec("window", f"{start:g}-{end:g}", start, end))
            start += window_s
    return specs


def _spans(
    events: list[Event], origin: float, duration_s: float, latency_s: float
) -> list[SectionSpec]:
    """The stretches between boundary events, in song time.

    An event's `songT` is the raw transport time; a frame's `t` has the latency
    taken off, so the edges do too or every span would sit a latency late.
    """
    bounds = sorted((e for e in events if e.kind in SPAN_KINDS), key=lambda e: e.at)
    edges = [(0.0, "start")] + [
        (e.songT - latency_s - origin, f"{e.kind}={e.value}") for e in bounds
    ]
    specs: list[SectionSpec] = []
    for i, (start, what) in enumerate(edges):
        end = edges[i + 1][0] if i + 1 < len(edges) else duration_s
        start, end = max(0.0, start), min(end, duration_s)
        if i == 0 and len(edges) == 1:
            break
        if end - start >= MIN_SPAN_S:
            specs.append(SectionSpec("span", f"after {what}", start, end))
    return specs
