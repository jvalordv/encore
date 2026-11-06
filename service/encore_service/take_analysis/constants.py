"""The app's numbers, mirrored, and the analysis's own thresholds.

The first block repeats exports of `src/analysis/bleed.ts` and
`src/analysis/mic-level.ts`; `tests/test_take_analysis_constants.py` reads those
files and fails when a value drifts. The second block belongs to this tool:
how a section is judged, written here once so the module docstrings and the
tests point at the same numbers.
"""

# --- mirrored from the app --------------------------------------------------

# Comparable frames needed before any bleed verdict (1.5 s at 10 ms).
BLEED_MIN_FRAMES = 150
# A frame this close to the reference, octave-exact, "matches".
BLEED_MATCH_CENTS = 30
# Share of frames that must match to suspect bleed.
BLEED_MIN_MATCH = 0.6
# Median absolute error, in cents, under which the match is suspiciously tight.
BLEED_MAX_MEDIAN_CENTS = 15
# dB above the noise floor a frame needs to be drawn or scored.
DRAW_MARGIN_DB = 8
# The floor never rises above this.
FLOOR_CEILING_DB = -35
# What a frame of digital silence reads as.
SILENCE_DB = -120

# --- this tool's own --------------------------------------------------------

# Lags scanned between the mic and the reference, in milliseconds.
LAG_RANGE_MS = 400
LAG_STEP_MS = 10
# Comparable frames a lag needs before its share counts.
LAG_MIN_COMPARABLE = 30
# Sub-windows for the steadiness of the lag, and the frames each needs.
LAG_WINDOW_S = 2.5
LAG_WINDOW_MIN_FRAMES = 50
# Sub-window lags within this of the section's lag count as steady.
LAG_STEADY_MS = 30
# The looser match: within this of the reference in any octave.
ANY_OCTAVE_CENTS = 50
# Share of frames that are voiced, clear and over the floor.
SILENCE_MAX_ACTIVE = 0.15
SINGER_MIN_ACTIVE = 0.30
# Used when the file does not record the app's clarity threshold.
DEFAULT_CLARITY = 0.9
# A section shorter than this is left out of the span table.
MIN_SPAN_S = 1.0
# Seconds between frames; a bigger gap breaks a run of frames.
FRAME_S = 0.01
MAX_FRAME_GAP_S = 0.015

# Frames the tracker check needs before a pause, seek or loop cuts it short.
TRACKER_MIN_FRAMES = 200
