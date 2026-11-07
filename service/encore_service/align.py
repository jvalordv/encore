"""Aligning two recordings of one song by chroma and dynamic time warping.

Used to score a karaoke video against its original: the karaoke track has no
vocal, so no melody, but it plays the same chords as the original's backing.
`align` turns both into chroma (12 pitch-class bins per frame), finds the key
shift that makes them match, and warps one onto the other. The result is a
monotone time map from the first recording's seconds to the second's, a key
offset in semitones, and a confidence. Everything here is numpy, checked
against synthetic chords with known answers (tests/test_align.py).

Why these choices: chroma ignores timbre, so a karaoke rebuild of the backing
still matches; the chroma is mean-centred so unrelated music scores as
unrelated; a coarse unbanded search finds where the karaoke sits (it may be
a cut of the original) and a band around that path keeps the full-resolution
grid small; a path that needs a tempo far from 1 means the
karaoke is another arrangement, which the slope check turns into low
confidence rather than a confident wrong map.
"""

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float32]

HOP_S = 0.0464  # frame spacing: ~46 ms
WINDOW_S = 0.186  # analysis window, long enough to split semitones at 100 Hz
# Pitches outside this band carry little harmony and much noise.
LOW_HZ = 65.0
HIGH_HZ = 2100.0
# Log compression strength: how much quiet partials count against loud ones.
COMPRESSION = 100.0
# A frame this quiet next to the loudest says nothing about harmony.
SILENCE_RATIO = 1e-3
# A centred frame shorter than this equals the recording's mean chroma.
FLAT_NORM = 0.01
CHUNK_FRAMES = 512  # frames transformed at once, to bound memory

# The fine pass searches this far (seconds) either side of the coarse path.
FINE_BAND_S = 6.0
STEP_PENALTY = 0.2  # added to a horizontal or vertical step, so diagonals win
MAX_DTW_FRAMES = 6000  # longer inputs are pooled in the fine pass
COARSE_FRAMES = 1200  # frames the unbanded key and path search works at

SLOPE_LOW = 0.8
SLOPE_HIGH = 1.25
SLOPE_WINDOW_S = 10.0
# The share of windows that must keep the warp within the slope limits.
SLOPE_SHARE_FLOOR = 0.6
# Mean path cost (detours included) of a good match and of a refused one, for
# scaling the confidence. Measured on synthetic songs (tests/audio_synth.py)
# with mean-centred chroma: the same song 0.26, 0.8x or 1.25x stretched
# 0.26-0.29, transposed and stretched 0.26, a 30-75 % cut 0.00 (the original
# there has no vocal), two unrelated dense songs 0.66-0.72, a different
# progression 0.63, a different song in the same key 0.46-0.62, two dense
# random songs from the same seven chords 0.40-0.50 (the worst case). The
# fit alone is 0.5 at 0.385, below every unrelated case and above the matches.
COST_GOOD = 0.32
COST_BAD = 0.45
# A path must be at least this share of the shorter recording's length: a
# repeated verse would otherwise let a shifted fragment beat the whole song.
MIN_PATH_SHARE = 0.75
# The share of the first recording the path must cover; a path that covers
# less has matched a fragment, not the song.
COVERAGE_FLOOR = 0.6
# Below this confidence the alignment is refused: the arrangement differs.
CONFIDENCE_FLOOR = 0.5


@dataclass(frozen=True)
class Chroma:
    """Chroma frames, shape (frames, 12), one every `hop_s` seconds."""

    frames: Array
    hop_s: float


@dataclass(frozen=True)
class TimeMap:
    """Where each of the first recording's frames lands in the second."""

    from_s: NDArray[np.float64]  # increasing
    to_s: NDArray[np.float64]  # never decreasing


@dataclass(frozen=True)
class Alignment:
    """The result of aligning recording A to recording B."""

    time_map: TimeMap
    key_offset: int  # semitones to shift B up to match A, in -6..5
    confidence: float  # 0 to 1
    path_cost: float  # mean cost per path cell, detours included; 0 is the same
    slope_share: float  # share of windows with a believable tempo ratio
    coverage: float  # share of A the path covers


