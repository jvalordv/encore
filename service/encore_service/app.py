"""FastAPI application factory for the encore service.

`create_app` wires CORS from the settings and mounts every router;
`app` is the instance uvicorn serves (`encore_service.app:app`).
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from encore_service import __version__
from encore_service.config import Settings
from encore_service.routes import analyze, duet, gpu, health, songs


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app; pass `settings` in tests, else read the environment."""
    settings = settings or Settings.from_env()
    app = FastAPI(title="encore service", version=__version__)
    # Routes read settings from here instead of re-parsing the environment.
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for module in (health, gpu, songs, analyze, duet):
        app.include_router(module.router)
    return app


app = create_app()
