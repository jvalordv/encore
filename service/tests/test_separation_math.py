"""Tests for the arithmetic of the separation step: no model, no files.

Normalising and restoring, channel handling, summing and scaling the stems,
checking that a model has a voice, and the mapping from demucs's progress
events to the status file's progress. All of it is plain numpy, so these run,
and pass, without torch.
"""

from collections.abc import Iterator
from typing import Any

import numpy as np
import pytest

from encore_service.separation import (
    CLIP_CEILING,
    PROGRESS_CAP,
    as_stereo,
    bag_progress,
    check_sources,
    combine_stems,
    limit_stems,
    normalise,
    restore,
    restore_sources,
)
from tests.fakes import STEM_RATE, backing_of, known_sources, stereo_tone

# --- normalising --------------------------------------------------------------


def test_normalise_has_a_known_answer() -> None:
    # The mono mix is [1, 3]: mean 2, and a deviation of sqrt(2) with the n-1
    # that torch's std() uses and so the demucs command does.
    wav = np.array([[1.0, 3.0], [1.0, 3.0]], dtype=np.float32)

    normalised, mean, std = normalise(wav)

    assert mean == 2.0
    assert std == pytest.approx(np.sqrt(2.0), abs=1e-6)
    expected = np.array([[-1, 1], [-1, 1]]) / np.sqrt(2.0)
    np.testing.assert_allclose(normalised, expected, atol=1e-6)


def test_normalise_brings_any_song_to_zero_mean_and_unit_deviation() -> None:
    rng = np.random.default_rng(1)
    wav = (0.3 * rng.standard_normal((2, 20_000)) + 0.05).astype(np.float32)

    normalised, _, _ = normalise(wav)

    reference = normalised.mean(axis=0)
    assert float(reference.mean()) == pytest.approx(0.0, abs=1e-5)
    assert float(reference.std(ddof=1)) == pytest.approx(1.0, abs=1e-4)
    assert normalised.dtype == np.float32


def test_restore_undoes_normalise() -> None:
    rng = np.random.default_rng(2)
    wav = (0.2 * rng.standard_normal((2, 5_000)) - 0.01).astype(np.float32)

    normalised, mean, std = normalise(wav)
    back = restore(normalised, mean, std)

    np.testing.assert_allclose(back, wav, atol=1e-6)
    assert back.dtype == np.float32
    # A new array: the model's output is not edited in place.
    assert back is not normalised


def test_normalise_leaves_the_input_alone() -> None:
    wav = stereo_tone()
    before = wav.copy()
    normalise(wav)
    np.testing.assert_array_equal(wav, before)


@pytest.mark.parametrize("samples", [1, 2, 100])
def test_normalise_of_silence_or_almost_nothing_stays_finite(samples: int) -> None:
    wav = np.zeros((2, samples), dtype=np.float32)

    normalised, mean, std = normalise(wav)

    assert np.isfinite(normalised).all()
    assert mean == 0.0
    # Floored, so the quiet song is divided by something and restoring works.
    assert std > 0
    np.testing.assert_array_equal(restore(normalised, mean, std), wav)


# --- restoring the sources of a model -----------------------------------------

FOUR = ["drums", "bass", "other", "vocals"]
SIX = ["drums", "bass", "other", "vocals", "guitar", "piano"]


def split_into(wav_normalised: np.ndarray, count: int, seed: int) -> list[np.ndarray]:
    """`count` random arrays summing to `wav_normalised`, as sources should."""
    rng = np.random.default_rng(seed)
    parts = [
        rng.standard_normal(wav_normalised.shape).astype(np.float32)
        for _ in range(count - 1)
    ]
    parts.append(wav_normalised - sum(parts, start=np.zeros_like(wav_normalised)))
    return parts


@pytest.mark.parametrize("names", [["vocals", "other"], FOUR, SIX])
@pytest.mark.parametrize("offset", [0.0, 0.03, -0.12])
def test_the_voice_and_the_backing_add_up_to_a_song_that_has_a_mean(
    names: list[str], offset: float
) -> None:
    # A song with a level of its own (a DC offset), as recordings often have.
    rng = np.random.default_rng(4)
    wav = (0.2 * rng.standard_normal((2, 6_000)) + offset).astype(np.float32)
    normalised, mean, std = normalise(wav)
    estimates = split_into(normalised, len(names), seed=len(names))

    sources = restore_sources(estimates, names, mean, std)

    assert list(sources) == names
    vocals, no_vocals = combine_stems(sources)
    # The mean goes back once in all, not once per source.
    np.testing.assert_allclose(vocals + no_vocals, wav, atol=1e-5)
    np.testing.assert_allclose(sum(sources.values()), wav, atol=1e-5)


