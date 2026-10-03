# encore

Karaoke practice and vocal coaching. Drop in an mp3, pick a mic, sing along, and get feedback on pitch, timing, dynamics, and style, both in absolute terms and relative to the original vocal. Solo or duet. Three visual skins from utilitarian to Barbie Dreamhouse. Runs locally: a browser app plus a Python service that uses the local GPU for the heavy models.

## Status

See [ROADMAP.md](./ROADMAP.md) for what to do next.

## Run it

```
npm ci                 install front end
npm run dev            Vite dev server on :5173
npm run check          typecheck + unit tests (run before every commit)
npm run build          typecheck + production build
cd service && uv sync  install service (CPU deps); see service/README.md for GPU
```

## Design

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — system design and request/response schemas
- [COACHING.md](./docs/COACHING.md) — feedback rules and coaching logic
- [DUET.md](./docs/DUET.md) — two-singer mode and speaker identification
- [SKINS.md](./docs/SKINS.md) — visual themes and personality copy
- [SESSIONS.md](./docs/SESSIONS.md) — session planning and usage limits

## Requirements

- Node 22
- Python 3.11
- `uv` (package manager for Python)
- `ffmpeg` (audio encoding and conversion)
- An NVIDIA GPU for the service's heavy models (Demucs, Crepe, WhisperX)
- Headphones (for monitoring and accurate latency calibration)
