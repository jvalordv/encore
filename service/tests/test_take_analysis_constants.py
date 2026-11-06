"""The Python copies of the app's constants match the TypeScript source.

Reads `src/analysis/bleed.ts` and `src/analysis/mic-level.ts` from the repo
root and fails when a mirrored value drifts, so the analysis cannot go on
judging by numbers the app no longer uses.
"""

import re
from pathlib import Path

import pytest

from encore_service.take_analysis import constants

ROOT = Path(__file__).resolve().parents[2]

MIRRORED = {
    "src/analysis/bleed.ts": [
        "BLEED_MIN_FRAMES",
        "BLEED_MATCH_CENTS",
        "BLEED_MIN_MATCH",
        "BLEED_MAX_MEDIAN_CENTS",
    ],
    "src/analysis/mic-level.ts": ["DRAW_MARGIN_DB", "FLOOR_CEILING_DB", "SILENCE_DB"],
}


def ts_value(source: str, name: str) -> float:
    found = re.search(rf"export const {name}\s*=\s*(-?\d+(?:\.\d+)?)\s*;", source)
    assert found, f"{name} is no longer an exported numeric constant"
    return float(found.group(1))


@pytest.mark.parametrize("path", sorted(MIRRORED))
def test_mirrored_constants_match_the_app(path: str) -> None:
    file = ROOT / path
    if not file.is_file():
        pytest.skip("the front end is not next to the service")
    source = file.read_text(encoding="utf-8")
    for name in MIRRORED[path]:
        assert getattr(constants, name) == ts_value(source, name), name
