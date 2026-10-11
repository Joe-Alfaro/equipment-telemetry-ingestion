# Equipment telemetry ingestion

Ingests gateway telemetry over HTTP, routes it through RabbitMQ, and persists it in
Postgres while keeping each device's history duplicate-free and its current state correct
by `event_time`. A React dashboard shows live equipment state and lets you claim new devices.

- [DESIGN.md](DESIGN.md): the problem, the late-data decision, the trace for `--seed joe-alfaro`
- [TRACE.md](TRACE.md): the full hand trace, the timing derivation, and actual vs predicted
- [CUTS.md](CUTS.md): what was deliberately left out
- [AI_USAGE.md](AI_USAGE.md): how AI tools were used and how their claims were checked

## Setup from a clean checkout

Requires Docker with Compose v2 and Python 3 (for the generator; standard library only).

```sh
git clone https://github.com/Joe-Alfaro/equipment-telemetry-ingestion.git
cd equipment-telemetry-ingestion
docker compose up --build
```

That is the only step. Compose starts Postgres and RabbitMQ, runs the migrations (the
one-shot `migrate` service), then starts the api, the consumer and the web app.
`docker compose up --build -d --wait` does the same in the background and returns once
everything is healthy.

| Service                 | Where                                              |
| ----------------------- | -------------------------------------------------- |
| API (ingest + read API) | http://localhost:8080 (the generator's default)    |
| Web dashboard           | http://localhost:3000                              |
| RabbitMQ management     | http://localhost:15672 (`telemetry` / `telemetry`) |
| Postgres                | `docker compose exec postgres psql -U telemetry`   |

Ports 8080, 3000 and 15672 must be free. Postgres is not published to the host.

```sh
curl -i -X POST localhost:8080/ingest/readings \
  -H 'Content-Type: application/json' \
  -d '{"gateway_id":"gw-0","device_id":"dev-1","metric":"temperature","value":71.5,"event_time":"2026-10-10T12:00:00+00:00","sequence":0}'
# HTTP/1.1 202 Accepted  (only after RabbitMQ has confirmed the message)
```

Stop with `docker compose down`. Add `-v` to wipe all data and start fresh.

Configuration (set in `docker-compose.yml`): `LATE_THRESHOLD_MS` (default `30000`) drives
both the `late` flag and gateway staleness; `FUTURE_SKEW_MS` (default `60000`) flags a
reading `future` when its `event_time` is that far ahead of processing; `CONSUMER_PREFETCH`
(default `20`) is the number of messages the consumer processes concurrently.

## Running the scenarios

With the stack up, open http://localhost:3000 and run any scenario from the repo root:

```sh
python3 telemetry_generator.py --target http://localhost:8080 --scenario clean
python3 telemetry_generator.py --target http://localhost:8080 --scenario replay
python3 telemetry_generator.py --target http://localhost:8080 --scenario race
```

- **clean**: 3 gateways × 5 devices × 10 readings. All 5 devices appear in **New devices**.
- **replay**: gw-1 replays a 20-reading backlog (with 5 byte-identical resends) while gw-0
  sends live data. The device ends with exactly 40 readings, and current state is the
  newest reading per metric.
- **race**: two gateways report the same new device at the same moment. It is registered
  once, and both readings are kept.

New devices land in the **New devices** inbox. Type a name and press **Claim** to move a
device onto the **Equipment** board. **View history** on a board card opens the reading
history with its `Late` and `Out of order` flags.

### The trace (seed `joe-alfaro`)

The personalized trace uses the seed **`joe-alfaro`**:

```sh
python3 telemetry_generator.py --target http://localhost:8080 --scenario trace --seed joe-alfaro
```

