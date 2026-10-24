"""FastAPI application factory for the encore service.

`create_app` wires CORS from the settings (and lets a page read the one custom
header the service sends, the stem gain), mounts every router and gives the
app a lifespan that owns the song store and the job queue; `app` is the
instance uvicorn serves (`encore_service.app:app`). On start the lifespan also
settles what the last run left behind: interrupted steps are marked failed and
songs that were queued but never reached are queued again.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from encore_service import __version__
from encore_service.config import Settings
from encore_service.jobs import JobQueue
from encore_service.pipeline import queue_preparation
from encore_service.routes import analyze, duet, gpu, health, songs
from encore_service.store import SongStore

logger = logging.getLogger(__name__)

# How long shutdown waits for the running job before leaving it. A job cut
# off here leaves its step "running", which the next start marks as failed;
# the songs queued behind it are queued again by that start.
SHUTDOWN_WAIT_S = 5.0


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Open the song cache and run the job queue for the app's lifetime."""
    settings: Settings = app.state.settings
    settings.cache_dir.mkdir(parents=True, exist_ok=True)
    store = SongStore(settings.cache_dir)
    jobs = JobQueue()
    # Before the queue starts, so nothing can be mid-step while we look.
    store.clear_incoming()
    recovered = store.recover_interrupted()
    if recovered:
        logger.warning(
            "Marked interrupted steps as failed for %d song(s)", len(recovered)
        )
    # A song queued when the last run stopped never got its turn, and nothing
    # else would ever submit it, so it would read "queued" for good. One with
    # a failed step is left for the person to add again (see the store).
    resumed = 0
    for song_id in store.ids_waiting_to_run():
        # Queueing reads and writes the song's status file, so one damaged
        # song could otherwise keep the whole service from starting.
        try:
            queue_preparation(store, jobs, song_id)
        except Exception:
            logger.exception("Could not resume song %s", song_id)
        else:
            resumed += 1
    if resumed:
        logger.info("Resuming preparation for %d queued song(s)", resumed)
    jobs.start()
    app.state.store = store
    app.state.jobs = jobs
    try:
        yield
    finally:
        jobs.stop(timeout=SHUTDOWN_WAIT_S)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app; pass `settings` in tests, else read the environment."""
    settings = settings or Settings.from_env()
    app = FastAPI(title="encore service", version=__version__, lifespan=_lifespan)
    # Routes read settings from here instead of re-parsing the environment.
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["*"],
        allow_headers=["*"],
        # A page on another origin (the browser app) reads only the headers
        # listed here, besides the few every response is allowed to show.
        expose_headers=[songs.STEM_GAIN_HEADER],
    )
    for module in (health, gpu, songs, analyze, duet):
        app.include_router(module.router)
    return app


app = create_app()
