# encore

Karaoke practice and vocal coaching. Drop in an mp3, pick a mic, sing along,
and get feedback on pitch, timing, dynamics, vibrato and style, both in
absolute terms and relative to the original vocal. Solo or duet. Three visual
skins from utilitarian to Barbie Dreamhouse. Runs locally: a browser app plus
a Python service that uses the local GPU for the heavy models.

## Purpose, in priority order

1. **Get better at singing.** Measured, specific, honest feedback is the
   product. When a choice trades coaching quality against anything else,
   coaching wins.
2. **Make it fun.** Skins, streaks, duets, and personality exist to keep
   people practising. They never change what is measured.
3. **Become an app.** Build so the browser front end can ship inside a
   desktop shell later (see Decisions in `docs/ARCHITECTURE.md`): web
   platform APIs only, feature-detected; the service optional and reached
   by a configurable URL; one state store the UI reads from.

Read `ROADMAP.md` for what to do next and `docs/ARCHITECTURE.md` for how the
pieces fit. `docs/` holds the design decisions; do not re-derive them, extend
them.

## Resume protocol (every session starts here)

Sessions are short and get cut off by usage limits. The repo is the only
memory. Follow this exactly so any model can pick up where the last one left:

1. Read the **Current state** block at the top of `ROADMAP.md`.
2. If it names a task **in progress**, finish that task first. Its notes say
   where work stopped. Otherwise take the first unchecked `[ ]` task in the
   active phase. Do not skip ahead; tasks are ordered by dependency.
3. Run the checks before touching anything (`npm run check`, `npm run e2e`
   when the task touches audio or UI, and the service checks). If they are red on
   a clean checkout, fixing that is the task.
4. Do exactly that one task. Resist widening it. Write follow-ups as new
   bullet lines under the task in `ROADMAP.md`, not as extra code.
5. Run the checks again. Green is required to tick the box.
6. Update `ROADMAP.md`: tick the task, refresh **Current state** (last done,
   in progress, blockers, next), add any follow-ups.
7. Commit as `P<phase>-T<n>: <imperative summary>` and push to `main`.
   One task, one commit. If you must stop mid-task, commit as
   `WIP P<phase>-T<n>: <where it stopped>` and write the stopping point in
   **Current state** so the next session does not repeat work.

## Model routing

The owner is budget-constrained. Spend capability where it matters:

| Work | Model |
|---|---|
| Planning, architecture changes, phase reviews, unblocking | Fable / Opus (orchestrator) |
| Implementation tasks from `ROADMAP.md` | Sonnet |
| Mechanical work: CSS skin variants, doc edits, lint fixes, test boilerplate | Haiku |

The orchestrator does not write feature code. It picks the task, writes a
precise brief, dispatches a worker, reviews the diff, and commits.

## Conventions

Mirrors the owner's other repo (`4th-dimension`). Keep them identical so the
owner can move between projects without friction.

- **Front end:** vanilla TypeScript, Vite, vitest. No framework. ES modules.
  Strict `tsconfig`. Imports sorted: side-effect imports, then third-party,
  then local, each group alphabetical.
- **Service:** Python 3.11, FastAPI, `uv` for environments, `ruff` for lint
  and format, `pytest`. Type hints everywhere. Pydantic models for every
  request and response body.
- **Comments:** every file opens with a `/** ... */` (TS) or `"""..."""`
  (Python) block saying what the module is for and how it fits. Exported
  symbols get a one-line doc comment. Inline `//` or `#` comments explain
  *why*, never *what*. Wrap comments at 80 columns. No TODOs in code; put
  them in `ROADMAP.md`.
- **Naming:** `camelCase` TS, `snake_case` Python, `kebab-case` files in
  `src/`, `snake_case.py` modules. Skin ids are lowercase single words.
- **Tests:** anything with math in it (pitch tracking, scoring, alignment,
  latency math) gets a vitest or pytest file beside it, checked against
  synthetic signals with known answers. UI code is tested only where it holds
  logic.
- **Dependencies:** add one only when it saves real work. Audio DSP in the
  browser is hand-written and tested; heavy models live in the service.
- **No model identifiers** in code, code comments, or commit subjects.
  Planning docs may name tiers (Sonnet, Haiku); the harness-added
  `Co-Authored-By` trailer on commits is the one exception.

## Commands

```
npm ci                 install front end
npm run dev            Vite dev server on :5173
npm run check          typecheck + unit tests (run before every commit)
npm run build          typecheck + production build
npm run e2e            Playwright smoke in headless Chromium against the built bundle
cd service && uv sync  install service (CPU deps); see service/README.md for GPU
cd service && uv run uvicorn encore_service.app:app --reload --port 8765
cd service && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

## Layout

```
src/app/        state store, take/session model, UI shell
src/audio/      AudioContext, mp3 player, mic capture, latency calibration, recorder
src/analysis/   browser DSP: live pitch tracker (AudioWorklet), note segmentation, scoring
src/duet/       singer assignment for two-mic and one-mic modes
src/render/     pitch lane canvas, meters, FX (particles, confetti)
src/skins/      token contract, skin definitions, personality copy
src/service/    typed client for the Python service
service/        FastAPI app: separation, reference analysis, take analysis, lyrics, speaker ID
docs/           ARCHITECTURE, COACHING, DUET, SKINS, SESSIONS
```
