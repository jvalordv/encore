"""Carrying an original's melody and key over to a karaoke song's timeline.

`align.py` says where each karaoke second falls in the original and how many
semitones apart the two are. These functions apply that: the contour is
resampled onto the karaoke clock, notes and regions move to their karaoke
times, pitches shift by the key offset, and the key map's tonics rotate. A
part of the original the karaoke does not cover (the map stops there) becomes
unvoiced, or drops out, rather than being stretched over the gap.
"""

import numpy as np

from encore_service.align import TimeMap
from encore_service.schemas import (
    Contour,
    KeyMap,
    KeySegment,
    MidiRange,
    Note,
    Reference,
)

_SEMITONES_PER_OCTAVE = 12


def _inverse(time_map: TimeMap) -> TimeMap:
    """The same map read backwards: original seconds to karaoke seconds."""
    # Plateaus in the forward map (the karaoke lingers on one original
    # moment) collapse to their first karaoke time here.
    to_s, first = np.unique(time_map.to_s, return_index=True)
    return TimeMap(from_s=to_s, to_s=time_map.from_s[first])


def _to_karaoke(inverse: TimeMap, original_s: float) -> float | None:
    """Karaoke second of an original second, None outside the mapped span."""
    if not inverse.from_s[0] <= original_s <= inverse.from_s[-1]:
        return None
    return float(np.interp(original_s, inverse.from_s, inverse.to_s))


def map_reference(
    reference: Reference,
    time_map: TimeMap,
    key_offset: int,
    aligned_from: str,
    confidence: float,
    duration_s: float,
) -> Reference:
    """The original's reference as the karaoke song would have sung it."""
    source = reference.contour
    hop = source.hop_s
    times = np.arange(int(duration_s / hop)) * hop
    inside = (times >= time_map.from_s[0]) & (times <= time_map.from_s[-1])
    original_s = np.interp(times, time_map.from_s, time_map.to_s)
    index = np.rint((original_s - source.t0_s) / hop).astype(int)
    index = np.clip(index, 0, max(len(source.f0_hz) - 1, 0))
    if source.f0_hz:
        f0 = np.asarray(source.f0_hz)[index]
        conf = np.asarray(source.confidence)[index]
    else:
        f0 = np.zeros(len(times))
        conf = np.zeros(len(times))
    f0 = np.where(inside, f0, 0.0) * 2 ** (key_offset / _SEMITONES_PER_OCTAVE)
    conf = np.where(inside, conf, 0.0)

    inverse = _inverse(time_map)
    notes: list[Note] = []
    for note in reference.notes:
        onset = _to_karaoke(inverse, note.onset_s)
        offset = _to_karaoke(inverse, note.offset_s)
        if onset is None or offset is None or offset <= onset:
            continue
        notes.append(
            note.model_copy(
                update={
                    "onset_s": onset,
                    "offset_s": offset,
                    "midi": note.midi + key_offset,
                }
            )
        )
    regions: list[tuple[float, float]] = []
    for start, end in reference.unpitched_regions:
        a, b = _to_karaoke(inverse, start), _to_karaoke(inverse, end)
        if a is not None and b is not None and b > a:
            regions.append((a, b))
    return Reference(
        contour=Contour(
            hop_s=hop,
            t0_s=0.0,
            f0_hz=[float(v) for v in f0],
            confidence=[float(v) for v in conf],
        ),
        notes=notes,
        range=MidiRange(
            low_midi=reference.range.low_midi + key_offset,
            high_midi=reference.range.high_midi + key_offset,
        ),
        unpitched_regions=regions,
        aligned_from=aligned_from,
        key_offset=key_offset,
        confidence=confidence,
    )


def map_key(
    key: KeyMap, time_map: TimeMap, key_offset: int, duration_s: float
) -> KeyMap:
    """The original's key map moved to karaoke time, rotated by the offset."""
    inverse = _inverse(time_map)
    segments: list[KeySegment] = []
    for seg in key.segments:
        start = float(np.interp(seg.start_s, inverse.from_s, inverse.to_s))
        end = float(np.interp(seg.end_s, inverse.from_s, inverse.to_s))
        tonic = None if seg.tonic is None else (seg.tonic + key_offset) % 12
        segments.append(
            seg.model_copy(update={"start_s": start, "end_s": end, "tonic": tonic})
        )
    # Close the gaps and clip to the song so the segments tile 0..duration.
    tiled: list[KeySegment] = []
    cursor = 0.0
    for seg in segments:
        end = min(seg.end_s, duration_s)
        if end <= cursor:
            continue
        piece = seg.model_copy(update={"start_s": cursor, "end_s": end})
        if tiled and (tiled[-1].tonic, tiled[-1].mode) == (piece.tonic, piece.mode):
            tiled[-1] = tiled[-1].model_copy(update={"end_s": end})
        else:
            tiled.append(piece)
        cursor = end
    if tiled:
        tiled[-1] = tiled[-1].model_copy(update={"end_s": duration_s})
    return KeyMap(tuning_cents=key.tuning_cents, segments=tiled)
