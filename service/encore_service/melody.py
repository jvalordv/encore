"""From a pitch track to the reference melody: the arithmetic, without torch.

The `reference` step (`reference.py`) has a model track the pitch of the vocal
stem and hands the raw track here: a frequency and a confidence for every
10 ms frame. This module turns it into the `Reference` that the browser
draws and scores against: a contour with the doubtful frames marked unvoiced
and the octave slips mended, the notes segmented from it, the song's range,
and the stretches that sound but have no pitch (breaths, spoken or rapped
lines). Every function is a plain function on numpy arrays, so each is tested
against synthetic signals whose answers are known. The segmentation rule is
the one in docs/COACHING.md ("Notes are segmented from a contour by ...");
the browser applies the same rule to a take.

Pitch is handled as a fractional MIDI number, `NaN` where a frame is
unvoiced, because the rules are in semitones and cents. A note's `midi` is the
median of its voiced frames. Its `cents_mean` and `cents_std` are the mean and
the spread of those frames, in cents, against the nearest whole semitone
(so a note sung 20 cents sharp reads +20), and its `scoop_cents` is how far
the first 150 ms sit from the rest, in cents: negative for a note that starts
flat and slides up. Its onset and offset are the times of its first frame and
of the frame after its last.
"""

import warnings
from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from numpy.typing import NDArray

from encore_service.schemas import Contour, MidiRange, Note, Reference

Floats = NDArray[np.float64]
Mask = NDArray[np.bool_]

# The contour's frame spacing; the model is run to give one frame per 10 ms.
HOP_S = 0.01
# A frame the model is less sure of than this counts as unvoiced. The model's
# own suggestion is 0.21; a separated vocal carries traces of the backing, so
# this asks for a little more.
CONFIDENCE_GATE = 0.3

# The segmentation rule (docs/COACHING.md).
MIN_RUN_S = 0.08
SPLIT_CENTS = 80.0
SPLIT_HOLD_S = 0.06
MERGE_GAP_S = 0.04
# Median filter over the pitch before it is split, in frames: long enough to
# ride out a one-frame blip, far shorter than a vibrato cycle.
SMOOTH_FRAMES = 5
# A note's level, for the split test, is the median of its latest frames.
LEVEL_FRAMES = 50

# Octave slips: a run of voiced frames this short that sits a whole number of
# octaves (give or take OCTAVE_TOLERANCE semitones) from the notes either side
# of it, and nowhere else, is moved by those octaves. A longer run may be a
# real leap, and one with no neighbour to agree with it is left alone.
OCTAVE_RUN_MAX_S = 0.10
OCTAVE_TOLERANCE = 1.5
OCTAVE_JOIN_GAP_S = 0.06
# Adjacent voiced frames this far apart (in semitones) start a new run.
_RUN_BREAK_SEMITONES = 8.0

SCOOP_WINDOW_S = 0.15
# Frames needed on each side of the scoop window to call the result a measure.
_SCOOP_MIN_FRAMES = 3
# A stretch that sounds but has no pitch is worth reporting from this long.
UNPITCHED_MIN_S = 0.15

_EPSILON_S = 1e-9


class NoMelodyError(ValueError):
    """The pitch track holds no note: nothing in it is steadily pitched."""


@dataclass(frozen=True)
class Span:
    """Frames `start` up to, not including, `end`."""

    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start


def hz_to_midi(f0_hz: Floats) -> Floats:
    """Fractional MIDI numbers for `f0_hz`, NaN where it is 0 or not finite."""
    f0 = np.asarray(f0_hz, dtype=np.float64)
    valid = np.isfinite(f0) & (f0 > 0)
    midi = np.full(f0.shape, np.nan)
    midi[valid] = 69.0 + 12.0 * np.log2(f0[valid] / 440.0)
    return midi


def midi_to_hz(midi: Floats) -> Floats:
    """Frequencies for fractional MIDI numbers; 0 where the pitch is NaN."""
    hz = np.zeros(midi.shape)
    voiced = ~np.isnan(midi)
    hz[voiced] = 440.0 * 2.0 ** ((midi[voiced] - 69.0) / 12.0)
    return hz


def gate_pitch(f0_hz: Floats, confidence: Floats, threshold: float) -> Floats:
    """`f0_hz` with 0 (unvoiced) wherever the confidence is under `threshold`.

    A frame with no usable frequency (zero, negative or not a number) or no
    usable confidence is unvoiced too.
    """
    f0 = np.asarray(f0_hz, dtype=np.float64)
    conf = np.asarray(confidence, dtype=np.float64)
    keep = np.isfinite(f0) & (f0 > 0) & np.isfinite(conf) & (conf >= threshold)
    return np.where(keep, f0, 0.0)


