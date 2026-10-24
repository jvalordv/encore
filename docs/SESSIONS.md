# Working in sessions

The owner's weekly usage is limited and resets Tuesday at midnight. This
file is the playbook for getting the most out of each session and never
losing work to a cut-off.

## Where work happens

Local first. The owner runs Claude Desktop (or `claude remote-control`) in
the Encore folder on the GPU machine; that session edits the working copy
directly, runs the app, uses the mic, speakers and GPU, and pushes to
`main` when a task is done or when a backup is wanted. The cloud session
is optional: use it for large build phases that fan out to many parallel
workers, and only after pushing. After cloud work, `git pull` before the
next local session. Never run both against `main` at the same time.

## Principles

- **The repo is the memory.** Nothing lives only in chat. Plans, decisions,
  and stopping points are committed. See the resume protocol in `CLAUDE.md`.
- **One task, one commit, one push.** A cut-off costs at most one task.
- **Cheap models do the typing.** The orchestrator plans and reviews;
  Sonnet implements; Haiku does mechanical work. See model routing in
  `CLAUDE.md`.
- **Stop at checkpoints, not at the limit.** When usage is low, finish the
  current task, push, and stop. Do not start a task that cannot finish.

## Starting a session

Paste this (or something like it):

> Continue encore. Follow the resume protocol in CLAUDE.md. Do the next
> ROADMAP task with a Sonnet worker, verify, commit, push, and stop at a
> clean checkpoint. If the task is a phase review (tier F), do it yourself.
> Report in three lines: what changed, what is next, anything I should test
> on my machine.

For a batch: "...do the next three tasks, one commit each, stop early if a
check fails twice."

## Owner-side tasks

Some things only the owner can do, since the service needs their GPU and the
app needs their mics:

- First run of the service with each model extra as its task lands
  (`service/README.md`, "GPU setup"); `separation` is installed.
- Smoke tests at each phase review with a real song and a real mic.
- Enrollment recordings for duet mode.

Workers will leave a line under the task in `ROADMAP.md` when they need one
of these.

## Rough cost per task

Measured hours and per-task estimates for everything left are in
`ROADMAP.md`, "Estimates". The full pipeline (implementer, three review
lenses, adversarial verification, fixer, critic, live check) costs about
2 million subagent tokens per task; use a lighter one for low-risk tasks.
Spend the week's budget on Phases 2 and 3 first; duet and packaging are
useless until the loop, the reference and coaching exist.

## Schedule suggestion

- Now (low budget): Phase 0 only.
- After the reset: Phase 1 across two or three sessions, then Phase 2.
- Following week: Phase 3, then Phase 4.
- Flair (Phase 5) threads through whenever a session has a little budget
  left; skins are Haiku work.
