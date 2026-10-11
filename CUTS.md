# Cuts

What was deliberately left out, and why. Each item says what breaks and what would come next.

## Reliability

- **Dead-lettered messages have no replay tooling.** After the audit, poison input can no
  longer stall ingestion: the api rejects with 400 anything Postgres can't store (impossible
  dates, years outside 0001–9999, NUL, ids over 256 characters), and the consumer sends
  data errors to `readings.dead-letter`, retries other errors up to 5 times, then
  dead-letters them. A burst of 20 poison readings followed by a valid one now stores the
  valid one. But nothing alerts on, inspects or replays the dead-letter queue; that's done
  by hand in the RabbitMQ management UI.
- **Database outages are retried without a cap, and slowly.** On a connection error the
  consumer holds the message's prefetch slot for `retryDelayMs` (about 1 s), then nacks it
  with requeue. There is no delay queue, so during an outage throughput drops to roughly
  prefetch (20) messages per second. Nothing is lost, but there's no circuit breaker or
  alert.
- **Retries can reorder.** A message retried for an unclassified error is republished to
  the back of the queue. Current state doesn't depend on order, but the retried reading may
  be flagged `out_of_order` when it wouldn't have been.
- **A single consumer replica in compose.** The consumer processes up to 20 messages
  concurrently (prefetch), and correctness doesn't depend on there being one instance:
  the invariants are enforced by constraints and row locks. But only one replica was run
  and tested end to end. Scaling out is covered in DESIGN.md ("10x gateways").
- **Crash-and-restart instead of reconnect.** The api and consumer exit when the
  RabbitMQ connection drops, and compose restarts them. Unacked messages are redelivered,
  so nothing is lost, but there is a short window of 503s from the api.
- **No backpressure or rate limiting on ingest.** The api accepts as fast as RabbitMQ
  confirms. A flood fills the queue rather than being shed at the edge.
- **No batching.** One HTTP request, one message and one transaction per reading. That
  matches the wire contract, but it limits throughput (see DESIGN.md).

## Product

- **Every first-seen device starts unregistered.** The system has no catalogue of known
  equipment, so the generator's `known-device-*` IDs (which get a fresh tag each run) all
  land in the **New devices** inbox. A real deployment would import the commissioning
  equipment list and pre-register those IDs.
- **No auth.** Anyone who can reach the api can ingest readings or claim devices.
  Gateways would need per-gateway credentials, and the dashboard would need user accounts
  before claim actions can be attributed.
- **No unclaim, rename, merge or reject.** A claim is final. A device that is noise (a
  mistyped ID from a gateway) stays in the inbox forever.
- **Late and future readings are flagged, never held back or corrected.** The `late`,
  `out_of_order` and `future` flags are informational. A gateway with a clock a year
  ahead is flagged `future`, but its reading still becomes current until real time
  catches up. There is no skew cap, alerting or reprocessing pipeline.
- **Gateway clocks are detected, never corrected.** A gateway whose clock runs ahead, or
  which sends local time with no UTC offset, gets a clock badge, and its stored
  `event_time` stays as received. An automatic correction would be a guess: it would
  change the reading's identity (so resends would stop deduplicating against earlier
  copies), move current state, and could not be undone for a wrong guess. A negative skew
  is never flagged, because a backlog replay and network delay look the same. Next:
  per-gateway configured timezones, applied at ingest for new readings only.
- **Minimal dashboard.** No search, paging, charts, metric units or gateway view. Every
  SSE event refetches both device lists, which is fine for tens of devices and not for
  thousands.
- **No history paging.** `GET /api/devices/:id/readings` returns the whole history.

## Operations

- **No metrics or observability.** Structured JSON logs only. No Prometheus metrics,
  tracing, queue-depth alarms, or dashboards for ingest rate, consumer lag, late-reading
  rate or conflict count. RabbitMQ's management UI is the only live view of the queue.
- **No retention or partitioning.** `readings` grows without bound. At scale it would be
  partitioned by time, with old partitions archived.
- **Conflicts are recorded but not surfaced.** A same-key, different-payload reading is
  written to `reading_conflicts`; nothing in the UI or API shows it.
- **No TLS, secrets management or production config.** Credentials are fixed in
  `docker-compose.yml` for local use only.
- **The Railway deployment is an optional extra.** It isn't needed for grading; the
  supported path is `docker compose up`. It has no monitoring, backups or spend limit. It
  doesn't set `FUTURE_SKEW_MS` or `CLOCK_SKEW_THRESHOLD_MS`, so their defaults of 60000
  apply.
- **The demo simulator is opt-in and demo-only.** It runs only under the compose profile
  `demo`, isn't a load generator, and its devices stay in the database until it's wiped.
- **No load or soak testing.** The scenarios and integration tests prove correctness, not
  throughput.

## Testing

- **No browser end-to-end test in CI.** The web app is covered by component tests
  (Testing Library and MSW), the backend by integration tests against real Postgres and
  RabbitMQ. The full stack was checked by hand: the scenarios against `docker compose up`,
  the invariants in SQL, and the dashboard through a throwaway headless-browser script
  and curl, none of it kept as a test.
- **No automated process-kill test.** Redelivery after a crash before ack is tested by
  closing the consumer's broker connection mid-transaction in an integration test. The
  container-level check (stop the consumer, ingest, start it again, and the readings
  appear exactly once) was done by hand, not in CI.
