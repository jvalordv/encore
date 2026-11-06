"""Synthetic takes with known answers, written as the app's JSON and a WAV.

A 40 s take, frames from song time 10.0, in three parts (take time):

- 0-10 s, bleed: pitch is the reference 40 ms late with 5 c of noise, quiet:
  30 % of the frames at -49 dB pass the gate, the rest at -56 dB are gated
  `quiet` (and published as f0 = 0, as speaker mode does).
- 10-30 s, singer: the reference with a lag drifting from 0 to 100 ms and 30 c
  of noise, loud (-25 dB); 10 % of the frames have clarity 0.75 (gated
  `unclear`) and 5 % are at -58 dB (gated `quiet`).
- 30-40 s, silence: -100 dB, unvoiced, with 10 % junk frames of clarity 0.3.

The floor is -60 dB throughout. The app's bleed state says `ok` for the first
2 s, `suspected` to 10 s, and `suspected` again from 14 to 16 s.
"""

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 16_000
FRAMES = 4000
FIRST_T = 10.0
LATENCY_S = 0.1
FLOOR_DB = -60.0
CLARITY = 0.9
REF_T0 = 5.0
BLEED_LAG_S = 0.04


def ref_hz(song_t: np.ndarray) -> np.ndarray:
    """The synthetic melody: always moving, so every lag shows."""
    cents = 300 * np.sin(2 * np.pi * song_t / 3) + 100 * np.sin(
        2 * np.pi * song_t / 0.7
    )
    return 220.0 * 2 ** (cents / 1200)


@dataclass
class Synth:
    """The files and the truth behind them."""

    json_path: Path
    wav_path: Path
    pitch: np.ndarray
    clean: np.ndarray


def _frames(rng: np.random.Generator, copies: int) -> dict[str, np.ndarray]:
    n = FRAMES * copies
    tau_all = np.arange(n) * 0.01
    t = FIRST_T + tau_all
    # The 40 s pattern repeats, so a long take has the same parts over and over.
    tau = tau_all % 40.0
    pitch = np.zeros(n)
    clean = np.zeros(n)
    level = np.full(n, -100.0)
    clarity = np.full(n, 0.95)
    bleed, singer = tau < 10, (tau >= 10) & (tau < 30)
    clean[bleed] = ref_hz(t[bleed] - BLEED_LAG_S)
    pitch[bleed] = clean[bleed] * 2 ** (rng.normal(0, 5, bleed.sum()) / 1200)
    level[bleed] = np.where(rng.random(bleed.sum()) < 0.3, -49.0, -56.0)
    lag = 0.1 * (tau - 10) / 20
    clean[singer] = ref_hz(t[singer] - lag[singer])
    pitch[singer] = clean[singer] * 2 ** (rng.normal(0, 30, singer.sum()) / 1200)
    level[singer] = -25.0
    draw = rng.random(n)
    unclear = singer & (draw < 0.10)
    quiet = singer & (draw >= 0.10) & (draw < 0.15)
    clarity[unclear] = 0.75
    level[quiet] = -58.0
    silent = tau >= 30
    junk = silent & (draw < 0.10)
    pitch[junk] = rng.uniform(100, 400, junk.sum())
    clarity[junk] = 0.3
    return {"t": t, "pitch": pitch, "clean": clean, "level": level, "clarity": clarity}


def _gate(pitch: float, clarity: float, level: float) -> str | None:
    if not pitch > 0:
        return "unvoiced"
    if clarity < CLARITY:
        return "unclear"
    return None if level >= FLOOR_DB + 8 else "quiet"


