"""The key step: the song's key, from its instrumental stem.

`extract_key` is the runner registered for the `key` step in `pipeline.py`.
It reads `no_vocals.flac`, finds the key of each stretch of the song with
`estimate_key`, and stores the `KeyMap` as `key.json`, which the browser gets
from `GET /songs/{id}/key`. Open scoring uses it to tell a freestyle note that
fits the song from one that does not (`docs/COACHING.md`, "Scoring styles").
It runs for every song, sung or not: the instrumental is there either way.

`estimate_key` is a pure function of mono samples and a rate, so the tests run
it on synthetic audio. The steps, all numpy:

1. A magnitude STFT with frames of about 186 ms (8192 samples at 44.1 kHz,
   scaled with the rate so a bin is always about 5.4 Hz wide, enough to
   separate the low notes) and a 50% hop. Frames quieter than SILENCE_DBFS
   are left out of everything that follows.
2. The tuning: every spectral peak between 200 Hz and 4 kHz is placed to a
   fraction of a bin (parabola through three log magnitudes), and its distance
   from the nearest equal-tempered semitone becomes an angle; the offset is
   the magnitude-weighted circular mean of those angles, in cents. If the
   peaks have no common offset (noise) it is reported as 0.
3. Chroma: each bin from 60 Hz to 5 kHz is placed on the semitone scale
   shifted by the tuning offset and shared between its two nearest semitones,
   which are folded to 12 pitch classes. Each pitch class is divided by the
   total weight it took, so a flat spectrum gives a flat chroma. Magnitudes
   are used as they are: square-rooting them (tried, on I-IV-V-I loops in
   six keys) lifts the skirts and weak partials of every note to the level of
   the notes and loses the tonic to the dominant in a quarter of the loops.
4. Windows of WINDOW_S seconds every HOP_S seconds sum their frames' chroma
   and score it against the 24 key profiles (Krumhansl and Kessler, 1982) by
   correlation. The correlation is ridge-regularised: the chroma's variance
   is added to a term of RIDGE times its mean, squared, so a window with
   almost no tonal energy (silence, noise, a flat chroma) scores near 0 for
   every key instead of having its tiny fluctuations stretched to full scale.
5. Smoothing is a Viterbi pass over the 24 keys that maximises the summed
   scores of the windows minus SWITCH_PENALTY for every change of key. A key
   change is found where the evidence for the new key outweighs the penalty,
   so it lands about where the window centres cross the true boundary, while
   one odd window (or a short passage borrowed from another key) cannot pay
   for two switches and is smoothed over. Smoothing is by summed evidence, not
   a median, so a long, clear change is never held back.
6. Confidence, per window, for the key the path chose: how far its score is
   above the best score of any key that is not that key or its relative major
   or minor, divided by MARGIN_FULL and limited to 0..1. The relative is left
   out because it shares all seven notes and always scores almost as well; the
   comparison that matters is with a key that would change which notes fit.
   A segment's confidence is the mean over the windows it holds, and under
   CONFIDENCE_GATE the segment is "unclear": tonic and mode null.

Neighbouring segments are merged when they have the same key or are both
unclear, so they always differ. The segments cover the stem from 0 to its
duration; a boundary between two windows is the midpoint of their centres.
"""

import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypeVar

import numpy as np
import soundfile as sf
from numpy.typing import NDArray

from encore_service.errors import StepSkipped
from encore_service.schemas import KeyMap, KeySegment
from encore_service.store import SongStore

logger = logging.getLogger(__name__)

ResultT = TypeVar("ResultT")

Audio = NDArray[np.float32]
Report = Callable[[float], None]

# STFT: frame length at 44.1 kHz (scaled to other rates, to a power of two),
# and the hop as a share of the frame.
FRAME_AT_44K = 8192
REFERENCE_RATE = 44_100
# Frames are cut this many at a time, to keep the complex spectra small.
FRAMES_PER_BATCH = 256
# Frames whose RMS is under this (full scale is 0 dBFS) carry no tonal
# information worth reading, whatever their spectrum looks like.
SILENCE_DBFS = -60.0

