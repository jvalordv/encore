"""The Processing part: audit, sweep, latency and tracker check.

Uses the synthetic take of `take_factory`. The tracker check runs on a
stand-in tracker, so nothing here needs torchcrepe.
"""

import importlib.util
import json
from pathlib import Path

import pytest

from encore_service.take_analysis.analyze import analyse_take
from encore_service.take_analysis.cli import main
from encore_service.take_analysis.loader import load_take
from encore_service.take_analysis.processing.models import BleedSetting
from encore_service.take_analysis.processing.sweep import pick_best_bleed
from encore_service.take_analysis.processing.tracker import crepe_tracker
from encore_service.take_analysis.results import TakeAnalysis
from tests.take_factory import Synth, build_take, standin_tracker

MARKS = ["0-10:silent", "10-30:sing", "30-40:silent"]


def run(synth: Synth, marks: list[str] | None = MARKS, **kw) -> TakeAnalysis:  # type: ignore[no-untyped-def]
    take = load_take(synth.json_path)
    return analyse_take(take, "t.json", marks=marks, **kw)


def test_audit_counts(tmp_path: Path) -> None:
    audit = run(build_take(tmp_path)).processing.audit
    assert audit.available and audit.basis == "marked sections"
    rows = {r.label: r for r in audit.rows}
    # About 30 % of the 1000 bleed frames are loud enough to pass the gate.
    assert rows["0-10"].leaked == pytest.approx(300, abs=50)
    assert rows["30-40"].leaked == 0
    assert audit.leaked == rows["0-10"].leaked
    # 10 % unclear and 5 % quiet of 2000 singing frames were gated.
    assert audit.gated_in_singing == pytest.approx(300, abs=50)
    assert 20 < audit.too_strict <= audit.gated_in_singing
    # The app said ok for 2 s of bleed and suspected for 2 s of singing.
    assert audit.bleed_disagree == pytest.approx(400, abs=30)
    assert audit.bleed_compared > 3000


def test_sweep_picks_the_margin_that_separates_silent_from_singing(
    tmp_path: Path,
) -> None:
    sweep = run(build_take(tmp_path)).processing.sweep
    assert sweep.current is not None and sweep.current.draw_margin_db == 8
    best = sweep.best_gate
    assert best is not None
    # The leaking frames sit 11 dB over the floor: 12 dB is the first margin
    # that drops them, and the singing frames, 35 dB over, all stay.
    assert best.draw_margin_db == 12
    assert best.silent_dropped == pytest.approx(1.0)
    assert best.singing_kept == pytest.approx(1.0)
    assert best.clarity == 0.9 and best.ceiling_db == -35
    assert sweep.best_bleed is not None and sweep.best_bleed.singing_flagged == 0


def test_sweep_without_marks_only_counts_changes(tmp_path: Path) -> None:
    sweep = run(build_take(tmp_path), marks=None).processing.sweep
    assert sweep.best_gate is None
    assert sweep.note is not None and "no sections marked" in sweep.note
    assert sweep.current is not None and sweep.current.changed == 0
    stricter = [r for r in sweep.gate if r.draw_margin_db == 16 and r.clarity == 0.9]
    assert stricter[0].changed > 0


def test_latency_correction_from_the_bleed_lag(tmp_path: Path) -> None:
    lat = run(build_take(tmp_path)).processing.latency
    assert lat.bleed_sections == 1
    assert lat.bleed_lag_ms is not None and 30 <= lat.bleed_lag_ms <= 50
    assert lat.take_latency_s == pytest.approx(0.1)
    assert lat.calibration_delay_s == pytest.approx(0.1)
    assert lat.implied_latency_s == pytest.approx(0.14, abs=0.011)
    assert lat.basis is not None and "bleed" in lat.basis


def test_latency_without_data_says_so(tmp_path: Path) -> None:
    result = run(build_take(tmp_path, reference=False))
    assert result.processing.latency.note is not None
    assert "not enough data" in result.processing.latency.note
    assert any("not enough data" in f for f in result.processing.findings)