def build_take(
    folder: Path,
    *,
    version: int = 2,
    reference: bool = True,
    wav_seconds: float | None = None,
    name: str = "take",
    copies: int = 1,
    sections: bool = False,
    tuning: dict[str, float] | None = None,
    kind: str | None = None,
) -> Synth:
    """Write `<name>.json` and `<name>.wav` into `folder`.

    `copies` repeats the 40 s pattern back to back for a long take. From
    version 3, `sections` labels the three parts the way a Mic check does
    (`speakers`, `sing-along`, `quiet`), `tuning` records the values in force
    and `kind` sets `take.kind`.
    """
    rng = np.random.default_rng(7)
    f = _frames(rng, copies)
    seconds_total = 40.0 * copies
    frames = []
    for i in range(FRAMES * copies):
        p, c, lv = float(f["pitch"][i]), float(f["clarity"][i]), float(f["level"][i])
        gate = _gate(p, c, lv)
        published = 0.0 if gate else p
        row: dict[str, object] = {
            "t": round(float(f["t"][i]), 4),
            "f0": published,
            "clarity": c,
            "rms": 10 ** (lv / 20),
        }
        if version >= 2:
            if p != published:
                row["rawF0"] = p
            if gate:
                row["gate"] = gate
        elif gate == "unvoiced":
            row["f0"] = 0.0
        frames.append(row)
    doc: dict[str, object] = {
        "format": "encore-take",
        "version": version,
        "take": {
            "id": "synthetic",
            "songName": "Synthetic",
            "songHash": "abc",
            "createdAt": "2026-11-05T12:00:00.000Z",
            "durationS": seconds_total,
            "latencyS": LATENCY_S,
            "sampleRate": RATE,
            "startedAtSongS": FIRST_T + LATENCY_S,
            "clock": "engine",
        },
        "mic": {
            "inputLabel": "Test mic",
            "monitor": "off",
            "processing": {"aec": True, "ns": False, "agc": False},
            "requestedAec": True,
            "clarityThreshold": CLARITY,
            "latencyS": LATENCY_S,
            "embedOffsetS": 0,
            "outputLabel": "Speakers",
            "mix": {"choice": "original", "guideLevel": 0},
            "source": {"kind": "file", "name": "x.mp3"},
            "noiseFloorDb": FLOOR_DB,
        },
        "report": None,
        "frames": frames,
    }
    if kind is not None:
        doc["take"]["kind"] = kind  # type: ignore[index]
    if version >= 2:
        tau = np.arange(0, seconds_total, 0.25)
        phase = tau % 40.0
        suspected = ((phase >= 2) & (phase < 10)) | ((phase >= 14) & (phase < 16))
        trace: dict[str, object] = {
            "health": [
                {
                    "t": FIRST_T + float(s),
                    "floorDb": FLOOR_DB,
                    "micState": "hearing",
                    "bleed": "suspected" if bad else "ok",
                }
                for s, bad in zip(tau, suspected, strict=True)
            ],
            "events": [
                {"at": 10.0, "songT": 20.0, "kind": "mix", "value": "karaoke"},
                {"at": 10.5, "songT": 20.5, "kind": "latency", "value": 0.1},
            ],
            "environment": {
                "appVersion": "test",
                "userAgent": "pytest",
                "skin": "plain",
                "trackSettings": {"echoCancellation": True},
                "audio": {
                    "sampleRate": RATE,
                    "baseLatencyS": 0.01,
                    "outputLatencyS": 0.04,
                },
                "analysis": {
                    "clarityThreshold": CLARITY,
                    "octaveInvariant": False,
                    "scoring": "off",
                    "mode": "karaoke",
                },
            },
            "calibration": {
                "delayS": LATENCY_S,
                "confidence": 0.9,
                "spreadS": 0.004,
                "trials": [],
            },
        }
        if reference:
            times = REF_T0 + np.arange(FRAMES * copies + 1000) * 0.01
            trace["reference"] = {
                "hopS": 0.01,
                "t0S": REF_T0,
                "f0Hz": [round(float(v), 2) for v in ref_hz(times)],
            }
        if sections:
            trace["sections"] = [
                {"label": label, "kind": k, "startS": FIRST_T + a, "endS": FIRST_T + b}
                for label, k, a, b in (
                    ("speakers", "silent", 0.0, 10.0),
                    ("sing-along", "sing", 10.0, 30.0),
                    ("quiet", "silent", 30.0, 40.0),
                )
            ]
        if tuning is not None:
            trace["environment"]["tuning"] = tuning  # type: ignore[index]
        doc["trace"] = trace
    json_path = folder / f"{name}.json"
    json_path.write_text(json.dumps(doc), encoding="utf-8")
    seconds = np.arange(int((wav_seconds or seconds_total) * RATE)) / RATE
    wav_path = folder / f"{name}.wav"
    sf.write(wav_path, 0.5 * np.sin(2 * np.pi * 220 * seconds), RATE, subtype="PCM_16")
    return Synth(json_path, wav_path, f["pitch"], f["clean"])


def standin_tracker(synth: Synth):  # noqa: ANN201
    """A tracker that knows the truth: noise-free pitch, an octave slip every 20th."""

    def run(samples: np.ndarray, rate: int) -> np.ndarray:
        out = synth.clean.copy()
        out[::20] *= 2
        return out

    return run
