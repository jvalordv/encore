"""The take analysis command on synthetic takes with known answers.

`take_factory` writes a 40 s take: bleed 0-10 s, a singer 10-30 s, silence
30-40 s. The sections, verdicts, version 1 and no-reference files, the
errors and the command end to end are checked here; the Processing part is in
`test_take_processing.py`.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from encore_service.take_analysis.analyze import analyse_take
from encore_service.take_analysis.cli import main
from encore_service.take_analysis.loader import TakeFileError, load_take
from encore_service.take_analysis.results import TakeAnalysis
from encore_service.take_analysis.sections import SectionError
from tests.take_factory import FIRST_T, build_take

MARKS = ["0-10", "10-30", "30-40"]


def analyse(path: Path, marks: list[str] | None = None, **kw) -> TakeAnalysis:  # type: ignore[no-untyped-def]
    return analyse_take(load_take(path), path.name, marks=marks or MARKS, **kw)


def marked(result: TakeAnalysis) -> dict[str, object]:
    return {s.label: s for s in result.sections if s.kind == "marked"}


def test_bleed_section_is_found_with_its_lag(tmp_path: Path) -> None:
    sec = marked(analyse(build_take(tmp_path).json_path))["0-10"]
    assert sec.verdict == "likely bleed"
    assert sec.match is not None
    assert 30 <= sec.match.lag_ms <= 50
    assert sec.match.share_exact > 0.9
    assert sec.match.lag_steady is True
    # Frames are 0.01 s apart from song time 10.0; song time is printed too.
    assert sec.song_start_s == pytest.approx(FIRST_T)
    assert sec.gate_reasons == {"quiet": pytest.approx(700, abs=60)}


def test_singer_section_is_looser_and_drifting(tmp_path: Path) -> None:
    sec = marked(analyse(build_take(tmp_path).json_path))["10-30"]
    assert sec.verdict == "singer"
    assert sec.match is not None
    assert sec.match.lag_steady is False
    assert sec.match.median_abs_cents > 15
    assert sec.active_share is not None and sec.active_share > 0.8


def test_silent_section_is_silence(tmp_path: Path) -> None:
    sec = marked(analyse(build_take(tmp_path).json_path))["30-40"]
    assert sec.verdict == "silence"
    assert sec.active_share is not None and sec.active_share < 0.05
    assert sec.level_median_db == pytest.approx(-100, abs=0.5)


def test_headline_names_the_speakers(tmp_path: Path) -> None:
    result = analyse(build_take(tmp_path).json_path)
    assert "the speakers reached the mic" in result.headline[0]
    assert "within 30 c" in result.headline[0]
    assert result.sections[0].kind == "marked"


def test_windows_and_event_spans(tmp_path: Path) -> None:
    result = analyse(build_take(tmp_path).json_path, window_s=5.0)
    kinds = [s.kind for s in result.sections]
    assert kinds.count("window") == 8
    spans = [s for s in result.sections if s.kind == "span"]
    # The mix event at transport 20 s is song 19.9 s once the 0.1 s latency is
    # taken off, which is take 9.9 s; the latency event is no boundary.
    assert [s.label for s in spans] == ["after start", "after mix=karaoke"]
    assert spans[1].take_start_s == pytest.approx(9.9)


def test_environment_and_wav(tmp_path: Path) -> None:
    synth = build_take(tmp_path)
    result = analyse(synth.json_path, wav=synth.wav_path)
    env = result.environment
    assert (env.aec, env.ns, env.agc) == (True, False, False)
    assert env.calibration_confidence == pytest.approx(0.9)
    assert result.wav is not None
    assert result.wav.peak_db == pytest.approx(-6.0, abs=0.1)
    assert result.wav.clipped_samples == 0
    assert result.wav.problems == []


def test_wav_that_does_not_match_the_json_is_flagged(tmp_path: Path) -> None:
    synth = build_take(tmp_path, wav_seconds=30.0)
    result = analyse(synth.json_path, wav=synth.wav_path)
    assert result.wav is not None
    assert any("length" in p for p in result.wav.problems)


def test_version_1_says_what_it_cannot_give(tmp_path: Path) -> None:
    result = analyse(build_take(tmp_path, version=1).json_path)
    assert result.version == 1
    text = " ".join(result.missing)
    assert "no trace" in text and "no per-frame gate" in text
    sec = marked(result)["10-30"]
    assert sec.gate_pass_share is None and sec.match is None
    assert sec.verdict == "unclear"
    assert "cannot tell bleed from singing" in sec.reason
    assert marked(result)["30-40"].verdict == "silence"
    assert not result.processing.audit.available
    # The floor falls back to the mic's starting one.
    assert sec.floor_db == pytest.approx(-60)


def test_without_a_reference_the_verdict_uses_level_only(tmp_path: Path) -> None:
    result = analyse(build_take(tmp_path, reference=False).json_path)
    assert any("no reference melody" in m for m in result.missing)
    sec = marked(result)["10-30"]
    assert sec.match is None and sec.verdict == "unclear"
    assert "cannot tell bleed from singing" in sec.reason
    assert marked(result)["30-40"].verdict == "silence"


def test_bad_inputs_are_plain_errors(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{nope", encoding="utf-8")
    with pytest.raises(TakeFileError, match="not valid JSON"):
        load_take(bad)
    future = tmp_path / "future.json"
    future.write_text(json.dumps({"format": "encore-take", "version": 9}))
    with pytest.raises(TakeFileError, match="version 9"):
        load_take(future)
    with pytest.raises(SectionError):
        analyse(build_take(tmp_path).json_path, marks=["ten-twenty"])
    with pytest.raises(SectionError):
        analyse(build_take(tmp_path).json_path, marks=["10-5"])


def test_command_end_to_end(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    synth = build_take(tmp_path)
    out = tmp_path / "out.json"
    code = main(
        [str(synth.json_path), "--wav", str(synth.wav_path), "--section", "0-10",
         "--section", "30-40", "--json", str(out)]
    )  # fmt: skip
    text = capsys.readouterr().out
    assert code == 0
    lines = text.splitlines()
    assert len(lines) <= 90
    assert "the speakers reached the mic" in text
    assert "Findings" in text
    assert all(ord(ch) < 128 for ch in text)
    result = TakeAnalysis.model_validate_json(out.read_text(encoding="utf-8"))
    assert result.processing.findings
    assert len([s for s in result.sections if s.kind == "marked"]) == 2


def test_command_errors_print_one_line_and_fail(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main([str(tmp_path / "missing.json")]) == 1
    err = capsys.readouterr().err
    assert len(err.strip().splitlines()) == 1
    synth = build_take(tmp_path)
    assert main([str(synth.json_path), "--section", "9-3"]) == 1
    assert main([str(synth.json_path), "--crepe"]) == 1


def test_module_entry_point(tmp_path: Path) -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "encore_service.take_analysis",
            str(tmp_path / "x.json"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert len(proc.stderr.strip().splitlines()) == 1


def test_five_minute_take_analyses_quickly(tmp_path: Path) -> None:
    synth = build_take(tmp_path, copies=8)
    take = load_take(synth.json_path)
    started = time.perf_counter()
    result = analyse_take(take, "long.json", window_s=5.0)
    elapsed = time.perf_counter() - started
    assert len(take.frames) == 32_000
    assert sum(s.kind == "window" for s in result.sections) == 64
    # About 2 s on a laptop; the bound is loose so only a regression to
    # converting the reference on every call (20 s) trips it.
    assert elapsed < 10.0
