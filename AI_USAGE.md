# AI usage

Almost all of the code and docs in this repo were written by AI agents. The human set the
requirements, made the design calls, and merges every branch. This file describes the
setup, the split of work, and how the agents' claims were checked.

## Tools

- **Claude Code (Opus 5.5)**, run through an **Agent Orchestrator** setup: one long-lived
  orchestrator agent, plus a separate worker agent (its own session and git worktree) for
  each phase.
- No other AI tools. No AI service runs inside the system itself.

## How the work was split

| Phase       | Worker's job                                                                   |
| ----------- | ------------------------------------------------------------------------------ |
| 0           | Clean up the repo and move it to GitLab                                        |
| 1           | Skeleton: workspaces, compose, ingest with publisher confirms, test harness    |
| 1T          | Hand trace for `--seed joe-alfaro`, written **before** the trace was ever sent |
| 2A-T / 2B-T | Backend and frontend **red tests** only                                        |
| 2A-I / 2B-I | Backend and frontend **implementation**, by different agents                   |
| 3           | Integration, end-to-end verification against `docker compose up`, these docs   |

- **Orchestrator.** It turned the human's requirements into a written plan, shared
  contract and per-phase prompts, spawned the workers, and reviewed every branch before
  it was proposed for merge. The review checked that the diff matched the phase scope,
  that tests had actually run (by re-running them in the worker's worktree), that
  implementation phases hadn't weakened tests, and that invariants were enforced in the
  database rather than by timing.
- **Strict TDD split.** A red-test agent wrote failing tests and showed that they failed
  for the right reason. A different agent then implemented against them and was not
  allowed to change, skip or weaken a test. When an implementer thought a test was wrong,
  it had to raise that with the orchestrator, not edit the test. One contract change (the
  dedup key gaining `event_time`) went through that route: a new red test came first,
  then the implementation.
- **Workers stacked branches** and pushed only their own branch. They never pushed to or
  merged into `main`.

## The human's role

- Wrote the requirements: the PRD derived from the project brief, and the stack choice
  (TypeScript, Postgres, React, Vitest, Testing Library, npm workspaces).
- Made or approved the design decisions, recorded in a running decisions log: the broker,
  the dedup key and its later amendment, the late-data policy, the trace seed.
- Set the process: TDD split, orchestrator review of every branch, GitLab only.
- Merges every branch into `main`. Agents cannot.

## How claims were verified

An agent saying "tests pass" or "the invariant holds" was not taken as evidence.

- **Re-running tests.** The orchestrator re-ran each worker's suites in that worker's
  worktree before approving. After integration, the full unit suite (57 tests), the
  integration suite against real Postgres and RabbitMQ (77 tests), lint and typecheck
  were run again on the merged result.
- **psql checks against the running system.** After each generator scenario against
  `docker compose up`, SQL queries checked the three invariants directly: stored count
  vs. distinct emitted count, no duplicate identity keys, current state equal to the
  greatest reading per metric, and exactly one device record per device. The queries are
  in the README.
- **Trace against a prediction written beforehand.** The hand trace in DESIGN.md was
  written and committed by one agent before the trace was ever sent. A different agent ran
  the real trace later and compared the stored rows, current values and flags with the
  prediction. The prediction was not edited to match. The comparison is recorded in
  DESIGN.md.
- **The dashboard in a real browser** against the real api: inbox discovery during a
  scenario, claiming, the board, the history flags, and live updates over SSE.
- **Generator facts were checked against its source.** Claims about the generator (for
  example, that `sequence` is per gateway and device, not per gateway; that resends are
  byte-identical; that trace event times are mostly in the future) were checked by reading
  `telemetry_generator.py` line by line. They were not assumed.
