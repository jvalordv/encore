"""Tests for the reference melody arithmetic, on synthetic pitch tracks.

Each track is built frame by frame from a list of stretches, so the notes,
gaps, slips and slides in it are known and the answers are checked against
them. No model is involved: this is the part of the reference step that
turns a tracker's raw output into notes.
"""

import numpy as np
import pytest

from encore_service.melody import (
    HOP_S,
    NoMelodyError,
    build_reference,
    fix_octave_errors,
    gate_pitch,
    hz_to_midi,
    midi_to_hz,
    running_median,
    segment_notes,
    unpitched_regions,
)
from encore_service.schemas import Reference

HOP = HOP_S
VOICED_CONFIDENCE = 0.9
UNVOICED_CONFIDENCE = 0.05


def track(*stretches: tuple[float | None, float]) -> np.ndarray:
    """Fractional MIDI per frame; each stretch is (midi or None, seconds)."""
    parts = [
        np.full(round(seconds / HOP), np.nan if midi is None else float(midi))
        for midi, seconds in stretches
    ]
    return np.concatenate(parts)


def raw(midi: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The f0, confidence and loudness a tracker would give for `midi`."""
    voiced = ~np.isnan(midi)
    confidence = np.where(voiced, VOICED_CONFIDENCE, UNVOICED_CONFIDENCE)
    return midi_to_hz(midi), confidence, voiced.copy()


def notes_of(midi: np.ndarray):
    return [(span.start * HOP, span.end * HOP) for span in segment_notes(midi, HOP)]


# --- pitch and the gate ---------------------------------------------------


def test_hz_to_midi_maps_the_reference_pitches() -> None:
    midi = hz_to_midi(np.array([440.0, 220.0, 261.6256, 0.0, -5.0, np.nan]))
    assert midi[0] == pytest.approx(69.0)
    assert midi[1] == pytest.approx(57.0)
    assert midi[2] == pytest.approx(60.0, abs=1e-3)
    assert np.isnan(midi[3:]).all()


def test_midi_and_hz_round_trip_and_unvoiced_is_zero() -> None:
    midi = np.array([60.0, np.nan, 71.37])
    hz = midi_to_hz(midi)
    assert hz[1] == 0.0
    np.testing.assert_allclose(hz_to_midi(hz)[[0, 2]], midi[[0, 2]])


def test_the_gate_unvoices_frames_the_tracker_is_unsure_of() -> None:
    f0 = np.array([220.0, 220.0, 220.0, 0.0, np.nan])
    confidence = np.array([0.9, 0.29, 0.3, 0.9, 0.9])
    gated = gate_pitch(f0, confidence, 0.3)
    assert gated.tolist() == [220.0, 0.0, 220.0, 0.0, 0.0]


def test_the_running_median_removes_a_spike_and_keeps_unvoiced_frames() -> None:
    values = np.array([60.0, 60.0, 72.0, 60.0, 60.0, np.nan, 62.0, 62.0, 62.0])
    filtered = running_median(values, 3)
    assert filtered[2] == 60.0
    assert np.isnan(filtered[5])
    # A frame beside an unvoiced one takes the median of what is voiced.
    assert filtered[6] == 62.0
    with pytest.raises(ValueError):
        running_median(values, 4)


# --- octave slips ---------------------------------------------------------


def test_a_brief_octave_slip_inside_a_note_is_mended() -> None:
    midi = track((60, 0.4), (72, 0.05), (60, 0.4))
    fixed = fix_octave_errors(midi, HOP)
    np.testing.assert_allclose(fixed, 60.0)


def test_a_slip_an_octave_below_is_mended_too() -> None:
    midi = track((67, 0.4), (55, 0.04), (67, 0.4))
    np.testing.assert_allclose(fix_octave_errors(midi, HOP), 67.0)


def test_a_slip_at_the_end_of_a_note_is_mended_when_one_side_agrees() -> None:
    midi = track((64, 0.5), (76, 0.04), (None, 0.5))
    fixed = fix_octave_errors(midi, HOP)
    assert np.nanmax(fixed) == pytest.approx(64.0)


def test_a_real_octave_leap_is_left_alone() -> None:
    midi = track((60, 0.5), (72, 0.5))
    np.testing.assert_array_equal(fix_octave_errors(midi, HOP), midi)


def test_a_short_note_between_two_that_disagree_is_left_alone() -> None:
    midi = track((60, 0.4), (72, 0.05), (67, 0.4))
    np.testing.assert_array_equal(fix_octave_errors(midi, HOP), midi)


def test_a_long_stretch_an_octave_away_is_kept() -> None:
    midi = track((60, 0.4), (72, 0.2), (60, 0.4))
    np.testing.assert_array_equal(fix_octave_errors(midi, HOP), midi)


# --- segmenting notes -----------------------------------------------------


def test_separate_notes_come_back_with_their_times() -> None:
    midi = track((None, 0.2), (60, 0.5), (None, 0.3), (64, 0.4), (None, 0.1))
    notes = notes_of(midi)
    assert len(notes) == 2
    assert notes[0] == pytest.approx((0.2, 0.7), abs=HOP)
    assert notes[1] == pytest.approx((1.0, 1.4), abs=HOP)


def test_a_gap_under_40_ms_is_bridged_and_one_of_40_ms_or_more_is_not() -> None:
    bridged = track((60, 0.3), (None, 0.03), (60, 0.3))
    assert len(notes_of(bridged)) == 1
    apart = track((60, 0.3), (None, 0.04), (60, 0.3))
    assert len(notes_of(apart)) == 2


def test_a_voiced_run_under_80_ms_is_not_a_note() -> None:
    assert notes_of(track((None, 0.2), (60, 0.07), (None, 0.2))) == []
    assert len(notes_of(track((None, 0.2), (60, 0.08), (None, 0.2)))) == 1


def test_a_step_of_a_semitone_that_stays_splits_the_note() -> None:
    midi = track((60, 0.4), (61, 0.4))
    notes = notes_of(midi)
    assert len(notes) == 2
    assert notes[0][1] == pytest.approx(0.4, abs=2 * HOP)
    assert notes[1][0] == pytest.approx(0.4, abs=2 * HOP)


def test_a_step_that_does_not_stay_60_ms_does_not_split() -> None:
    midi = track((60, 0.4), (61, 0.05), (60, 0.4))
    assert len(notes_of(midi)) == 1


def test_a_step_under_80_cents_does_not_split() -> None:
    midi = track((60, 0.4), (60.7, 0.4))
    assert len(notes_of(midi)) == 1


def test_vibrato_of_40_cents_each_way_is_one_note() -> None:
    t = np.arange(round(1.5 / HOP)) * HOP
    midi = 62 + 0.4 * np.sin(2 * np.pi * 5.5 * t)
    notes = notes_of(midi)
    assert len(notes) == 1


def test_a_staircase_of_notes_is_found_in_order() -> None:
    steps = (60, 62, 64, 62, 60)
    midi = track(*[(m, 0.3) for m in steps])
    spans = segment_notes(midi, HOP)
    assert len(spans) == 5
    levels = [float(np.median(midi[s.start : s.end])) for s in spans]
    assert levels == list(steps)


# --- the reference as a whole ---------------------------------------------


def test_a_reference_has_notes_contour_range_and_unpitched_stretches() -> None:
    midi = track((None, 0.3), (57.2, 0.5), (None, 0.4), (64.0, 0.5), (None, 0.2))
    f0, confidence, _ = raw(midi)
    # The voice sounds through the gap between the notes, as a breath would.
    loud = np.ones(len(midi), dtype=bool)

    reference = build_reference(f0, confidence, loud)

    assert isinstance(reference, Reference)
    assert reference.contour.hop_s == HOP
    assert len(reference.contour.f0_hz) == len(midi)
    assert len(reference.contour.confidence) == len(midi)
    assert [round(n.midi, 1) for n in reference.notes] == [57.2, 64.0]
    assert reference.range.low_midi == pytest.approx(57.2)
    assert reference.range.high_midi == pytest.approx(64.0)
    # Hz of the contour is zero where it is unvoiced, and the note's pitch in
    # the middle of a note.
    assert reference.contour.f0_hz[0] == 0.0
    assert reference.contour.f0_hz[round(0.5 / HOP)] == pytest.approx(
        440 * 2 ** ((57.2 - 69) / 12), rel=1e-3
    )
    regions = reference.unpitched_regions
    assert [(round(a, 2), round(b, 2)) for a, b in regions] == [
        (0.0, 0.3),
        (0.8, 1.2),
        (1.7, 1.9),
    ]


def test_the_confidence_gate_turns_a_weak_stretch_into_no_notes() -> None:
    midi = track((60, 1.0))
    f0, _, loud = raw(midi)
    weak = np.full(len(midi), 0.2)
    with pytest.raises(NoMelodyError):
        build_reference(f0, weak, loud)


def test_octave_slips_are_mended_in_the_contour_and_the_notes() -> None:
    midi = track((60, 0.5), (72, 0.04), (60, 0.5))
    f0, confidence, loud = raw(midi)
    reference = build_reference(f0, confidence, loud)
    assert len(reference.notes) == 1
    assert reference.notes[0].midi == pytest.approx(60.0)
    assert max(reference.contour.f0_hz) == pytest.approx(261.63, abs=0.01)


def test_a_note_sung_sharp_reads_its_cents_against_the_semitone() -> None:
    midi = track((60.2, 1.0))
    reference = build_reference(*raw(midi))
    note = reference.notes[0]
    assert note.midi == pytest.approx(60.2, abs=1e-3)
    assert note.cents_mean == pytest.approx(20.0, abs=0.5)
    assert note.cents_std == pytest.approx(0.0, abs=0.5)
    assert note.scoop_cents == pytest.approx(0.0, abs=0.5)


def test_a_note_that_starts_flat_and_slides_up_has_a_negative_scoop() -> None:
    midi = track((59.5, 0.15), (60.0, 0.85))
    reference = build_reference(*raw(midi))
    assert len(reference.notes) == 1
    assert reference.notes[0].scoop_cents == pytest.approx(-50.0, abs=1.0)


def test_vibrato_shows_in_the_spread_of_a_note() -> None:
    t = np.arange(round(2.0 / HOP)) * HOP
    midi = 65 + 0.3 * np.sin(2 * np.pi * 5.5 * t)
    reference = build_reference(*raw(midi))
    assert len(reference.notes) == 1
    # A sine of amplitude 30 cents has a deviation of 30 / sqrt(2).
    assert reference.notes[0].cents_std == pytest.approx(30 / np.sqrt(2), abs=1.5)


def test_arrays_of_different_lengths_are_refused() -> None:
    with pytest.raises(ValueError):
        build_reference(np.zeros(5), np.zeros(4), np.zeros(5, dtype=bool))


# --- stretches with a voice but no pitch ----------------------------------


def test_unpitched_stretches_need_150_ms_and_join_across_short_dips() -> None:
    loud = np.zeros(300, dtype=bool)
    loud[10:24] = True  # 140 ms: too short
    loud[50:100] = True  # 500 ms
    loud[102:130] = True  # joined to the one before by a 20 ms dip
    loud[200:215] = True  # 150 ms: long enough
    regions = unpitched_regions(loud, [], HOP)
    assert regions == [(0.5, 1.3), (2.0, 2.15)]


def test_a_voiced_note_is_not_an_unpitched_stretch() -> None:
    midi = track((60, 1.0))
    reference = build_reference(*raw(midi))
    assert reference.unpitched_regions == []