@pytest.mark.parametrize("names", [["vocals", "other"], FOUR, SIX])
def test_the_songs_mean_is_shared_evenly_between_the_sources(
    names: list[str],
) -> None:
    rng = np.random.default_rng(6)
    # Sources with no level of their own, so what each ends with is the share
    # of the song's mean that it was given.
    estimates = [rng.standard_normal((2, 5_000)).astype(np.float32) for _ in names]
    estimates = [part - part.mean(axis=1, keepdims=True) for part in estimates]

    sources = restore_sources(estimates, names, mean=0.06, std=0.2)

    for stem in sources.values():
        np.testing.assert_allclose(stem.mean(axis=1), 0.06 / len(names), atol=1e-6)


def test_restoring_the_sources_leaves_what_the_model_made_alone() -> None:
    wav = stereo_tone(0.05)
    normalised, mean, std = normalise(wav)
    estimates = split_into(normalised, 4, seed=3)
    before = [part.copy() for part in estimates]

    sources = restore_sources(estimates, FOUR, mean, std)

    for part, kept in zip(estimates, before, strict=True):
        np.testing.assert_array_equal(part, kept)
    assert all(stem.dtype == np.float32 for stem in sources.values())


def test_sources_and_names_must_match_in_number() -> None:
    estimates = split_into(np.zeros((2, 10), dtype=np.float32), 3, seed=0)
    with pytest.raises(ValueError):
        restore_sources(estimates, FOUR, 0.0, 1.0)


# --- channels -----------------------------------------------------------------


def test_mono_is_put_on_both_sides_unchanged() -> None:
    mono = np.array([[0.1, -0.2, 0.3]], dtype=np.float32)

    stereo = as_stereo(mono)

    assert stereo.shape == (2, 3)
    np.testing.assert_array_equal(stereo[0], mono[0])
    np.testing.assert_array_equal(stereo[1], mono[0])
    assert stereo.dtype == np.float32


def test_stereo_is_left_as_it_is() -> None:
    wav = stereo_tone(0.01)
    assert as_stereo(wav) is wav


@pytest.mark.parametrize("channels", [3, 6])
def test_more_than_two_channels_are_refused_here(channels: int) -> None:
    # They are folded down by ffmpeg before they get this far.
    with pytest.raises(ValueError, match="one or two channels"):
        as_stereo(np.zeros((channels, 4), dtype=np.float32))


# --- stems --------------------------------------------------------------------


def test_the_backing_is_the_sum_of_every_source_but_the_voice() -> None:
    sources = known_sources(2_000, STEM_RATE)

    vocals, no_vocals = combine_stems(sources)

    assert vocals is sources["vocals"]
    np.testing.assert_allclose(no_vocals, backing_of(sources), atol=1e-7)
    # Left alone: the sum is built in a new array.
    np.testing.assert_array_equal(
        sources["drums"], known_sources(2_000, STEM_RATE)["drums"]
    )


def test_a_model_with_more_sources_has_them_all_in_the_backing() -> None:
    sources = known_sources(500, STEM_RATE)
    sources["piano"] = np.full_like(sources["vocals"], 0.01)
    sources["guitar"] = np.full_like(sources["vocals"], 0.02)

    _, no_vocals = combine_stems(sources)

    np.testing.assert_allclose(no_vocals, backing_of(sources), atol=1e-7)


def test_a_model_without_a_voice_is_refused_by_name() -> None:
    sources = known_sources(100, STEM_RATE)
    del sources["vocals"]
    with pytest.raises(ValueError) as raised:
        combine_stems(sources)
    # The why alone: the step puts the what in front of it.
    assert (
        str(raised.value) == "the model makes no vocals source, only drums, bass, other"
    )


