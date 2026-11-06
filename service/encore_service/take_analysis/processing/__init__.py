"""The Processing part of a take analysis: feedback for development.

Not a report card for the singer. It audits the app's own decisions (gate and
bleed state) against the raw frames, compares the browser's pitch tracker with
the service's, checks the latency, sweeps what-if settings and ends with
measured findings. `run.run_processing` is the entry point; this file imports
nothing so the result models can load without the analysis code.
"""
