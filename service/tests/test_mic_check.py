"""The Mic check: v3 takes, trace sections, the endpoint and the advice.

Uses `take_factory`'s 40 s take: bleed 0-10 s (labelled `speakers`, silent,
quiet enough to pass the gate on 30 % of frames at -49 dB), a singer 10-30 s
(`sing-along`, sing) and silence 30-40 s (`quiet`, silent).
"""

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from encore_service.app import create_app
from encore_service.routes import takes as takes_route
from encore_service.take_analysis.analyze import analyse_take
from encore_service.take_analysis.cli import main
from encore_service.take_analysis.loader import TakeFileError, load_take
from encore_service.take_analysis.mic_check import (
    BOUNDS,
    MicCheckAnalysis,
    build_mic_check,
)
from encore_service.take_analysis.results import TakeAnalysis
from tests.take_factory import FIRST_T, build_take

CURRENT = {
    "drawMarginDb": 8,
    "clarityThreshold": 0.9,
    "bleedMatchCents": 30,
    "bleedMinMatch": 0.6,
    "bleedMaxMedianCents": 15,
}


def check(tmp_path: Path, **kw: Any) -> MicCheckAnalysis:
    synth = build_take(tmp_path, version=3, sections=True, **kw)
    take = load_take(synth.json_path)
    return build_mic_check(take, analyse_take(take, "t.json", window_s=0))


def test_v3_loads_sections_tuning_and_kind(tmp_path: Path) -> None:
    synth = build_take(
        tmp_path, version=3, sections=True, tuning=CURRENT, kind="mic-check"
    )
    take = load_take(synth.json_path)
    assert take.take.kind == "mic-check"
    assert take.version == 3
    assert take.trace is not None
    assert [s.label for s in take.trace.sections] == ["speakers", "sing-along", "quiet"]
    assert take.trace.sections[0].startS == FIRST_T
    assert take.trace.environment.tuning is not None
    assert take.trace.environment.tuning.drawMarginDb == 8


def test_older_versions_still_load_with_defaults(tmp_path: Path) -> None:
    take = load_take(build_take(tmp_path, version=2).json_path)
    assert take.take.kind == "song"
    assert take.trace is not None and take.trace.sections == []


def test_version_4_is_refused(tmp_path: Path) -> None:
    path = build_take(tmp_path, version=3).json_path
    doc = json.loads(path.read_text())
    doc["version"] = 4
    path.write_text(json.dumps(doc))
    with pytest.raises(TakeFileError, match="versions 1 to 3"):
        load_take(path)


