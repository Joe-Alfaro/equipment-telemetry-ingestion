# AI usage

Almost all of the code and docs in this repo were written by AI agents. The human set the
requirements and the process, made or accepted the key design calls, and merges the
branches. This file describes the
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
| 4           | Optional Railway deployment                                                    |
| Audit       | Independent, read-only requirements audit of the finished branch               |
| Fix round   | Red tests, then fixes for the audit findings; new trace for `Joe-Alfaro`       |

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
- **Test contradictions went back to the test side.** In the fix round, two red tests
  contradicted the decided rules: a migration snapshot test didn't expect the new `future`
  column, and older processing tests still used the 4-part identity key. The backend
  implementer reported them instead of editing them. The orchestrator approved
  amendments, which a test-side agent (the frontend red-test worker) made as separate
  commits. The orchestrator reviewed each amendment before the implementation used them.
- **Workers stacked branches** and pushed only their own branch. One exception: the
  phase 1 skeleton was fast-forwarded to `main` by a worker after the orchestrator
  reviewed it, before merging was reserved for the human. Since then, no agent has
  pushed to or merged into `main`.

## The human's role

- Wrote the requirements: the PRD derived from the project brief.
- Accepted the stack the orchestrator proposed (TypeScript, Postgres, React, Vitest,
  Testing Library, npm workspaces).
- Chose the trace seed and GitLab as the host. After the audit pointed out that the brief
  asks for the GitHub username, the human switched the seed from `joe-alfaro` to exactly
  `Joe-Alfaro`. The old trace was dropped, and a new hand prediction was committed before
  the `Joe-Alfaro` trace was ever sent.
- Decided the audit fixes, with some details left to the orchestrator: a 5-part identity key (metric included), strict ingest
  validation (naive timestamps treated as UTC), consumer error tiers with a dead-letter
  queue, and a `future` flag.
- Set the process: TDD split, orchestrator review of every branch, merges reserved for
  the human.
- Merges the branches into `main`.

Design decisions are recorded in a running decisions log, with their status:

- **Delegated to the orchestrator.** The human handed the broker choice to the
  orchestrator, which picked RabbitMQ over Redpanda and Kafka.
- **Pending the human's sign-off.** The orchestrator made or proposed these during an
  unattended overnight run: e2 (the identity key including `event_time`), f (monotonic
  current state per device and metric), g (exactly-once registration) and h (the
  late-data policy, "never wait, never drop, flag", with a 30 s threshold). They are
  implemented and tested, but the human has not yet signed them off.

## How claims were verified

An agent saying "tests pass" or "the invariant holds" was not taken as evidence.

- **Re-running tests.** The orchestrator re-ran each worker's suites in that worker's
  worktree before approving. After the fix-round integration, the full unit suite
  (87 tests), the integration suite against real Postgres and RabbitMQ (104 tests, none
  marked expected-fail), lint, typecheck and format were run again on the merged result.
- **An independent audit.** A separate, read-only agent audited the finished branch
  against the brief and the requirements only, from a fresh clone. It ran its own SQL, a
  recording proxy that compared every accepted reading with the database, and 14
  adversarial scenarios. It found poison input that halted ingestion, multi-metric samples
  stored as conflicts, a DESIGN.md over 2 pages, and the seed mismatch. The fix round
  addressed each one, and its end-to-end check from a fresh clone re-ran the audit's
  poison inputs (all now 400, with a valid reading still stored) and the multi-metric case
  (3 rows).
- **psql checks against the running system.** After each generator scenario against
  `docker compose up`, SQL queries checked the three invariants directly: stored count
  vs. distinct emitted count, no duplicate identity keys, current state equal to the
  greatest reading per metric, and exactly one device record per device. The queries are
  in the README.
- **Trace against a prediction written beforehand.** The `Joe-Alfaro` hand trace was
  written and committed by one agent before the trace was ever sent, and the orchestrator
  re-derived it independently. A different agent then ran the real trace once and compared
  the stored rows, current values and flags with the prediction. The prediction was not
  edited to match. The comparison, an exact match, is in [TRACE.md](TRACE.md).
- **The dashboard against the real api.**
  - An agent-driven browser read the live page during scenarios: devices appearing in the
    inbox mid-run, and the board updating over SSE after claims and new readings.
  - The interactive paths ran in a throwaway headless Chrome script (Playwright, outside
    the repo): name validation, claim with a double-click guard, the board, and the
    history flags.
  - Claim semantics were also checked with curl: 200, 409 and 404, and exactly one 200
    out of 10 parallel claims.
  - **Still pending for the human:** a manual UI click-through (claim a device, open the
    history from the board and the inbox).
- **Generator facts were checked against its source.** Claims about the generator (for
  example, that `sequence` is per gateway and device, not per gateway; that resends are
  byte-identical; that trace event times are mostly in the future) were checked by reading
  `telemetry_generator.py` line by line. They were not assumed.
