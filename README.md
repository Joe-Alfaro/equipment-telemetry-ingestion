# Equipment telemetry ingestion

Ingests gateway telemetry over HTTP, routes it through RabbitMQ, and persists it in
Postgres while keeping each device's history duplicate-free and its current state correct
by `event_time`. A React dashboard shows live equipment state and lets you claim new devices.

> Stub. Phase 3 completes setup, scenario, and design documentation.

## Run it

Requires Docker with Compose v2.

```sh
docker compose up --build
```

| Service                 | URL                                                |
| ----------------------- | -------------------------------------------------- |
| API (ingest + read API) | http://localhost:8080                              |
| Web dashboard           | http://localhost:3000                              |
| RabbitMQ management     | http://localhost:15672 (`telemetry` / `telemetry`) |
| Postgres                | `docker compose exec postgres psql -U telemetry`   |

Migrations run automatically (the `migrate` service) before the api and consumer start.

```sh
curl -i -X POST localhost:8080/ingest/readings \
  -H 'Content-Type: application/json' \
  -d '{"gateway_id":"gw-0","device_id":"dev-1","metric":"temperature","value":71.5,"event_time":"2026-10-10T12:00:00+00:00","sequence":0}'
# HTTP/1.1 202 Accepted
```

Stop and wipe data with `docker compose down -v`.

## Generator

```sh
python3 telemetry_generator.py --target http://localhost:8080 --scenario clean
python3 telemetry_generator.py --target http://localhost:8080 --scenario replay
python3 telemetry_generator.py --target http://localhost:8080 --scenario race
python3 telemetry_generator.py --target http://localhost:8080 --scenario trace --seed joe-alfaro
```

The trace seed is **`joe-alfaro`**.

## Development

Requires Node 22+ and npm.

```sh
npm install
npm test                  # unit tests for every workspace (no Docker needed)
npm run test:integration  # starts docker-compose.test.yml, then runs *.integration.test.ts
npm run test:infra:down   # stops the integration Postgres/RabbitMQ
npm run lint
npm run typecheck
npm run format
```

Integration tests use `@telemetry/test-harness`: `createTestDatabase()` gives each test file
its own migrated database and `createTestBroker()` its own queue, so files run in parallel.
Override the targets with `TEST_DATABASE_URL` and `TEST_AMQP_URL`.

## Layout

| Path                    | What                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `apps/api`              | Fastify server: `POST /ingest/readings` (publishes with confirms, then 202), read API, SSE |
| `apps/consumer`         | RabbitMQ consumer: processes each reading, acks after commit                               |
| `apps/web`              | Vite + React dashboard                                                                     |
| `packages/shared`       | Wire and read-API types, ingest validation                                                 |
| `packages/db`           | SQL migrations, migration runner, queries                                                  |
| `packages/broker`       | RabbitMQ connection, durable queue, confirm-channel publisher                              |
| `packages/test-harness` | Integration-test helpers for Postgres and RabbitMQ                                         |