def test_cli_uses_the_trace_sections(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    synth = build_take(tmp_path, version=3, sections=True)
    out_json = tmp_path / "out.json"
    code = main([str(synth.json_path), "--window", "0", "--json", str(out_json)])
    assert code == 0
    result = TakeAnalysis.model_validate_json(out_json.read_text())
    marked = [s for s in result.sections if s.kind == "marked"]
    assert [(s.mark, s.verdict) for s in marked] == [
        ("silent", "likely bleed"),
        ("sing", "singer"),
        ("silent", "silence"),
    ]
    assert marked[1].take_start_s == pytest.approx(10.0)
    assert "likely bleed" in capsys.readouterr().out


def test_explicit_section_beats_the_trace(tmp_path: Path) -> None:
    synth = build_take(tmp_path, version=3, sections=True)
    result = analyse_take(
        load_take(synth.json_path), "t.json", marks=["0-10"], window_s=0
    )
    assert [s.label for s in result.sections if s.kind == "marked"] == ["0-10"]


def test_bleed_case_raises_the_draw_margin(tmp_path: Path) -> None:
    out = check(tmp_path)
    assert out.current.draw_margin_db == 8
    assert out.current.latency_s == pytest.approx(0.1)
    assert out.recommended.draw_margin_db is not None
    assert out.recommended.draw_margin_db > 8
    assert [(s.label, s.verdict) for s in out.sections] == [
        ("speakers", "likely_bleed"),
        ("sing-along", "singer"),
        ("quiet", "silence"),
    ]
    assert out.report_text and out.findings


def test_latency_comes_from_the_speakers_section(tmp_path: Path) -> None:
    out = check(tmp_path)
    # Bleed lags 40 ms, so the latency that lines it up is 0.1 + 0.04.
    assert out.recommended.latency_s == pytest.approx(0.14, abs=0.011)


def test_current_is_taken_from_the_tuning(tmp_path: Path) -> None:
    out = check(tmp_path, tuning={**CURRENT, "drawMarginDb": 12})
    assert out.current.draw_margin_db == 12
    # At 12 dB the bleed frames (-49 dB over a -60 dB floor) already drop.
    assert out.recommended.draw_margin_db is None


def test_no_sections_means_no_advice(tmp_path: Path) -> None:
    take = load_take(build_take(tmp_path, version=3).json_path)
    out = build_mic_check(take, analyse_take(take, "t.json"))
    assert out.sections == []
    assert set(out.recommended.model_dump().values()) == {None}
    assert any("no labelled sections" in n for n in out.notes)


def test_not_enough_sung_frames_is_none_with_a_note(tmp_path: Path) -> None:
    synth = build_take(tmp_path, version=3, sections=True)
    doc = json.loads(synth.json_path.read_text())
    # Only half a second of singing is labelled.
    doc["trace"]["sections"][1]["endS"] = FIRST_T + 10.5
    synth.json_path.write_text(json.dumps(doc))
    take = load_take(synth.json_path)
    out = build_mic_check(take, analyse_take(take, "t.json", window_s=0))
    assert out.recommended.draw_margin_db is None
    assert any(n.startswith("Gate: not enough data") for n in out.notes)


def test_advice_stays_inside_the_bounds(tmp_path: Path) -> None:
    out = check(tmp_path, tuning={**CURRENT, "drawMarginDb": 2})
    low, high = BOUNDS["draw_margin_db"]
    value = out.recommended.draw_margin_db
    assert value is None or low <= value <= high


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def post(client: TestClient, path: Path, wav: Path | None = None, **form: str) -> Any:
    files = {"take": ("take.json", path.read_bytes(), "application/json")}
    if wav is not None:
        files["wav"] = ("take.wav", wav.read_bytes(), "audio/wav")
    return client.post("/takes/analyse", files=files, data=form)


def test_endpoint_json_only(client: TestClient, tmp_path: Path) -> None:
    synth = build_take(tmp_path, version=3, sections=True)
    res = post(client, synth.json_path)
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {
        "report_text",
        "findings",
        "sections",
        "current",
        "recommended",
        "notes",
    }
    assert body["recommended"]["draw_margin_db"] > 8
    assert body["sections"][0]["verdict"] == "likely_bleed"
    assert any("needs the WAV" in n for n in body["notes"])


def test_endpoint_with_wav_and_missing_crepe(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        takes_route, "crepe_tracker", lambda: (None, "torchcrepe is not available")
    )
    synth = build_take(tmp_path, version=3, sections=True)
    res = post(client, synth.json_path, synth.wav_path)
    assert res.status_code == 200
    assert "torchcrepe is not available" in res.json()["notes"]


def test_endpoint_crepe_false_never_loads_it(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom() -> None:
        raise AssertionError("crepe must not load")

    monkeypatch.setattr(takes_route, "crepe_tracker", boom)
    synth = build_take(tmp_path, version=3, sections=True)
    res = post(client, synth.json_path, synth.wav_path, crepe="false")
    assert res.status_code == 200


def test_endpoint_rejects_bad_files(client: TestClient, tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    res = post(client, bad)
    assert res.status_code == 422
    assert "not valid JSON" in res.json()["detail"]
    bad.write_text(json.dumps({"format": "encore-take", "version": 9}))
    res = post(client, bad)
    assert res.status_code == 422
    assert "version 9" in res.json()["detail"]


def test_endpoint_rejects_a_bad_wav(client: TestClient, tmp_path: Path) -> None:
    synth = build_take(tmp_path, version=3, sections=True)
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio")
    res = post(client, synth.json_path, junk, crepe="false")
    assert res.status_code == 422
