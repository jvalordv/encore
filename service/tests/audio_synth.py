"""Synthetic songs for the alignment tests: chord progressions and a vocal."""

import numpy as np
from numpy.typing import NDArray

RATE = 22_050

# Four chords as semitones above A3 (220 Hz): Am, F, C, G.
PROGRESSION = [(0, 3, 7), (-4, 0, 3), (3, 7, 10), (-2, 2, 5)]
OTHER_PROGRESSION = [(1, 5, 8), (6, 10, 13), (-1, 3, 6), (4, 8, 11)]


def render(
    chords: list[tuple[int, ...]],
    bars: int = 12,
    bar_s: float = 2.0,
    transpose: int = 0,
    stretch: float = 1.0,
    vocal: bool = False,
) -> NDArray[np.float32]:
    """Chords with a few harmonics each, one per bar, cycled.

    `stretch` multiplies every duration (1.05 is five per cent slower);
    `vocal` adds a sine line that wanders over the scale.
    """
    out: list[NDArray[np.float64]] = []
    for bar in range(bars):
        n = int(bar_s * stretch * RATE)
        t = np.arange(n) / RATE
        chord = chords[bar % len(chords)]
        bar_audio = np.zeros(n)
        for semitone in chord:
            f = 220.0 * 2 ** ((semitone + transpose) / 12)
            for h, gain in ((1, 1.0), (2, 0.5), (3, 0.3)):
                bar_audio += gain * np.sin(2 * np.pi * f * h * t)
        envelope = np.minimum(1.0, np.minimum(t, n / RATE - t) * 20)
        out.append(0.1 * bar_audio * envelope)
    audio = np.concatenate(out)
    if vocal:
        t = np.arange(len(audio)) / RATE
        steps = np.floor(t / 0.5).astype(int)
        scale = np.array([0, 2, 3, 5, 7, 8, 10, 12])
        f = 440.0 * 2 ** (scale[(steps * 3) % len(scale)] / 12)
        audio = audio + 0.15 * np.sin(2 * np.pi * np.cumsum(f) / RATE)
    return audio.astype(np.float32)


# The triads of A minor / C major, as semitones above A3: Am, Bdim, C, Dm, Em,
# F, G. A different song in the same key draws its chords from these.
DIATONIC = [
    (0, 3, 7),
    (2, 5, 8),
    (3, 7, 10),
    (5, 8, 12),
    (7, 10, 14),
    (-4, 0, 3),
    (-2, 2, 5),
]


def random_song(
    seed: int,
    bars: int = 48,
    bar_s: float = 0.5,
    pool: list[tuple[int, ...]] | None = None,
    notes: int = 4,
) -> NDArray[np.float32]:
    """A dense song of one random chord per bar, never repeating a cycle.

    With a `pool` the chords are drawn from it (a song in one key); without,
    each chord is `notes` random pitches over two octaves, so the song visits
    every pitch class and has no key.
    """
    rng = np.random.default_rng(seed)
    chords: list[tuple[int, ...]] = []
    for _ in range(bars):
        if pool is not None:
            chords.append(pool[int(rng.integers(len(pool)))])
        else:
            picks = rng.choice(np.arange(-12, 14), size=notes, replace=False)
            chords.append(tuple(int(p) for p in picks))
    return render(chords, bars=bars, bar_s=bar_s)