def test_a_model_with_only_a_voice_has_no_backing_to_keep() -> None:
    only = {"vocals": known_sources(100, STEM_RATE)["vocals"]}
    with pytest.raises(ValueError, match="no backing"):
        combine_stems(only)


@pytest.mark.parametrize("names", [["vocals", "other"], FOUR, SIX, ["other", "vocals"]])
def test_a_model_with_a_voice_and_something_to_sing_over_is_accepted(
    names: list[str],
) -> None:
    check_sources(names)


@pytest.mark.parametrize(
    ("names", "why"),
    [
        (["drums", "bass"], "no vocals source, only drums, bass"),
        ([], "no vocals source, only nothing"),
        (["vocals"], "only a vocals source, so there is no backing"),
        (["Vocals", "other"], "no vocals source, only Vocals, other"),
    ],
)
def test_a_model_that_cannot_give_a_voice_and_a_backing_is_refused(
    names: list[str], why: str
) -> None:
    with pytest.raises(ValueError, match=why):
        check_sources(names)


@pytest.mark.parametrize("peak", [0.0, 0.5, -0.998, 0.998])
def test_stems_under_the_ceiling_are_not_touched(peak: float) -> None:
    vocals = np.full((2, 8), peak, dtype=np.float32)
    backing = np.full((2, 8), -0.5, dtype=np.float32)

    got_vocals, got_backing, gain = limit_stems(vocals, backing)

    assert (got_vocals is vocals, got_backing is backing, gain) == (True, True, 1.0)


@pytest.mark.parametrize("peak", [1.0, 1.0001, 0.9991, -2.0])
def test_stems_over_the_ceiling_are_scaled_even_by_a_hair(peak: float) -> None:
    vocals = np.full((2, 8), peak, dtype=np.float32)
    backing = np.zeros((2, 8), dtype=np.float32)

    got_vocals, _, gain = limit_stems(vocals, backing)

    assert gain == pytest.approx(CLIP_CEILING / abs(peak))
    assert float(np.abs(got_vocals).max()) == pytest.approx(CLIP_CEILING, rel=1e-6)


@pytest.mark.parametrize(
    ("vocals_peak", "backing_peak"),
    [(1.2, 0.4), (0.4, 1.2), (-1.2, 0.4), (0.4, -1.2), (1.5, -1.5)],
)
def test_stems_that_would_clip_are_scaled_by_one_shared_factor(
    vocals_peak: float, backing_peak: float
) -> None:
    rng = np.random.default_rng(3)
    shape = (2, 400)
    vocals = (rng.uniform(-0.3, 0.3, shape)).astype(np.float32)
    backing = (rng.uniform(-0.3, 0.3, shape)).astype(np.float32)
    vocals[0, 7], backing[1, 9] = vocals_peak, backing_peak
    before = (vocals.copy(), backing.copy())
    peak = max(abs(vocals_peak), abs(backing_peak))

    scaled_vocals, scaled_backing, gain = limit_stems(vocals, backing)

    assert gain == pytest.approx(CLIP_CEILING / peak)
    # Neither clips, and the larger one lands on the ceiling.
    top = max(float(np.abs(scaled_vocals).max()), float(np.abs(scaled_backing).max()))
    assert top == pytest.approx(CLIP_CEILING, rel=1e-6)
    assert top <= 1.0
    # The same factor for both, so their balance and their sum are kept, times
    # it: dividing by the gain gives the model's own levels back.
    np.testing.assert_allclose(scaled_vocals, before[0] * gain, rtol=1e-6, atol=1e-7)
    np.testing.assert_allclose(scaled_backing, before[1] * gain, rtol=1e-6, atol=1e-7)
    np.testing.assert_allclose(
        scaled_vocals + scaled_backing,
        gain * (before[0] + before[1]),
        rtol=1e-5,
        atol=1e-6,
    )
    # The caller's arrays are not edited.
    np.testing.assert_array_equal(vocals, before[0])
    np.testing.assert_array_equal(backing, before[1])


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_stems_that_are_not_numbers_are_refused(bad: float) -> None:
    good = np.zeros((2, 4), dtype=np.float32)
    broken = good.copy()
    broken[0, 1] = bad
    with pytest.raises(ValueError, match="not numbers"):
        limit_stems(broken, good)
    with pytest.raises(ValueError, match="not numbers"):
        limit_stems(good, broken)