# Bins used for the chroma, and for the tuning peaks. The tuning band starts
# higher: below it a semitone is narrower than the main lobe of a peak.
CHROMA_LOW_HZ = 60.0
CHROMA_HIGH_HZ = 5_000.0
TUNING_LOW_HZ = 200.0
TUNING_HIGH_HZ = 4_000.0
# A spectral peak counts for the tuning when it is this share of the loudest
# bin of its frame; the rest are skirts and noise.
PEAK_FLOOR = 0.05
# Under this share of unanimity among the peaks there is no tuning to report.
MIN_TUNING_CONCENTRATION = 0.1

# Key windows and how far apart they start.
WINDOW_S = 8.0
HOP_S = 2.0
# Added to the chroma's variance, as a multiple of its mean, squared; see 4.
RIDGE = 0.15
# The Viterbi cost of one change of key, in summed correlation. A true change
# makes the new key better by about 0.5 a window, so it pays back within a
# few windows; a lone odd window is worth about as much and cannot pay twice.
SWITCH_PENALTY = 0.75
# A margin of this much over the best unrelated key is full confidence. Keys
# a fifth apart share six of seven notes, so even a plain I-IV-V-I loop wins by
# only about 0.05 against the dominant's key; noise wins by under 0.01.
MARGIN_FULL = 0.1
# Under this confidence (a margin of 0.03) a segment's key is unclear.
CONFIDENCE_GATE = 0.3

MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)

# Share of the step the reading, the spectrum and the rest take.
READ_PROGRESS = 0.05
SPECTRUM_PROGRESS = 0.85

# State index -> (tonic, mode): 0..11 major, 12..23 minor.
_MODES: tuple[Literal["major", "minor"], ...] = ("major", "minor")


class KeyEstimationError(RuntimeError):
    """The key step failed; the message says what failed and why."""


def _profiles() -> NDArray[np.float64]:
    """The 24 key profiles as rows, centred and unit length.

    Row `t` is the major profile with its tonic at pitch class `t`, row
    `12 + t` the minor one; centring and scaling make the dot product with a
    centred chroma its correlation (up to the chroma's own scale).
    """
    rows = []
    for base in (MAJOR_PROFILE, MINOR_PROFILE):
        for tonic in range(12):
            row = np.roll(np.asarray(base, dtype=np.float64), tonic)
            row = row - row.mean()
            rows.append(row / np.linalg.norm(row))
    return np.stack(rows)


def _relatives() -> NDArray[np.intp]:
    """For each of the 24 keys, the index of its relative major or minor."""
    out = np.zeros(24, dtype=np.intp)
    for tonic in range(12):
        out[tonic] = 12 + (tonic + 9) % 12  # C major -> A minor
        out[12 + tonic] = (tonic + 3) % 12  # A minor -> C major
    return out


def frame_size(rate: int) -> int:
    """The STFT frame for `rate`: FRAME_AT_44K scaled, as a power of two."""
    scaled = FRAME_AT_44K * rate / REFERENCE_RATE
    return max(256, 2 ** round(math.log2(scaled)))


def _magnitudes(
    samples: Audio, rate: int, report: Report
) -> tuple[NDArray[np.float32], NDArray[np.float64], NDArray[np.bool_], int]:
    """The magnitude STFT of `samples`, for the bins the chroma uses.

    Returns (magnitudes of shape frames x bins, the frequency of each bin, a
    mask of frames loud enough to count, the first bin's index). Frames are
    cut from the zero-padded signal so the last samples are always in one.
    """
    size = frame_size(rate)
    hop = size // 2
    count = max(1, math.ceil((len(samples) - size) / hop) + 1)
    padded = np.zeros((count - 1) * hop + size, dtype=np.float32)
    padded[: len(samples)] = samples
    window = np.hanning(size + 1)[:-1].astype(np.float32)
    freqs = np.fft.rfftfreq(size, 1.0 / rate)
    low = int(np.searchsorted(freqs, CHROMA_LOW_HZ))
    high = int(np.searchsorted(freqs, min(CHROMA_HIGH_HZ, rate / 2)))
    mags = np.empty((count, high - low), dtype=np.float32)
    loud = np.empty(count, dtype=np.bool_)
    floor = 10 ** (SILENCE_DBFS / 20)
    for first in range(0, count, FRAMES_PER_BATCH):
        last = min(first + FRAMES_PER_BATCH, count)
        index = np.arange(first, last)[:, None] * hop + np.arange(size)[None, :]
        frames = padded[index]
        loud[first:last] = np.sqrt((frames**2).mean(axis=1)) >= floor
        spectrum = np.fft.rfft(frames * window, axis=1)
        mags[first:last] = np.abs(spectrum[:, low:high])
        report(last / count)
    return mags, freqs[low:high], loud, low


