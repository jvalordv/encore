"""The command line: `python -m encore_service.take_analysis <take.json> ...`.

Prints the text report on stdout; `--json` also writes the full result. A
problem with the inputs prints one plain line on stderr and exits 1.
"""

import argparse
import sys
from pathlib import Path

from encore_service.take_analysis.analyze import analyse_take
from encore_service.take_analysis.loader import TakeFileError, load_take
from encore_service.take_analysis.processing.tracker import Tracker, crepe_tracker
from encore_service.take_analysis.report import render
from encore_service.take_analysis.sections import SectionError

DEFAULT_WINDOW_S = 5.0


def build_parser() -> argparse.ArgumentParser:
    """The argument parser."""
    p = argparse.ArgumentParser(
        prog="python -m encore_service.take_analysis",
        description="Analyse a take saved by Encore (its JSON, optionally its WAV).",
    )
    p.add_argument("take", type=Path, help="the take's .json export")
    p.add_argument("--wav", type=Path, help="the take's .wav, for level checks")
    p.add_argument(
        "--section",
        action="append",
        default=[],
        metavar="A-B[:silent|:sing]",
        help="seconds of take time (from the first frame); repeat for more",
    )
    p.add_argument(
        "--window",
        type=float,
        default=DEFAULT_WINDOW_S,
        help="window seconds (0 = none)",
    )
    p.add_argument("--json", type=Path, dest="json_out", help="write the full result")
    p.add_argument(
        "--crepe",
        action="store_true",
        help="with --wav, compare the browser's pitch with torchcrepe's",
    )
    return p


def main(argv: list[str] | None = None, tracker: Tracker | None = None) -> int:
    """Run the command; returns the exit code. `tracker` is for tests."""
    args = build_parser().parse_args(argv)
    note: str | None = None
    try:
        take = load_take(args.take)
        if args.wav is not None and not args.wav.is_file():
            raise TakeFileError(f"Cannot read {args.wav}: no such file")
        if args.crepe and args.wav is None:
            raise TakeFileError("--crepe needs --wav.")
        if args.crepe and tracker is None:
            tracker, note = crepe_tracker()
        result = analyse_take(
            take, args.take.name, args.wav, args.section, args.window, tracker, note
        )
    except (TakeFileError, SectionError, RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    sys.stdout.write(render(result))
    if args.json_out is not None:
        args.json_out.write_text(result.model_dump_json(indent=1), encoding="utf-8")
    return 0