It prints the sequence and waits for Enter before sending (add `--yes` to skip the
prompt). It reports device `trace-device-2493` through gateways `gw-a-joe-alfaro` and
`gw-b-joe-alfaro`. The summary is in
[DESIGN.md](DESIGN.md#trace---seed-joe-alfaro), and the full hand trace with the actual
result is in [TRACE.md](TRACE.md).

### Checking the invariants in SQL

```sh
docker compose exec postgres psql -U telemetry
```

```sql
-- 1. No duplicates: every stored reading has a distinct identity key (also a UNIQUE constraint).
SELECT device_id, count(*) AS stored,
       count(DISTINCT (gateway_id, device_id, metric, sequence, event_time)) AS distinct_keys
FROM readings GROUP BY device_id ORDER BY device_id;

-- 2. Current state = greatest (event_time, gateway_id, sequence) per (device, metric). Expect 0 rows.
WITH best AS (
  SELECT DISTINCT ON (device_id, metric) device_id, metric, value, event_time, gateway_id, sequence
  FROM readings
  ORDER BY device_id, metric, event_time DESC, gateway_id COLLATE "C" DESC, sequence DESC)
SELECT b.* FROM best b LEFT JOIN current_state c USING (device_id, metric)
WHERE (c.value, c.event_time, c.gateway_id, c.sequence)
      IS DISTINCT FROM (b.value, b.event_time, b.gateway_id, b.sequence);

-- 3. One record per device seen in readings.
SELECT (SELECT count(DISTINCT device_id) FROM readings) AS seen,
       (SELECT count(*) FROM devices) AS registered_once;
```

## Read API

| Method and path                                | Returns                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/devices?status=registered`           | Board devices with current value per metric                     |
| `GET /api/devices?status=unregistered`         | Inbox devices                                                   |
| `GET /api/devices/:deviceId/readings`          | Full history ordered by `event_time`, with `late`, `outOfOrder` |
| `POST /api/devices/:deviceId/claim` `{"name"}` | 200 on the first claim, 409 if already claimed, 404 if unknown  |
| `GET /api/gateways`                            | `lastSeenAt` and `stale` per gateway                            |
| `GET /api/stream`                              | Server-sent events: device updated/discovered/claimed, gateway  |

## Deployment

A live copy runs on Railway:

- Dashboard: https://web-production-6ac10.up.railway.app
- API (generator target): https://api-production-1751.up.railway.app

```sh
python3 telemetry_generator.py --target https://api-production-1751.up.railway.app --scenario clean
```

The Railway project has five services. They talk over Railway's private network. Only api
and web have public domains.

| Service    | Source                                    | Notes                                                             |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `Postgres` | Railway managed Postgres                  | No public TCP proxy                                               |
| `rabbitmq` | `rabbitmq:4-management-alpine` + a volume | `RABBITMQ_NODENAME=rabbit@localhost` keeps the data dir stable    |
| `api`      | this repo, `SERVICE_TARGET=api`           | Pre-deploy runs the migrations; healthcheck `/healthz`; `HOST=::` |
| `consumer` | this repo, `SERVICE_TARGET=consumer`      |                                                                   |
| `web`      | this repo, `SERVICE_TARGET=web`           | `API_UPSTREAM=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:8080`        |

- Railway builds the Dockerfile's final `selected` stage. The `SERVICE_TARGET` build arg
  picks the service. Compose still uses `target:`.
- The api pre-deploy command is `node --import tsx packages/db/src/migrate-cli.ts`.
- `DATABASE_URL` and `AMQP_URL` are Railway reference variables, for example
  `${{Postgres.DATABASE_URL}}`. Credentials live only in Railway, never in this repo.
- The nginx `/api` upstream comes from `API_UPSTREAM`, through the nginx image's template
  envsubst. It defaults to `http://api:8080`, so `docker compose up` is unchanged.

## Tests

Requires Node 22+ and npm.

```sh
npm ci
npm test                  # unit and component tests for every workspace (no Docker needed)
npm run test:integration  # starts docker-compose.test.yml, then runs *.integration.test.ts
npm run test:infra:down   # stops the integration Postgres/RabbitMQ
npm run lint
npm run typecheck
npm run format:check
```

Integration tests run against real Postgres (port 55432) and RabbitMQ (port 55672) from
`docker-compose.test.yml`; they don't touch the main stack. `@telemetry/test-harness` gives
each test file its own migrated database (`createTestDatabase()`) and queue
(`createTestBroker()`), so files run in parallel. Override the targets with
`TEST_DATABASE_URL` and `TEST_AMQP_URL`.

Frontend tests use Testing Library and user-event, with the network mocked at the HTTP
boundary by MSW and a fake `EventSource` for SSE.

## Layout

| Path                     | What                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `apps/api`               | Fastify server: `POST /ingest/readings` (publishes with confirms, then 202), read API, SSE |
| `apps/consumer`          | RabbitMQ consumer: one transaction per reading, ack after commit, dead-letters bad input   |
| `apps/web`               | Vite + React dashboard (nginx in Docker, proxies `/api`)                                   |
| `packages/shared`        | Wire and read-API types, ingest validation                                                 |
| `packages/db`            | SQL migrations, migration runner, processing and read queries                              |
| `packages/broker`        | RabbitMQ connection, durable queue, confirm-channel publisher                              |
| `packages/test-harness`  | Integration-test helpers for Postgres and RabbitMQ                                         |
| `telemetry_generator.py` | The provided gateway simulator, unmodified                                                 |