def chroma(samples: NDArray[np.floating], rate: int) -> Chroma:
    """Log-compressed, per-frame normalised chroma of mono audio."""
    hop = max(1, round(HOP_S * rate))
    nfft = 1 << int(np.ceil(np.log2(WINDOW_S * rate)))
    x = np.asarray(samples, dtype=np.float32)
    x = np.pad(
        x, (nfft // 2, nfft // 2 + hop), mode="reflect" if len(x) > nfft else "constant"
    )
    count = max(1, (len(x) - nfft) // hop)
    window = np.hanning(nfft).astype(np.float32)
    freqs = np.fft.rfftfreq(nfft, 1.0 / rate)
    keep = (freqs >= LOW_HZ) & (freqs <= HIGH_HZ)
    pitch_class = np.round(12 * np.log2(freqs[keep] / 440.0) + 69).astype(int) % 12
    fold = np.zeros((int(keep.sum()), 12), dtype=np.float32)
    fold[np.arange(len(pitch_class)), pitch_class] = 1.0

    out = np.empty((count, 12), dtype=np.float32)
    for start in range(0, count, CHUNK_FRAMES):
        stop = min(count, start + CHUNK_FRAMES)
        idx = np.arange(start, stop)[:, None] * hop + np.arange(nfft)[None, :]
        spectrum = np.abs(np.fft.rfft(x[idx] * window, axis=1))[:, keep]
        out[start:stop] = spectrum.astype(np.float32) @ fold
    return Chroma(frames=_normalise(out), hop_s=hop / rate)


def _normalise(raw: Array) -> Array:
    """Compress, mean-centre and scale each frame to unit length.

    Log chroma is all positive, so any two recordings sit near cosine 0.75
    whatever they play. Subtracting the recording's own mean chroma leaves
    only what changes from frame to frame (the harmony), so unrelated music
    matches at about zero cosine. Silence and frames that equal the mean
    carry no harmony and become zero vectors, which cost 1 against anything.
    """
    loudest = float(raw.sum(axis=1).max()) if len(raw) else 0.0
    if loudest <= 0:
        return np.zeros_like(raw)
    scaled = np.log1p(COMPRESSION * raw / loudest)
    unit = scaled / np.maximum(np.linalg.norm(scaled, axis=1, keepdims=True), 1e-9)
    voiced = raw.sum(axis=1) >= SILENCE_RATIO * loudest
    if not voiced.any():
        return np.zeros_like(raw)
    centred = unit - unit[voiced].mean(axis=0)
    norm = np.linalg.norm(centred, axis=1, keepdims=True)
    out = centred / np.maximum(norm, 1e-9)
    out[~voiced | (norm[:, 0] < FLAT_NORM)] = 0.0
    return out.astype(np.float32)


def _pool(frames: Array, factor: int) -> Array:
    """Average runs of `factor` frames, then renormalise to unit length."""
    if factor <= 1:
        return frames
    usable = (len(frames) // factor) * factor
    if usable == 0:
        return frames
    pooled = frames[:usable].reshape(-1, factor, 12).mean(axis=1)
    return (
        pooled / np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-9)
    ).astype(np.float32)


def _dtw(
    a: Array,
    b: Array,
    centre: NDArray[np.float64] | None = None,
    half: float = np.inf,
) -> tuple[NDArray[np.int64], NDArray[np.int64], float]:
    """DTW between chroma sequences; returns the path and its mean cost.

    The mean covers the frames' cost and the penalty of each non-diagonal
    step, the quantity the search minimises.

    With `centre` (the expected column of each row of `a`) the search stays
    within `half` columns of it; without, every cell is searched.

    Cost is one minus the cosine of two frames. The path may start on the
    first row or column and end on the last, so one recording may begin
    before or end after the other. Cells fill by anti-diagonal, so the work
    is vectorised across each diagonal, not a loop over cells.
    """
    n, m = len(a), len(b)
    inf = np.float32(np.inf)
    if centre is None:
        centre = np.zeros(n)
    # Padded by one so a start can read a zero from outside the grid.
    total = np.full((n + 1, m + 1), inf, dtype=np.float32)
    total[0, :] = 0.0
    total[:, 0] = 0.0
    total[0, 0] = 0.0
    came = np.zeros((n + 1, m + 1), dtype=np.int8)
    # Cells on the path to each cell, to score ends by cost per cell and to
    # refuse a fragment that merely touches a corner.
    length = np.zeros((n + 1, m + 1), dtype=np.int16)
    for d in range(n + m - 1):
        i = np.arange(max(0, d - m + 1), min(n - 1, d) + 1)
        j = d - i
        inside = np.abs(j - centre[i]) <= half
        i, j = i[inside], j[inside]
        if len(i) == 0:
            continue
        cost = 1.0 - np.einsum("ij,ij->i", a[i], b[j])
        diag = total[i, j]
        up = total[i, j + 1] + STEP_PENALTY
        left = total[i + 1, j] + STEP_PENALTY
        best = np.minimum(diag, np.minimum(up, left))
        total[i + 1, j + 1] = best + cost
        step = np.where(diag <= np.minimum(up, left), 0, np.where(up <= left, 1, 2))
        came[i + 1, j + 1] = step
        length[i + 1, j + 1] = (
            np.where(
                step == 0,
                length[i, j],
                np.where(step == 1, length[i, j + 1], length[i + 1, j]),
            )
            + 1
        )

    # Free end on the last row or column, scored per path cell so a short
    # path is not favoured, and only paths spanning MIN_PATH_SHARE of the
    # shorter recording count.
    ends_i = np.concatenate([np.full(m, n), np.arange(1, n + 1)])
    ends_j = np.concatenate([np.arange(1, m + 1), np.full(n, m)])
    end_total = total[ends_i, ends_j]
    end_len = length[ends_i, ends_j].astype(np.float64)
    valid = np.isfinite(end_total) & (end_len >= MIN_PATH_SHARE * min(n, m))
    if not valid.any():
        raise ValueError("No warping path fits inside the band.")
    score = np.where(valid, end_total / np.maximum(end_len, 1.0), inf)
    pick = int(np.argmin(score))
    i, j = int(ends_i[pick]), int(ends_j[pick])

    path_i: list[int] = []
    path_j: list[int] = []
    cost_sum = 0.0
    while i > 0 and j > 0:
        path_i.append(i - 1)
        path_j.append(j - 1)
        cost_sum += float(1.0 - a[i - 1] @ b[j - 1])
        step = came[i, j]
        if step == 0:
            i, j = i - 1, j - 1
        else:
            # A detour is paid for, so a path that matches by twisting
            # through a few shared chords does not look like the same song.
            cost_sum += STEP_PENALTY
            if step == 1:
                i -= 1
            else:
                j -= 1
    pi = np.array(path_i[::-1], dtype=np.int64)
    pj = np.array(path_j[::-1], dtype=np.int64)
    return pi, pj, cost_sum / max(len(pi), 1)


def _time_map(
    pi: NDArray[np.int64],
    pj: NDArray[np.int64],
    hop_a: float,
    hop_b: float,
    factor: int,
) -> TimeMap:
    """The path as seconds in A against seconds in B, one point per A frame."""
    rows = np.unique(pi)
    # Several path cells share a row when the warp runs horizontally: take
    # the middle of that run.
    mean_j = _row_means(pi, pj, rows)
    middle = (factor - 1) / 2
    from_s = (rows * factor + middle) * hop_a
    to_s = (mean_j * factor + middle) * hop_b
    return TimeMap(from_s=from_s.astype(np.float64), to_s=np.maximum.accumulate(to_s))


def _row_means(
    pi: NDArray[np.int64], pj: NDArray[np.int64], rows: NDArray[np.int64]
) -> NDArray[np.float64]:
    """Mean column per row without a Python loop over every row."""
    sums = np.bincount(pi - rows[0], weights=pj.astype(np.float64))
    counts = np.bincount(pi - rows[0])
    return sums[rows - rows[0]] / counts[rows - rows[0]]


def _slope_share(time_map: TimeMap) -> float:
    """Share of 10 s stretches whose tempo ratio stays within believable."""
    t, u = time_map.from_s, time_map.to_s
    if len(t) < 2 or t[-1] - t[0] < 1.0:
        return 0.0
    starts = np.arange(t[0], t[-1] - SLOPE_WINDOW_S / 2, SLOPE_WINDOW_S / 2)
    if len(starts) == 0:
        starts = np.array([t[0]])
    ratios = []
    for s in starts:
        e = min(s + SLOPE_WINDOW_S, t[-1])
        if e - s < 1.0:
            continue
        ratios.append((np.interp(e, t, u) - np.interp(s, t, u)) / (e - s))
    if not ratios:
        return 0.0
    r = np.array(ratios)
    return float(np.mean((r >= SLOPE_LOW) & (r <= SLOPE_HIGH)))


def _confidence(cost: float, slope_share: float, coverage: float) -> float:
    """Fold the three checks into one number in 0..1; any weak one drags it."""
    fit = float(np.clip((COST_BAD - cost) / (COST_BAD - COST_GOOD), 0.0, 1.0))
    tempo = float(np.clip(slope_share / SLOPE_SHARE_FLOOR, 0.0, 1.0))
    cover = float(np.clip(coverage / COVERAGE_FLOOR, 0.0, 1.0))
    return fit * tempo * cover


def _circular(offset: int) -> int:
    """A semitone count folded into -6..5."""
    return (offset + 6) % 12 - 6


def _refine(
    fa: Array,
    fb: Array,
    coarse_i: NDArray[np.int64],
    coarse_j: NDArray[np.int64],
    scale: float,
    hop_s: float,
) -> tuple[NDArray[np.int64], NDArray[np.int64], float]:
    """Warp at full resolution inside a band around the coarse path.

    Only the stretch of each recording the coarse path touches (plus the
    band's width) is searched, so a karaoke that is a cut of the original
    still has its whole span inside the grid. `scale` turns a coarse index
    into this resolution's; `hop_s` is this resolution's frame spacing.
    """
    rows = np.unique(coarse_i)
    cols = _row_means(coarse_i, coarse_j, rows)
    fine_rows = (rows + 0.5) * scale - 0.5
    fine_cols = (cols + 0.5) * scale - 0.5
    margin = max(1, int(np.ceil(FINE_BAND_S / hop_s)))
    n, m = len(fa), len(fb)
    i0 = max(0, int(np.floor(fine_rows[0])) - margin)
    i1 = min(n, int(np.ceil(fine_rows[-1])) + margin + 1)
    j0 = max(0, int(np.floor(fine_cols.min())) - margin)
    j1 = min(m, int(np.ceil(fine_cols.max())) + margin + 1)
    centre = np.interp(np.arange(i0, i1), fine_rows, fine_cols) - j0
    pi, pj, cost = _dtw(fa[i0:i1], fb[j0:j1], centre, float(margin))
    return pi + i0, pj + j0, cost


def align(
    a: Chroma,
    b: Chroma,
    search_key: bool = True,
    report: Callable[[float], None] | None = None,
    max_dtw_frames: int = MAX_DTW_FRAMES,
) -> Alignment:
    """Align A to B: the time map A -> B, the key shift and a confidence.

    `key_offset` is the number of semitones B must be raised to match A.
    Two passes: an unbanded subsequence DTW on heavily pooled chroma (once
    per key shift when `search_key`) finds the key and the rough path
    wherever in B the karaoke sits; then the winning shift is warped at
    full resolution in a band around that path. Songs longer than
    `max_dtw_frames` are pooled in the second pass. `report`, when given,
    is called with progress from 0 to 1.
    """

    def tell(value: float) -> None:
        if report is not None:
            report(value)

    longest = max(len(a.frames), len(b.frames))
    coarse = max(1, int(np.ceil(longest / COARSE_FRAMES)))
    ca, cb = _pool(a.frames, coarse), _pool(b.frames, coarse)
    shifts = range(12) if search_key else range(1)
    found: dict[int, tuple[NDArray[np.int64], NDArray[np.int64], float]] = {}
    for step, k in enumerate(shifts):
        tell(0.45 * step / len(shifts))
        try:
            found[k] = _dtw(ca, np.roll(cb, k, axis=1))
        except ValueError:
            continue
    if not found:
        raise ValueError("No warping path fits.")
    # Ties go to the smaller shift: a key change is the rarer explanation.
    best = min(found, key=lambda k: (round(found[k][2], 4), abs(_circular(k))))
    offset = _circular(best)
    tell(0.5)

    fine = max(1, int(np.ceil(longest / max_dtw_frames)))
    fa = _pool(a.frames, fine)
    fb = _pool(np.roll(b.frames, offset, axis=1), fine)
    pi, pj, cost = _refine(
        fa, fb, found[best][0], found[best][1], coarse / fine, a.hop_s * fine
    )
    tell(0.95)
    time_map = _time_map(pi, pj, a.hop_s, b.hop_s, fine)
    duration = len(a.frames) * a.hop_s
    coverage = (
        float((time_map.from_s[-1] - time_map.from_s[0]) / duration)
        if duration
        else 0.0
    )
    slope_share = _slope_share(time_map)
    return Alignment(
        time_map=time_map,
        key_offset=offset,
        confidence=_confidence(cost, slope_share, coverage),
        path_cost=cost,
        slope_share=slope_share,
        coverage=coverage,
    )