def estimate_tuning(
    mags: NDArray[np.float32],
    freqs: NDArray[np.float64],
    loud: NDArray[np.bool_],
    rate: int,
) -> float:
    """The offset of the music from A = 440 Hz, in cents in [-50, 50).

    See the module docstring, 2. Returns 0.0 when the spectral peaks agree on
    no offset (noise, silence).
    """
    band = (freqs >= TUNING_LOW_HZ) & (freqs <= TUNING_HIGH_HZ)
    cols = np.flatnonzero(band)
    if len(cols) < 3 or not loud.any():
        return 0.0
    sub = mags[loud][:, cols[0] - 1 : cols[-1] + 2].astype(np.float64)
    peak_row = sub[:, 1:-1]
    left, right = sub[:, :-2], sub[:, 2:]
    frame_max = sub.max(axis=1, keepdims=True)
    is_peak = (
        (peak_row > left)
        & (peak_row >= right)
        & (peak_row > PEAK_FLOOR * frame_max)
        & (peak_row > 0)
    )
    rows, columns = np.nonzero(is_peak)
    if len(rows) == 0:
        return 0.0
    a = np.log(left[rows, columns] + 1e-12)
    b = np.log(peak_row[rows, columns] + 1e-12)
    c = np.log(right[rows, columns] + 1e-12)
    curvature = a - 2 * b + c
    shift = np.where(
        curvature < 0, 0.5 * (a - c) / np.where(curvature < 0, curvature, 1), 0
    )
    bin_hz = freqs[1] - freqs[0]
    peak_hz = freqs[cols[0] + columns] + np.clip(shift, -0.5, 0.5) * bin_hz
    semitones = 12 * np.log2(peak_hz / 440.0)
    angle = 2 * np.pi * (semitones - np.round(semitones))
    weight = peak_row[rows, columns]
    total = weight.sum()
    resultant = (weight * np.exp(1j * angle)).sum() / total
    if abs(resultant) < MIN_TUNING_CONCENTRATION:
        return 0.0
    cents = float(np.angle(resultant) / (2 * np.pi) * 100)
    # np.angle is in (-pi, pi], so +50 is the one value outside [-50, 50).
    return -50.0 if cents >= 50.0 else cents


def _fold_matrix(
    freqs: NDArray[np.float64], tuning_cents: float
) -> NDArray[np.float64]:
    """Bins x 12 weights folding a spectrum to pitch classes (C = 0).

    Each bin's pitch, on the semitone scale with the tuning offset taken off,
    is shared between the two semitones either side of it; each column is
    scaled to sum to 1 so a flat spectrum folds to a flat chroma.
    """
    reference_hz = 440.0 * 2 ** (tuning_cents / 1200)
    midi = 69 + 12 * np.log2(freqs / reference_hz)
    lower = np.floor(midi)
    frac = midi - lower
    weights = np.zeros((len(freqs), 12))
    rows = np.arange(len(freqs))
    np.add.at(weights, (rows, lower.astype(int) % 12), 1 - frac)
    np.add.at(weights, (rows, (lower.astype(int) + 1) % 12), frac)
    totals = weights.sum(axis=0)
    return weights / np.where(totals > 0, totals, 1)


