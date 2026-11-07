"""Carrying a melody and a key across a time map: edges and key rotation."""

import numpy as np
import pytest

from encore_service.align import TimeMap
from encore_service.align_reference import map_key, map_reference
from encore_service.schemas import (
    Contour,
    KeyMap,
    KeySegment,
    MidiRange,
    Note,
    Reference,
)

HOP = 0.1


def note(onset: float, offset: float, midi: float = 60.0) -> Note:
    return Note(
        onset_s=onset,
        offset_s=offset,
        midi=midi,
        cents_mean=0.0,
        cents_std=5.0,
        scoop_cents=0.0,
    )


def reference(notes: list[Note], seconds: float = 20.0) -> Reference:
    frames = int(seconds / HOP)
    # The pitch rises one hertz per frame, so a frame's value says where it
    # was read from.
    return Reference(
        contour=Contour(
            hop_s=HOP,
            f0_hz=[200.0 + k for k in range(frames)],
            confidence=[0.9] * frames,
        ),
        notes=notes,
        range=MidiRange(low_midi=55.0, high_midi=65.0),
        unpitched_regions=[(1.0, 2.0)],
    )


def shifted(delay: float, start: float = 0.0, stop: float = 10.0) -> TimeMap:
    """Karaoke second t sits at t + delay in the original, for start..stop."""
    t = np.linspace(start, stop, 101)
    return TimeMap(from_s=t, to_s=t + delay)


def test_notes_move_to_karaoke_time_and_shift_by_the_key_offset() -> None:
    mapped = map_reference(
        reference([note(5.0, 6.0)]), shifted(2.0), 3, "orig", 0.9, 10.0
    )
    assert mapped.notes[0].onset_s == pytest.approx(3.0, abs=1e-6)
    assert mapped.notes[0].offset_s == pytest.approx(4.0, abs=1e-6)
    assert mapped.notes[0].midi == pytest.approx(63.0)
    assert mapped.range.low_midi == pytest.approx(58.0)
    assert mapped.aligned_from == "orig"
    assert mapped.key_offset == 3


def test_notes_outside_the_mapped_span_drop_out() -> None:
    notes = [note(0.5, 1.5), note(5.0, 6.0), note(11.5, 12.5), note(9.5, 11.0)]
    # The karaoke covers original seconds 2..12: the note before it and the
    # one running past its end are gone, the two whole ones stay.
    mapped = map_reference(reference(notes), shifted(2.0), 0, "orig", 0.9, 10.0)
    assert [round(n.onset_s, 3) for n in mapped.notes] == [3.0, 7.5]


def test_a_note_starting_exactly_at_the_boundary_is_kept() -> None:
    mapped = map_reference(
        reference([note(2.0, 3.0), note(11.0, 12.0)]),
        shifted(2.0),
        0,
        "orig",
        0.9,
        10.0,
    )
    # Original 2.0 and 12.0 are the first and last mapped seconds.
    assert [round(n.onset_s, 3) for n in mapped.notes] == [0.0, 9.0]
    assert mapped.notes[1].offset_s == pytest.approx(10.0)


def test_a_plateau_in_the_map_starts_a_note_at_its_first_karaoke_second() -> None:
    # The karaoke lingers on original second 5 from its 1 s to its 2 s.
    plateau = TimeMap(
        from_s=np.array([0.0, 1.0, 2.0, 3.0]), to_s=np.array([0.0, 5.0, 5.0, 6.0])
    )
    mapped = map_reference(reference([note(5.0, 5.5)]), plateau, 0, "orig", 0.9, 3.0)
    assert mapped.notes[0].onset_s == pytest.approx(1.0)
    assert mapped.notes[0].offset_s > mapped.notes[0].onset_s


def test_the_contour_is_unvoiced_outside_the_mapped_span() -> None:
    mapped = map_reference(
        reference([]), shifted(2.0, start=3.0, stop=7.0), 0, "orig", 0.9, 10.0
    )
    f0 = np.array(mapped.contour.f0_hz)
    conf = np.array(mapped.contour.confidence)
    assert len(f0) == 100
    assert np.all(f0[:29] == 0.0) and np.all(conf[:29] == 0.0)
    assert np.all(f0[72:] == 0.0)
    # Karaoke 5.0 s reads the original's 7.0 s: frame 70 of the contour.
    assert f0[50] == pytest.approx(200.0 + 70, abs=1.0)
    assert conf[50] == pytest.approx(0.9)


def test_the_contour_is_shifted_by_the_key_offset() -> None:
    mapped = map_reference(reference([]), shifted(0.0), 12, "orig", 0.9, 10.0)
    assert mapped.contour.f0_hz[10] == pytest.approx(2 * 210.0)


def test_a_reference_without_a_contour_maps_to_silence() -> None:
    empty = reference([])
    empty = empty.model_copy(
        update={"contour": Contour(hop_s=HOP, f0_hz=[], confidence=[])}
    )
    mapped = map_reference(empty, shifted(0.0), 0, "orig", 0.9, 5.0)
    assert set(mapped.contour.f0_hz) == {0.0}


def test_unpitched_regions_move_and_those_outside_drop() -> None:
    source = reference([]).model_copy(
        update={"unpitched_regions": [(0.0, 1.0), (4.0, 5.0)]}
    )
    mapped = map_reference(source, shifted(2.0), 0, "orig", 0.9, 10.0)
    assert [(round(a, 3), round(b, 3)) for a, b in mapped.unpitched_regions] == [
        (2.0, 3.0)
    ]


def keymap() -> KeyMap:
    return KeyMap(
        tuning_cents=5.0,
        segments=[
            KeySegment(start_s=0, end_s=8, tonic=9, mode="minor", confidence=0.8),
            KeySegment(start_s=8, end_s=14, tonic=None, mode=None, confidence=0.2),
            KeySegment(start_s=14, end_s=20, tonic=0, mode="major", confidence=0.7),
        ],
    )


def test_the_key_rotates_by_the_offset_and_unknown_stays_unknown() -> None:
    mapped = map_key(keymap(), shifted(0.0, 0.0, 20.0), 5, 20.0)
    assert [s.tonic for s in mapped.segments] == [2, None, 5]
    assert mapped.tuning_cents == 5.0


def test_the_key_wraps_a_negative_offset_into_a_pitch_class() -> None:
    mapped = map_key(keymap(), shifted(0.0, 0.0, 20.0), -10, 20.0)
    assert mapped.segments[0].tonic == (9 - 10) % 12
    assert mapped.segments[2].tonic == 2


def test_the_key_tiles_the_karaoke_song_without_gaps() -> None:
    # The karaoke lags the original by 2 s and is 16 s long.
    mapped = map_key(keymap(), shifted(2.0, 0.0, 18.0), 0, 16.0)
    segments = mapped.segments
    assert segments[0].start_s == 0.0
    assert segments[-1].end_s == pytest.approx(16.0)
    for before, after in zip(segments, segments[1:], strict=False):
        assert before.end_s == pytest.approx(after.start_s)


def test_segments_beyond_the_song_are_clipped_and_equal_neighbours_merge() -> None:
    same = KeyMap(
        tuning_cents=0.0,
        segments=[
            KeySegment(start_s=0, end_s=5, tonic=9, mode="minor", confidence=0.5),
            KeySegment(start_s=5, end_s=30, tonic=9, mode="minor", confidence=0.9),
        ],
    )
    mapped = map_key(same, shifted(0.0, 0.0, 20.0), 0, 12.0)
    assert len(mapped.segments) == 1
    assert mapped.segments[0].end_s == pytest.approx(12.0)
