"""Exceptions a step runner raises to steer how its step ends.

They live in a module of their own because `pipeline.py` imports every runner
to register it, so a runner that imported `pipeline.py` back to raise one would
make the two import each other. `pipeline.py` re-exports them, and that is the
name the rest of the service and the tests use.
"""


class StepSkipped(Exception):
    """A runner's way to say it has nothing to do, or cannot do it here.

    The step ends `skipped`, with `reason` as the detail the browser shows,
    instead of `failed`, and the steps that need it skip too ("Needs <step>").
    Adding the song again tries the step afresh, so a reason that names a fix
    (an extra to install, say) works once the fix is made.
    """

    def __init__(self, reason: str) -> None:
        if not reason.strip():
            # The reason is all the person sees, so a skip without one is a
            # mistake in the runner, not something to show.
            raise ValueError("A skipped step must say why")
        super().__init__(reason)
        self.reason = reason
