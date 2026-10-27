# Working in sessions

The owner's weekly usage is limited and resets Tuesday at midnight. Token
efficiency comes first (owner, 2026-10-27). This file is the playbook for
getting the most out of each session and never losing work to a cut-off.

## Where work happens

Local first. The owner runs Claude Desktop (or `claude remote-control`) in
the Encore folder on the GPU machine; that session edits the working copy
directly, runs the app, uses the mic, speakers and GPU, and pushes to
`main` when a wave is done. After any cloud work, `git pull` before the
next local session. Never run both against `main` at the same time.

## Principles

- **The repo is the memory.** Nothing lives only in chat. Plans, decisions,
  and stopping points are committed. See the resume protocol in `CLAUDE.md`.
- **One wave, one session, one commit.** Then stop and `/clear`. Clearing
  is free; a compaction spends tokens summarising what the repo already
  holds.
- **Cheap models do the typing.** The orchestrator plans and reads review
  findings; Sonnet implements and reviews; Haiku does mechanical work.
- **Small files.** A worker reads what it touches. Keep modules under
  about 500 lines so later waves read hundreds of lines, not thousands.
- **Stop at checkpoints, not at the limit.** When usage is low, finish the
  current wave or commit it as WIP, push, and stop.

## The light pipeline (default for every wave)

1. **Brief.** The wave's entry in `ROADMAP.md` is the brief. The
   orchestrator adds only file pointers and the contract a track needs; it
   reads outlines (`grep` for exports) and diffs, not whole files.
2. **Implement.** One Sonnet worker per track (high effort). It reads only
   the files the brief names plus their tests, writes tests for any math,
   runs the checks itself, and returns a short summary: files changed,
   checks run, anything left open. Tracks that share no files may run in
   parallel, the browser one in a `.claude/worktrees/` worktree.
3. **Review once.** One Sonnet reviewer reads the wave's diff with one
   combined lens: behaviour broken, contract mismatched, math untested. It
   returns must-fix items only: no style, no nits, no "consider".
4. **Fix.** Must-fix items go back to the same worker (`SendMessage`), whose
   context is still warm. No separate fixer, no critic, no votes.
5. **Land.** The orchestrator runs the checks, commits, pushes, updates
   **Current state** and the estimates, and stops (resume protocol step 8).

Not in the light pipeline: multi-agent Workflow runs, adversarial
verification, separate live-check agents. The owner's own test after a
wave replaces the live check. This holds even when a session has
multi-agent orchestration switched on: the owner's instruction wins. The
full pipeline (three lenses, adversarial votes, fixer and critic, about
2 M tokens per task) is for a wave the owner names, or W6's sweep if the
owner asks for more than one reviewer.

## Starting a session

Paste this (or something like it):

> Continue encore. Follow the resume protocol in CLAUDE.md. Do the next
> wave with the light pipeline, commit, push, and stop. Report in three
> lines: what changed, what to test, anything you need from me.

## Owner-side tasks

Some things only the owner can do, since the service needs their GPU and the
app needs their mics:

- First run of the service with each extra as its wave lands
  (`service/README.md`, "GPU setup"); `separation` is installed, `pitch`
  comes with W1.
- The owner test named at the end of each wave, with a real song and a
  real mic; a second person for W4.

Workers leave a line under the wave in `ROADMAP.md` when they need one of
these.

## Cost

Per-wave estimates are in `ROADMAP.md`, "Estimates". The light pipeline is
aimed at about 1 M subagent tokens per wave; correct the table with the
real figure after each wave.
