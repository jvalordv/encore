"""Entry point for `python -m encore_service`.

Starts uvicorn on localhost using ENCORE_PORT, so the port setting has one
place where it takes effect. For auto-reload during development run uvicorn
directly, as shown in README.md.
"""

import uvicorn

from encore_service.config import Settings


def main() -> None:
    """Serve the app on 127.0.0.1 at the configured port."""
    # Loopback only: the service has no auth and must not face the network.
    uvicorn.run(
        "encore_service.app:app",
        host="127.0.0.1",
        port=Settings.from_env().port,
    )


if __name__ == "__main__":
    main()
