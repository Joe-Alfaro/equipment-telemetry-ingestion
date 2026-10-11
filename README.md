# Equipment telemetry ingestion

Ingests gateway telemetry over HTTP, routes it through RabbitMQ, and persists it in
Postgres while keeping each device's history duplicate-free and its current state correct
by `event_time`. A React dashboard shows live equipment state and lets you claim new devices.

- [DESIGN.md](DESIGN.md): the problem, the late-data decision, the trace for `--seed Joe-Alfaro`
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

### Ingest validation

`POST /ingest/readings` returns **202** only after RabbitMQ confirms the message. It returns
**400**, with a `details` list, and publishes nothing when:

- the body isn't a JSON object, or a field is missing;
- `gateway_id`, `device_id` or `metric` is empty, longer than 256 characters, or contains
  `\u0000`;
- `value` isn't a finite number;
- `sequence` isn't a safe integer (`Number.isSafeInteger`);
- `event_time` isn't a real ISO-8601 date-time (`YYYY-MM-DDThh:mm:ss[.fff][Z|±hh:mm]`):
  impossible dates such as Feb 30 or hour 24, a year outside 0001–9999, or an offset
  beyond ±15:59.

A timestamp **without an offset is treated as UTC** and accepted. Extra fields are ignored.
These rules keep anything Postgres can't store out of the queue. In the consumer, data errors
go to the `readings.dead-letter` queue, database outages are retried after about 1 s until
the database is back, and other errors are retried up to 5 times and then dead-lettered.

Stop with `docker compose down`. Add `-v` to wipe all data and start fresh.

Configuration (set in `docker-compose.yml`): `LATE_THRESHOLD_MS` (default `30000`) drives
both the `late` flag and gateway staleness; `FUTURE_SKEW_MS` (default `60000`) flags a
reading `future` when its `event_time` is that far ahead of processing;
`CLOCK_SKEW_THRESHOLD_MS` (default `60000`, read by the api) is the median skew above which a
gateway's clock is reported `ahead` (see [Read API](#read-api)); `CONSUMER_PREFETCH`
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
device onto the **Equipment** board. **View history** on a board or inbox card opens the reading
history with its `Late`, `Out of order` and `Future timestamp` flags.

### The trace (seed `Joe-Alfaro`)

The personalized trace uses the seed **`Joe-Alfaro`**, exactly as written (the GitHub
username; seeds are case-sensitive):

```sh
python3 telemetry_generator.py --target http://localhost:8080 --scenario trace --seed Joe-Alfaro
```

It prints the sequence and waits for Enter before sending (add `--yes` to skip the
prompt). It reports device **`trace-device-8720`** through gateways `gw-a-Joe-Alfaro` and
`gw-b-Joe-Alfaro`. The summary is in
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

| Method and path                                | Returns                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/devices?status=registered`           | Board devices with current value per metric and `clockWarnings`           |
| `GET /api/devices?status=unregistered`         | Inbox devices                                                             |
| `GET /api/devices/:deviceId/readings`          | Full history ordered by `event_time`, with `late`, `outOfOrder`, `future` |
| `POST /api/devices/:deviceId/claim` `{"name"}` | 200 on the first claim, 409 if already claimed, 404 if unknown            |
| `GET /api/gateways`                            | `lastSeenAt`, `stale` and `clock` per gateway                             |
| `GET /api/stream`                              | Server-sent events: device updated/discovered/claimed, gateway            |

Gateway clock check (detect, never correct). Each gateway's `clock` is
`{ status, offsetMs, samples }`, judged from its last 20 readings by `received_at`, where
skew = `event_time` − `received_at`:

- `local-time`: at least 5 readings arrived with no UTC offset, and at least 80% of those sit
  within 5 min of the same non-zero multiple of 15 min. `offsetMs` is that multiple, for
  example `19800000` for UTC+5:30.
- `ahead`: the median skew exceeds `CLOCK_SKEW_THRESHOLD_MS`. `offsetMs` is the median, rounded
  to the second.
- `ok`: anything else, including a negative median (a backlog replay). `offsetMs` is `null`.
- `unknown`: fewer than 5 readings. `offsetMs` is `null`.

Each device's `clockWarnings` is `{ gatewayId, status, offsetMs }[]`, one entry for each
gateway that reported the device and is `ahead` or `local-time`. It's `[]` when there are none.
The board and inbox cards show one badge per warning, for example "Clock ahead ~2m" or
"Local time? UTC+5:30". Stored timestamps are never rewritten.

## Deployment (optional extra)

**Optional extra, not needed for grading; docker-compose is the supported path.** A live
copy also runs on Railway:

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
- `FUTURE_SKEW_MS` and `CLOCK_SKEW_THRESHOLD_MS` aren't set on Railway, so their defaults of
  60000 apply, as in compose.
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