def running_median(values: Floats, size: int) -> Floats:
    """The median of each frame and its neighbours, ignoring NaN.

    `size` is the odd window length in frames. A frame that is NaN stays NaN,
    so unvoiced frames neither get a pitch nor lend one to their neighbours.
    """
    if size < 1 or size % 2 == 0:
        raise ValueError(f"The window must be odd and positive, got {size}")
    if size == 1 or values.size == 0:
        return values.copy()
    padded = np.pad(values, size // 2, constant_values=np.nan)
    with warnings.catch_warnings():
        # A window with no voiced frame is all NaN, which is the answer.
        warnings.simplefilter("ignore", RuntimeWarning)
        filtered = np.nanmedian(sliding_window_view(padded, size), axis=1)
    filtered[np.isnan(values)] = np.nan
    return filtered


def _runs(mask: Mask) -> list[Span]:
    """The stretches of consecutive True in `mask`, in order."""
    edges = np.diff(np.concatenate(([0], mask.astype(np.int8), [0])))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    return [Span(int(a), int(b)) for a, b in zip(starts, ends, strict=True)]


def _continuous_runs(midi: Floats) -> list[Span]:
    """Voiced stretches, cut where the pitch jumps by a large interval."""
    spans: list[Span] = []
    for voiced in _runs(~np.isnan(midi)):
        jumps = np.flatnonzero(
            np.abs(np.diff(midi[voiced.start : voiced.end])) >= _RUN_BREAK_SEMITONES
        )
        cuts = [voiced.start, *(voiced.start + jumps + 1), voiced.end]
        spans.extend(Span(int(a), int(b)) for a, b in zip(cuts, cuts[1:], strict=False))
    return spans


def fix_octave_errors(midi: Floats, hop_s: float = HOP_S) -> Floats:
    """`midi` with brief octave slips of the tracker moved back.

    A tracker sometimes locks onto a harmonic or a sub-harmonic for a few
    frames, so a sung note shows a blip an octave away. A median filter would
    also drag the start of a real octave leap back, so the test is on runs: a
    run of at most OCTAVE_RUN_MAX_S, close enough in time to the run before it
    or after it (OCTAVE_JOIN_GAP_S) and longer than itself on each side, is
    moved by whole octaves when every such neighbour lies that many octaves,
    within OCTAVE_TOLERANCE semitones, from it.
    """
    fixed = np.array(midi, dtype=np.float64)
    spans = _continuous_runs(midi)
    medians = [float(np.median(midi[s.start : s.end])) for s in spans]
    max_frames = OCTAVE_RUN_MAX_S / hop_s + _EPSILON_S
    max_gap = OCTAVE_JOIN_GAP_S / hop_s + _EPSILON_S
    for i, span in enumerate(spans):
        if span.length > max_frames:
            continue
        octaves: set[int] = set()
        disagree = False
        # Each neighbour and how many frames lie between it and this run.
        neighbours = [(j, span.start - spans[j].end) for j in (i - 1,) if j >= 0]
        neighbours += [
            (j, spans[j].start - span.end) for j in (i + 1,) if j < len(spans)
        ]
        for j, gap in neighbours:
            if gap > max_gap or spans[j].length <= span.length:
                continue
            distance = medians[j] - medians[i]
            whole = round(distance / 12.0)
            if whole == 0 or abs(distance - 12.0 * whole) > OCTAVE_TOLERANCE:
                disagree = True
            else:
                octaves.add(whole)
        if len(octaves) == 1 and not disagree:
            fixed[span.start : span.end] += 12.0 * octaves.pop()
    return fixed


def _bridge_gaps(midi: Floats, hop_s: float) -> tuple[Mask, Floats]:
    """Treat short unvoiced gaps as part of the note around them.

    Returns a mask of the frames that count as voiced once every gap shorter
    than MERGE_GAP_S, with a voiced frame on each side, is filled, and the
    pitch with those gaps interpolated so it can be filtered across them.
    """
    voiced = ~np.isnan(midi)
    bridged = voiced.copy()
    for gap in _runs(~voiced):
        if gap.start == 0 or gap.end == len(midi):
            continue
        if gap.length * hop_s < MERGE_GAP_S - _EPSILON_S:
            bridged[gap.start : gap.end] = True
    filled = np.full(midi.shape, np.nan)
    if voiced.any():
        index = np.arange(len(midi))
        filled[bridged] = np.interp(index[bridged], index[voiced], midi[voiced])
    return bridged, filled


def _split_run(pitch: Floats, hold: int) -> list[Span]:
    """Cut one smoothed run of pitch where it moves to a new level and stays.

    The level is the median of the note's latest LEVEL_FRAMES. A new note
    starts at the first frame of `hold` frames that all sit SPLIT_CENTS or
    more to one side of it.
    """
    spans: list[Span] = []
    start = 0
    frame = 0
    cents = SPLIT_CENTS / 100.0
    while frame < len(pitch):
        if frame + hold <= len(pitch) and frame > start:
            level = float(np.median(pitch[max(start, frame - LEVEL_FRAMES) : frame]))
            ahead = pitch[frame : frame + hold] - level
            if np.all(ahead >= cents) or np.all(ahead <= -cents):
                spans.append(Span(start, frame))
                start = frame
        frame += 1
    spans.append(Span(start, len(pitch)))
    return spans


def segment_notes(midi: Floats, hop_s: float = HOP_S) -> list[Span]:
    """Segment `midi` (NaN where unvoiced) into notes by the COACHING rule.

    A voiced run (gaps under MERGE_GAP_S bridged) of at least MIN_RUN_S is a
    candidate; it is cut where the median-filtered pitch has moved SPLIT_CENTS
    from the note's level and holds there for SPLIT_HOLD_S. A piece shorter
    than SPLIT_HOLD_S is a slip at a note's edge and is dropped.
    """
    bridged, filled = _bridge_gaps(midi, hop_s)
    smooth = running_median(filled, SMOOTH_FRAMES)
    hold = max(round(SPLIT_HOLD_S / hop_s), 1)
    notes: list[Span] = []
    for run in _runs(bridged):
        if run.length * hop_s < MIN_RUN_S - _EPSILON_S:
            continue
        for piece in _split_run(smooth[run.start : run.end], hold):
            if piece.length >= hold:
                notes.append(Span(run.start + piece.start, run.start + piece.end))
    return notes


def describe_note(midi: Floats, span: Span, hop_s: float = HOP_S) -> Note | None:
    """The `Note` for the frames of `span`, or None if none of them is voiced."""
    frames = midi[span.start : span.end]
    voiced = ~np.isnan(frames)
    if not voiced.any():
        return None
    level = float(np.median(frames[voiced]))
    cents = (frames - round(level)) * 100.0
    early = int(round(SCOOP_WINDOW_S / hop_s))
    head, rest = cents[:early], cents[early:]
    head, rest = head[~np.isnan(head)], rest[~np.isnan(rest)]
    scoop = 0.0
    if len(head) >= _SCOOP_MIN_FRAMES and len(rest) >= _SCOOP_MIN_FRAMES:
        scoop = float(np.median(head) - np.median(rest))
    return Note(
        onset_s=round(span.start * hop_s, 4),
        offset_s=round(span.end * hop_s, 4),
        midi=round(level, 3),
        cents_mean=round(float(np.mean(cents[voiced])), 2),
        cents_std=round(float(np.std(cents[voiced])), 2),
        scoop_cents=round(scoop, 2),
    )


def unpitched_regions(
    loud: Mask, notes: list[Note], hop_s: float = HOP_S
) -> list[tuple[float, float]]:
    """Stretches that sound (`loud`) but fall outside every note.

    Breaths, consonants, and spoken or rapped lines show up here: there is a
    voice but no pitch to follow. Pieces split by less than MERGE_GAP_S are
    one stretch, and a stretch under UNPITCHED_MIN_S is not reported.
    """
    free = loud.copy()
    for note in notes:
        free[round(note.onset_s / hop_s) : round(note.offset_s / hop_s)] = False
    # Close the short gaps by hand: a stretch with a one-frame dip in it is
    # still one stretch.
    stretches: list[list[int]] = []
    for run in _runs(free):
        if stretches and (run.start - stretches[-1][1]) * hop_s < MERGE_GAP_S - (
            _EPSILON_S
        ):
            stretches[-1][1] = run.end
        else:
            stretches.append([run.start, run.end])
    return [
        (round(a * hop_s, 4), round(b * hop_s, 4))
        for a, b in stretches
        if (b - a) * hop_s >= UNPITCHED_MIN_S - _EPSILON_S
    ]


def build_reference(
    f0_hz: Floats,
    confidence: Floats,
    loud: Mask,
    hop_s: float = HOP_S,
    gate: float = CONFIDENCE_GATE,
) -> Reference:
    """The reference melody from a raw pitch track.

    `f0_hz` and `confidence` hold one value per frame, `hop_s` apart from
    time 0; `loud` says which frames the vocal is audible in, for the
    unpitched regions. Raises NoMelodyError when no frame makes a note.
    """
    if not (len(f0_hz) == len(confidence) == len(loud)):
        raise ValueError("f0_hz, confidence and loud must have the same length")
    # The model answers in steps of 20 cents, so a steady note flickers by a
    # step or two from frame to frame; the median filter evens that out.
    pitch = running_median(
        hz_to_midi(gate_pitch(f0_hz, confidence, gate)), SMOOTH_FRAMES
    )
    midi = fix_octave_errors(pitch, hop_s)
    notes = [
        note
        for span in segment_notes(midi, hop_s)
        if (note := describe_note(midi, span, hop_s)) is not None
    ]
    if not notes:
        raise NoMelodyError("no stretch of the track holds a steady pitch")
    contour = Contour(
        hop_s=hop_s,
        t0_s=0.0,
        f0_hz=[round(float(hz), 2) for hz in midi_to_hz(midi)],
        confidence=[
            round(float(c), 3) for c in np.clip(np.nan_to_num(confidence), 0.0, 1.0)
        ],
    )
    return Reference(
        contour=contour,
        notes=notes,
        range=MidiRange(
            low_midi=min(note.midi for note in notes),
            high_midi=max(note.midi for note in notes),
        ),
        unpitched_regions=unpitched_regions(loud, notes, hop_s),
    )
