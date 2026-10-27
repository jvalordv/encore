# encore

Karaoke for one or two singers. Drop in an mp3 or a YouTube link, pick a
mic, and sing to the instrumental with the melody on screen. Karaoke mode
never judges; an opt-in learning mode says plainly where the singing
misses (pitch, timing) and gives tips on request. Three visual skins from
utilitarian to Barbie Dreamhouse. Runs locally: a browser app plus a Python
service that uses the local GPU to prepare songs.

## Purpose, in priority order

1. **Karaoke that is fun and never shames.** Karaoke mode shows no scores,
   misses or tips. Nothing from learning mode leaks into it.
2. **Learning mode that is honest.** When the singer turns it on, feedback
   is measured, specific and direct. Rules over measured features, never
   guesses.
3. **Ordinary equipment.** A laptop's own mic and speakers, headphones, a
   webcam or USB mic; two singers on one mic or two.
4. **Token efficiency.** The owner's budget is the constraint: waves, light
   review, small files (`docs/SESSIONS.md`).
5. **Become an app, later.** Keep the front end shippable in a desktop
   shell (see Decisions in `docs/ARCHITECTURE.md`): web platform APIs
   only, feature-detected; the service optional and reached by a
   configurable URL; one state store the UI reads from.

Read `ROADMAP.md` for what to do next and `docs/ARCHITECTURE.md` for how the
pieces fit. `docs/` holds the design decisions; do not re-derive them, extend
them.

## Resume protocol (every session starts here)

Sessions are short and get cut off by usage limits. The repo is the only
memory. Work is local first (`docs/SESSIONS.md`); pull before you start. Follow this exactly so any model can pick up where the last one left:

1. Read the **Current state** block at the top of `ROADMAP.md`.
2. If it names a wave **in progress**, finish that wave first. Its notes say
   where work stopped. Otherwise take the first unchecked `[ ]` wave. Do
   not skip ahead; waves are ordered by dependency.
3. Run the checks before touching anything (`npm run check`, `npm run e2e`
   when the wave touches audio or UI, and the service checks). If they are
   red on a clean checkout, fixing that comes first.
4. Do exactly that one wave, with the light pipeline in `docs/SESSIONS.md`.
   Resist widening it. Write follow-ups as new bullet lines under the wave
   in `ROADMAP.md`, not as extra code.
5. Run the checks again. Green is required to tick the box.
6. Update `ROADMAP.md`: tick the wave, refresh **Current state** (last
   done, in progress, blockers, next), add any follow-ups, and correct the
   estimates with what the wave really cost.
7. Commit as `W<n>: <imperative summary>` and push to `main`. One wave,
   one commit. If you must stop mid-wave, commit as
   `WIP W<n>: <where it stopped>` and write the stopping point in
   **Current state** so the next session does not repeat work.
8. Stop. Tell the owner in three lines what changed, what to test, and to
   `/clear` before the next wave. Do not start the next wave in the same
   session.

## Model routing

The owner is budget-constrained. Spend capability where it matters:

| Work | Model |
|---|---|
| Planning, architecture changes, unblocking | Fable / Opus (orchestrator) |
| Implementation and the one review per wave | Sonnet |
| Mechanical work: CSS skin variants, doc edits, lint fixes, test boilerplate | Haiku |

The orchestrator does not write feature code. It picks the wave, writes a
precise brief, dispatches a worker, reads the reviewer's findings, and
commits.

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
src/app/        state store, session controllers, takes, UI shell, panels
src/audio/      AudioContext, players and transports, mic capture, latency, recorder
src/analysis/   browser DSP: live pitch tracker (AudioWorklet), scoring
src/coach/      learning-mode tips: rules over scored notes
src/duet/       two singers: second mic, turns on one mic
src/render/     pitch lane canvas and its layers
src/skins/      token contract, skin definitions, personality copy
src/service/    typed client for the Python service
service/        FastAPI app: intake, YouTube fetch, separation, reference melody
docs/           ARCHITECTURE, COACHING, DUET, SKINS, SESSIONS, HISTORY
```