def _window_starts(duration_s: float) -> list[float]:
    """Start times of the key windows: every HOP_S, the last flush to the end."""
    if duration_s <= WINDOW_S:
        return [0.0]
    starts = [i * HOP_S for i in range(int((duration_s - WINDOW_S) / HOP_S) + 1)]
    if starts[-1] + WINDOW_S < duration_s - 1e-9:
        starts.append(duration_s - WINDOW_S)
    return starts


def _window_scores(
    frame_chroma: NDArray[np.float64],
    loud: NDArray[np.bool_],
    centres_s: NDArray[np.float64],
    starts: list[float],
    duration_s: float,
) -> NDArray[np.float64]:
    """Each window's 24 key scores (regularised correlation), windows x 24."""
    chroma = frame_chroma * loud[:, None]
    cumulative = np.concatenate([np.zeros((1, 12)), np.cumsum(chroma, axis=0)])
    begin = np.searchsorted(centres_s, starts, side="left")
    end = np.searchsorted(
        centres_s, [min(s + WINDOW_S, duration_s) for s in starts], side="left"
    )
    end[-1] = len(centres_s)
    summed = cumulative[end] - cumulative[begin]
    mean = summed.mean(axis=1, keepdims=True)
    centred = summed - mean
    scale = np.sqrt((centred**2).mean(axis=1) + (RIDGE * mean[:, 0]) ** 2)
    # Profiles are unit length over 12 values, so the dot product is the
    # covariance times sqrt(12); dividing by the same factor keeps r <= 1.
    dots = centred @ _profiles().T / math.sqrt(12)
    return dots / np.where(scale > 0, scale, 1)[:, None]


def _smooth(scores: NDArray[np.float64]) -> NDArray[np.intp]:
    """The Viterbi path over the 24 keys, one key index per window."""
    count = len(scores)
    best = scores[0].copy()
    came_from = np.zeros((count, 24), dtype=np.intp)
    for t in range(1, count):
        leader = int(np.argmax(best))
        switched = best[leader] - SWITCH_PENALTY
        stay = best >= switched
        came_from[t] = np.where(stay, np.arange(24), leader)
        best = np.where(stay, best, switched) + scores[t]
    path = np.zeros(count, dtype=np.intp)
    path[-1] = int(np.argmax(best))
    for t in range(count - 1, 0, -1):
        path[t - 1] = came_from[t, path[t]]
    return path


def _confidences(
    scores: NDArray[np.float64], path: NDArray[np.intp]
) -> NDArray[np.float64]:
    """Each window's confidence in its path key; see the module docstring, 6."""
    count = len(scores)
    rows = np.arange(count)
    rivals = scores.copy()
    rivals[rows, path] = -np.inf
    rivals[rows, _relatives()[path]] = -np.inf
    margin = scores[rows, path] - rivals.max(axis=1)
    return np.clip(margin / MARGIN_FULL, 0.0, 1.0)


def estimate_key(samples: Audio, rate: int, report: Report | None = None) -> KeyMap:
    """The key map of mono `samples` at `rate`; see the module docstring.

    Raises ValueError for a signal with no samples.
    """
    if len(samples) == 0 or rate <= 0:
        raise ValueError("there is no audio to read a key from")
    progress: Report = report if report is not None else (lambda _: None)
    duration_s = len(samples) / rate
    size = frame_size(rate)
    hop = size // 2

    mags, freqs, loud, _ = _magnitudes(
        samples,
        rate,
        lambda done: progress(
            READ_PROGRESS + (SPECTRUM_PROGRESS - READ_PROGRESS) * done
        ),
    )
    tuning = estimate_tuning(mags, freqs, loud, rate)
    fold = _fold_matrix(freqs, tuning)
    frame_chroma = mags.astype(np.float64) @ fold
    centres_s = (np.arange(len(mags)) * hop + size / 2) / rate

    starts = _window_starts(duration_s)
    scores = _window_scores(frame_chroma, loud, centres_s, starts, duration_s)
    path = _smooth(scores)
    confidence = _confidences(scores, path)
    progress(1.0)

    centres = np.array([min(s + WINDOW_S, duration_s) / 2 + s / 2 for s in starts])
    edges = np.concatenate([[0.0], (centres[:-1] + centres[1:]) / 2, [duration_s]])
    return KeyMap(
        tuning_cents=_report_cents(tuning),
        segments=_segments(path, confidence, edges),
    )


