"""Analysis of a take saved by the browser app (its JSON and optional WAV).

Run `uv run python -m encore_service.take_analysis <take.json> [--wav ...]`.
`loader` reads the export (`schema`), `frames` puts it on one time base,
`sections` and `measure` give each stretch its numbers and verdict (`match` is
the lag and pitch comparison), `environment` the settings and WAV check,
`processing/` the development feedback, `report` the text, `cli` the command.
This file imports nothing so each module loads alone.
"""