def test_tracker_comparison_with_a_stand_in(tmp_path: Path) -> None:
    synth = build_take(tmp_path)
    result = run(synth, wav=synth.wav_path, tracker=standin_tracker(synth))
    t = result.processing.tracker
    assert t.available and t.frames_compared == 4000
    # The stand-in says unvoiced for the 100 junk frames of the silent part.
    assert t.voicing_agreement == pytest.approx(0.975, abs=0.01)
    # Every 20th frame is an octave slip.
    assert t.octave_error_share == pytest.approx(0.05, abs=0.01)
    assert t.median_cents_diff is not None and abs(t.median_cents_diff) < 5
    assert t.jitter_samples > 500
    assert t.jitter_browser_cents is not None and t.jitter_tracker_cents is not None
    assert t.jitter_browser_cents > t.jitter_tracker_cents
    assert any(
        f.startswith("Tracker check: voicing agrees")
        for f in result.processing.findings
    )


def test_tracker_is_skipped_without_one(tmp_path: Path) -> None:
    result = run(build_take(tmp_path))
    assert not result.processing.tracker.available
    assert any(f.startswith("Tracker check:") for f in result.processing.findings)


def test_crepe_flag_with_an_injected_tracker(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    synth = build_take(tmp_path)
    code = main(
        [
            str(synth.json_path),
            "--wav",
            str(synth.wav_path),
            "--crepe",
            "--section",
            "0-10",
        ],
        tracker=standin_tracker(synth),
    )
    assert code == 0
    assert "octave errors" in capsys.readouterr().out


@pytest.mark.skipif(
    importlib.util.find_spec("torchcrepe") is not None, reason="torchcrepe is installed"
)
def test_missing_torchcrepe_is_one_line() -> None:
    tracker, note = crepe_tracker()
    assert tracker is None
    assert note is not None and "\n" not in note and "torchcrepe" in note


def test_findings_name_constants_and_numbers(tmp_path: Path) -> None:
    findings = run(build_take(tmp_path)).processing.findings
    text = "\n".join(findings)
    assert "DRAW_MARGIN_DB 8 -> 12" in text
    assert "Gate leaked" in text and "Latency:" in text


def _bleed_row(sing: int, silent: int, flips: int) -> BleedSetting:
    return BleedSetting(
        match_cents=30,
        min_match=0.6,
        max_median_cents=20,
        bleed_sections=sing + silent,
        silent_flagged=silent,
        singing_flagged=sing,
        flips=flips,
    )


def test_bleed_pick_keeps_flagging_the_bleed_section() -> None:
    rows = [
        _bleed_row(sing=1, silent=1, flips=0),  # the app's rule: a false alarm
        _bleed_row(sing=0, silent=0, flips=1),  # too strict: loses the bleed
        _bleed_row(sing=0, silent=1, flips=3),  # no false alarm, bleed kept
    ]
    best = pick_best_bleed(rows)
    assert (best.singing_flagged, best.silent_flagged) == (0, 1)


def test_bleed_sweep_on_a_take_reports_silent_flags(tmp_path: Path) -> None:
    result = run(build_take(tmp_path))
    best = result.processing.sweep.best_bleed
    assert best is not None and best.silent_flagged >= 1


def test_tracker_stops_at_a_pause(tmp_path: Path) -> None:
    synth = build_take(tmp_path)
    doc = json.loads(synth.json_path.read_text(encoding="utf-8"))
    doc["trace"]["events"].append(
        {"at": 20.0, "songT": 30.0, "kind": "player", "value": "paused"}
    )
    synth.json_path.write_text(json.dumps(doc), encoding="utf-8")
    result = run(synth, wav=synth.wav_path, tracker=standin_tracker(synth))
    t = result.processing.tracker
    # Transport 30 s is song 29.9 s: the frames from 10.0 to 29.9 s.
    assert t.available and t.frames_compared == pytest.approx(1990, abs=2)
    assert t.note is not None and "player paused" in t.note
    assert any("player paused" in f for f in result.processing.findings)


def test_tracker_skips_when_a_pause_leaves_too_few_frames(tmp_path: Path) -> None:
    synth = build_take(tmp_path)
    doc = json.loads(synth.json_path.read_text(encoding="utf-8"))
    doc["trace"]["events"].append(
        {"at": 1.0, "songT": 10.5, "kind": "seek", "value": 60.0}
    )
    synth.json_path.write_text(json.dumps(doc), encoding="utf-8")
    result = run(synth, wav=synth.wav_path, tracker=standin_tracker(synth))
    t = result.processing.tracker
    assert not t.available and t.note is not None and "seek" in t.note
