# Cuts

What was deliberately left out, and why. Each item says what breaks and what would come next.

## Reliability

- **Poisoned messages requeue forever.** A message that decodes but fails processing
  (for example, the database rejects it every time) is nacked with requeue, so it loops
  without limit. There is no retry cap, delay or dead-lettering for processing failures.
  Undecodable messages are handled: they go to the durable `readings.dead-letter` queue.
  Next step: count attempts in a header, back off, then dead-letter after N tries.
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
- **Late readings are flagged, never held back or corrected.** The `late` and
  `out_of_order` flags are informational. There is no alerting on them and no
  reprocessing pipeline.
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
