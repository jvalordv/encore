"""Chroma alignment against synthetic songs with known warps and shifts."""

import numpy as np

from encore_service import align
from tests.audio_synth import (
    DIATONIC,
    OTHER_PROGRESSION,
    PROGRESSION,
    RATE,
    random_song,
    render,
)


def chroma_of(audio: np.ndarray) -> align.Chroma:
    return align.chroma(audio, RATE)


def test_chroma_shows_what_changes_from_the_recordings_mean() -> None:
    frames = chroma_of(render(PROGRESSION, bars=4)).frames
    # Mid-way through the first chord (Am: pitch classes 9, 0, 4) its notes
    # stand above the song's mean chroma and the pitch classes no chord of
    # the song plays stand below it.
    first = frames[int(1.0 / 0.0464)]
    assert all(first[pc] > 0 for pc in (9, 0, 4))
    assert first[1] < 0


def test_frames_are_unit_length_or_zero_and_silence_is_zero() -> None:
    audio = np.concatenate([render(PROGRESSION, bars=2), np.zeros(RATE)])
    frames = chroma_of(audio).frames
    norms = np.linalg.norm(frames, axis=1)
    assert np.all((np.abs(norms - 1.0) < 1e-4) | (norms == 0.0))
    assert np.all(frames[-5:] == 0.0)


def test_a_stretched_and_transposed_song_aligns() -> None:
    # The original has a vocal; the karaoke is the chords alone, five per
    # cent slower and two semitones up.
    original = chroma_of(render(PROGRESSION, vocal=True))
    karaoke = chroma_of(render(PROGRESSION, transpose=2, stretch=1.05))

    result = align.align(karaoke, original)

    assert result.key_offset == -2 or result.key_offset == 2
    # Raising the original by the offset must match the karaoke: up two.
    assert result.key_offset == 2
    assert result.confidence > align.CONFIDENCE_FLOOR
    # Karaoke second t sits at t / 1.05 in the original.
    tm = result.time_map
    inside = (tm.from_s > 3) & (tm.from_s < tm.from_s[-1] - 3)
    error = np.abs(tm.to_s[inside] - tm.from_s[inside] / 1.05)
    assert np.median(error) < 0.15
    assert error.max() < 0.5


def test_the_time_map_never_runs_backwards() -> None:
    original = chroma_of(render(PROGRESSION))
    karaoke = chroma_of(render(PROGRESSION, stretch=1.05))
    tm = align.align(karaoke, original).time_map
    assert np.all(np.diff(tm.from_s) > 0)
    assert np.all(np.diff(tm.to_s) >= 0)


def test_a_karaoke_with_an_intro_still_aligns() -> None:
    original = render(PROGRESSION)
    intro = np.zeros(int(4.0 * RATE), dtype=np.float32)
    karaoke = np.concatenate([intro, original])
    result = align.align(chroma_of(karaoke), chroma_of(original), search_key=False)
    tm = result.time_map
    late = tm.from_s > 10
    assert np.median(np.abs(tm.to_s[late] - (tm.from_s[late] - 4.0))) < 0.15


def test_an_unrelated_progression_falls_below_the_floor() -> None:
    original = chroma_of(render(PROGRESSION, vocal=True))
    other = chroma_of(render(OTHER_PROGRESSION, bar_s=1.3))
    result = align.align(other, original)
    assert result.confidence < align.CONFIDENCE_FLOOR


def test_a_very_different_tempo_is_not_trusted() -> None:
    original = chroma_of(render(PROGRESSION))
    # Half as fast: the warp's slope is 2, outside the believable range.
    slow = chroma_of(render(PROGRESSION, stretch=1.6, bars=7))
    result = align.align(slow, original, search_key=False)
    assert result.confidence < align.CONFIDENCE_FLOOR


def test_dense_unrelated_songs_are_refused_whatever_the_seed() -> None:
    # Random chords over every pitch class: the all-positive chroma that once
    # matched anything at cosine 0.75 must not pass for the same song.
    for seed in range(4):
        a = chroma_of(random_song(seed))
        b = chroma_of(random_song(seed + 100))
        result = align.align(a, b)
        assert result.confidence < align.CONFIDENCE_FLOOR, seed
        assert result.path_cost > align.COST_BAD, seed


def test_a_different_progression_in_the_same_key_is_refused() -> None:
    original = chroma_of(render(PROGRESSION, vocal=True))
    for seed in range(3):
        other = chroma_of(random_song(seed, pool=DIATONIC, bar_s=1.0, bars=24))
        assert align.align(other, original).confidence < align.CONFIDENCE_FLOOR
    # The fast, dense case is the hardest: both songs draw on the same seven
    # chords, and a free warp can pair most of them up.
    for seed in range(3):
        a = chroma_of(random_song(seed, pool=DIATONIC))
        b = chroma_of(random_song(seed + 50, pool=DIATONIC))
        assert align.align(a, b).confidence < align.CONFIDENCE_FLOOR, seed


def _cut_case(first: float, last: float) -> tuple[align.Alignment, float]:
    song = random_song(7, bars=60, bar_s=1.0)
    start = int(first * len(song))
    karaoke = song[start : int(last * len(song))]
    result = align.align(chroma_of(karaoke), chroma_of(song))
    return result, start / RATE


def test_a_karaoke_cut_from_the_middle_of_the_original_aligns() -> None:
    result, start_s = _cut_case(0.30, 0.75)
    assert result.confidence > 0.9
    assert result.key_offset == 0
    tm = result.time_map
    error = np.abs(tm.to_s - (tm.from_s + start_s))
    assert np.median(error) < 0.15
    assert np.percentile(error, 95) < 0.5


def test_a_karaoke_that_is_the_final_part_of_the_original_aligns() -> None:
    result, start_s = _cut_case(0.55, 1.0)
    assert result.confidence > 0.9
    tm = result.time_map
    error = np.abs(tm.to_s - (tm.from_s + start_s))
    assert np.median(error) < 0.15
    assert np.percentile(error, 95) < 0.5


def test_pooled_long_songs_align_like_short_ones() -> None:
    # A low pooling threshold stands in for a song over four and a half
    # minutes: the fine pass then works on pooled frames.
    original = chroma_of(render(PROGRESSION, vocal=True, bars=20))
    karaoke = chroma_of(render(PROGRESSION, transpose=2, stretch=1.05, bars=20))
    result = align.align(karaoke, original, max_dtw_frames=150)
    assert result.key_offset == 2
    assert result.confidence > align.CONFIDENCE_FLOOR
    tm = result.time_map
    inside = (tm.from_s > 3) & (tm.from_s < tm.from_s[-1] - 3)
    error = np.abs(tm.to_s[inside] - tm.from_s[inside] / 1.05)
    assert np.median(error) < 0.3