def _report_cents(cents: float) -> float:
    """`cents` rounded to 0.01 and kept in [-50, 50): rounding 49.996 gives 50."""
    rounded = round(cents, 2)
    return -50.0 if rounded >= 50.0 else rounded


@dataclass
class _Run:
    """A stretch of windows sharing one label: a key index, or None (unclear)."""

    label: int | None
    start: float
    end: float
    weighted: float  # sum of window confidence times window length


def _segments(
    path: NDArray[np.intp], confidence: NDArray[np.float64], edges: NDArray[np.float64]
) -> list[KeySegment]:
    """Runs of one key become segments, gated and merged; see the docstring."""
    runs: list[_Run] = []
    for index, key in enumerate(path.tolist()):
        start, end = float(edges[index]), float(edges[index + 1])
        weighted = float(confidence[index]) * (end - start)
        if runs and runs[-1].label == key:
            runs[-1].end = end
            runs[-1].weighted += weighted
        else:
            runs.append(_Run(key, start, end, weighted))
    merged: list[_Run] = []
    for run in runs:
        length = run.end - run.start
        clear = length > 0 and run.weighted / length >= CONFIDENCE_GATE
        label = run.label if clear else None
        if merged and merged[-1].label == label:
            merged[-1].end = run.end
            merged[-1].weighted += run.weighted
        else:
            merged.append(_Run(label, run.start, run.end, run.weighted))
    segments = []
    for run in merged:
        length = run.end - run.start
        key = run.label
        segments.append(
            KeySegment(
                start_s=round(run.start, 3),
                end_s=round(run.end, 3),
                tonic=None if key is None else key % 12,
                mode=None if key is None else _MODES[key // 12],
                confidence=round(min(max(run.weighted / length, 0.0), 1.0), 3),
            )
        )
    return segments


def extract_key(store: SongStore, song_id: str, report: Report) -> None:
    """Make `key.json` for a song from its instrumental stem.

    Raises KeyEstimationError, reading "<what failed>: <why>", on any failure.
    """
    path = store.stem_path(song_id, "no_vocals")
    if path is None:
        raise KeyEstimationError(
            "Reading the instrumental failed: the song has no instrumental stem"
        )
    started = time.monotonic()
    meta = store.read_meta(song_id)
    gain = meta.stem_gain if meta is not None else 1.0
    samples, rate = _attempt("Reading the instrumental", lambda: _read_mono(path))
    # Back to the song's own level, which the silence floor is measured at.
    samples = (samples / gain).astype(np.float32) if gain > 0 else samples
    report(READ_PROGRESS)
    key = _attempt("Finding the key", lambda: estimate_key(samples, rate, report))
    _attempt("Saving the key", lambda: store.write_key(song_id, key))
    report(1.0)
    clear = [s for s in key.segments if s.tonic is not None]
    logger.info(
        "Keyed song %s (%.0f s): %d segments, %d clear, tuning %+.1f c, in %.1f s",
        song_id,
        len(samples) / rate,
        len(key.segments),
        len(clear),
        key.tuning_cents,
        time.monotonic() - started,
    )


def _attempt(what: str, action: Callable[[], ResultT]) -> ResultT:
    """Run `action`; a failure becomes KeyEstimationError("<what> failed: <why>")."""
    try:
        return action()
    except (StepSkipped, KeyEstimationError):
        raise
    except Exception as exc:
        raise KeyEstimationError(
            f"{what} failed: {str(exc) or type(exc).__name__}"
        ) from exc


def _read_mono(path: Path) -> tuple[Audio, int]:
    """The stem as one channel (the mean of its channels) and its rate."""
    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    if data.shape[0] == 0:
        raise ValueError("the instrumental stem has no samples")
    return np.ascontiguousarray(data.mean(axis=1, dtype=np.float32)), int(rate)