# --- progress -----------------------------------------------------------------

# htdemucs_ft's models cut 44.1 kHz audio into 7.8 s segments that overlap by a
# quarter: a stride of 257,985 samples, which cuts a four minute song in 42.
STRIDE = 257_985
FOUR_MINUTES = 4 * 60 * 44_100
SEGMENTS = 42


def bag_events(
    models: int,
    shifts: int,
    segments: int = SEGMENTS,
    length: int = FOUR_MINUTES,
    stride: int = STRIDE,
) -> Iterator[dict[str, Any]]:
    """What apply_model sends for a bag, in the order it sends it."""
    for model in range(models):
        for shift in range(shifts):
            for segment in range(segments):
                for state in ("start", "end"):
                    yield {
                        "model_idx_in_bag": model,
                        "shift_idx": shift,
                        "segment_offset": segment * stride,
                        "state": state,
                        "audio_length": length,
                        "models": models,
                    }


def progress_of(events: Iterator[dict[str, Any]], **options: Any) -> list[float]:
    reported: list[float] = []
    callback = bag_progress(reported.append, **options)
    for event in events:
        callback(event)
    return reported


@pytest.mark.parametrize(("models", "shifts"), [(4, 1), (1, 1), (4, 2), (2, 3)])
def test_progress_runs_up_to_about_the_cap_across_the_whole_bag(
    models: int, shifts: int
) -> None:
    reported = progress_of(bag_events(models, shifts), shifts=shifts)

    assert reported == sorted(reported)
    assert len(set(reported)) == len(reported)
    assert all(0.0 < value <= PROGRESS_CAP for value in reported)
    # One segment behind at the very end, so a little short of the cap.
    assert PROGRESS_CAP - 0.02 < reported[-1] <= PROGRESS_CAP
    assert PROGRESS_CAP == 0.95


def test_progress_counts_every_model_of_the_bag() -> None:
    reported = progress_of(bag_events(4, 1))

    # The first model of four is a quarter of the work.
    first_model_done = [v for v in reported if v <= PROGRESS_CAP / 4]
    assert 0.2 < first_model_done[-1] <= PROGRESS_CAP / 4
    assert len(first_model_done) < len(reported) / 2


def test_progress_counts_every_shift_of_a_model() -> None:
    reported = progress_of(bag_events(1, 2), shifts=2)

    half = [v for v in reported if v <= PROGRESS_CAP / 2]
    assert 0.4 < half[-1] <= PROGRESS_CAP / 2


def test_only_the_end_of_a_segment_counts() -> None:
    starts = [e for e in bag_events(4, 1) if e["state"] == "start"]
    assert progress_of(iter(starts)) == []


def test_progress_never_goes_backwards_when_segments_finish_out_of_order() -> None:
    events = [e for e in bag_events(2, 1, segments=6) if e["state"] == "end"]
    # Segments 0-5 of each model, finishing in a shuffled order.
    order = [3, 1, 0, 5, 2, 4]
    shuffled = [events[m * 6 + i] for m in range(2) for i in order]

    reported = progress_of(iter(shuffled))

    assert reported == sorted(reported)
    assert reported[-1] <= PROGRESS_CAP


def test_a_pass_longer_than_the_audio_cannot_pass_the_cap() -> None:
    # A shifted pass is up to half a second longer than the audio, so the last
    # segment's offset can lie past its end.
    event = next(e for e in bag_events(1, 1, segments=1) if e["state"] == "end")
    event["segment_offset"] = int(FOUR_MINUTES * 1.2)

    assert progress_of(iter([event])) == [PROGRESS_CAP]


def test_progress_follows_a_different_cap() -> None:
    reported = progress_of(bag_events(4, 1), cap=0.5)
    assert 0.48 < reported[-1] <= 0.5


@pytest.mark.parametrize(
    "event",
    [
        {},
        {"state": "end"},
        {"state": "end", "models": "four", "model_idx_in_bag": 0},
        {
            "state": "end",
            "models": 4,
            "model_idx_in_bag": None,
            "shift_idx": 0,
            "segment_offset": 0,
            "audio_length": 10,
        },
    ],
)
def test_an_event_without_what_it_needs_is_ignored_not_fatal(
    event: dict[str, Any],
) -> None:
    assert progress_of(iter([event])) == []
