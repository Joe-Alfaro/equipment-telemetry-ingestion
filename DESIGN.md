# Design

## Problem

Gateways on unreliable networks POST readings `{gateway_id, device_id, metric, value,
event_time, sequence}`, buffer while offline, replay the backlog interleaved with live
data, resend, and report unregistered devices. In any delivery order: every reading is
stored exactly once; current state per device and metric is the reading with the
greatest `event_time`; a new device seen by several gateways at once is recorded once.
All three are **enforced in Postgres**, not by timing:

- **Durable path:** the api validates (anything Postgres can't store gets a 400) and
  returns 202 only after RabbitMQ's publisher confirm. The consumer runs one transaction
  per message and acks after commit, so a crash means a redelivery that dedups. Data
  errors go to a dead-letter queue; outages are retried until the database returns.
- **Identity:** UNIQUE `(gateway_id, device_id, metric, sequence, event_time)` with
  `ON CONFLICT DO NOTHING`. Same key with another value: first copy kept, conflict logged.
- **Current state:** one row per `(device, metric)`, replaced only by a strictly greater
  `(event_time, gateway_id, sequence)`.
- **Registration:** `devices` PRIMARY KEY, inserted in the reading's transaction. A claim
  is one `UPDATE ... WHERE status = 'unregistered'`: one 200, all others 409.

## Broker: RabbitMQ over Kafka/Redpanda

The invariants live in Postgres, so the broker only needs durable at-least-once delivery
(publisher confirms, ack after commit), which RabbitMQ gives most simply. We give up a
replayable log and per-device partition ordering, which the order-independent design
doesn't need. At 10x, consumers compete until Postgres is the limit; if replay were
needed, a Kafka-style log partitioned by device would be the move.

## Late-data options

| Option                                | Problem                                    | Verdict    |
| ------------------------------------- | ------------------------------------------ | ---------- |
| Last arrival wins                     | A replay overwrites newer data             | Rejected   |
| Buffer N s, apply in event-time order | Latency on every reading; still needs rule | Rejected   |
| Per-gateway watermarks                | One silent gateway stalls every view       | Rejected   |
| **Never wait, never drop, flag**      | "Current" may lag a disconnected gateway   | **Chosen** |

## Choice

The conditional upsert can't be overwritten by older data, so waiting adds latency
without adding correctness. Every reading is applied at once and kept, and lateness is
shown: **`late`** if `processed_at - event_time > 30 s`; **`out_of_order`** if older than
its metric's current state when processed (stored, current unchanged; under concurrent
processing this flag can depend on commit order, current state cannot); **`future`** if
`event_time` is more than 60 s ahead (flag only). A gateway silent for over 30 s is
stale, and its devices show **"possibly behind"**.

## Trace: --seed Joe-Alfaro

Seed exactly `Joe-Alfaro`, the brief's GitHub username. Predicted by hand before the
first run; [TRACE.md](TRACE.md) has the printed sequence, timing and full comparison.
Device `trace-device-8720`, arrival order:

| seq | gw  | metric     | value | event_time | Result                        | Current after     |
| --- | --- | ---------- | ----- | ---------- | ----------------------------- | ----------------- |
| 0   | a   | power_draw | 90.94 | B+0        | stored; device `unregistered` | power 90.94       |
| 1   | a   | vibration  | 56.07 | B+4        | stored                        | + vibration 56.07 |
| 2   | b   | status     | 83.48 | B+1        | stored                        | + status 83.48    |
| 3   | b   | status     | 85.86 | B+2        | stored                        | status 85.86      |
| 4   | b   | status     | 82.05 | B+3        | stored                        | status 82.05      |
| 5   | b   | status     | 58.44 | B+5        | stored                        | status 58.44      |
| 5   | b   | status     | 58.44 | B+5        | duplicate                     | unchanged         |

**Predicted final:** 6 rows, 0 conflicts; current power_draw 90.94, vibration 56.07,
status 58.44, no temperature; 0 `late`, 0 `out_of_order` (status arrives in order),
0 `future` (max skew about 5 s). **Actual:** exact match.

## 1h vs 1min offline

**1 minute:** the gateway goes stale after 30 s; on reconnect the backlog is stored in
full, readings over 30 s old are `late`, and current state never regresses.
**1 hour:** correctness holds; these break, in order:

1. **The replay floods the shared FIFO queue** (one request, message and transaction per
   reading), so every dashboard lags until it drains. Fix: batch ingest and a
   low-priority queue for already-late readings.
2. **Hour-old values show as current** for devices only this gateway reports; the only
   signal is "possibly behind".
3. **Nearly the whole backlog is `late`,** so the flag becomes noise.
4. **The gateway's own buffer may overflow** upstream, invisibly to us.

## 10x gateways

Invariants rest on constraints and row locks, so they hold with any number of replicas.
The api is stateless (add replicas, accept batches). Consumers compete until Postgres is
the limit; then multi-row inserts, queues sharded by device and time-partitioned
`readings`. Each SSE event refetches both device lists; move to per-device patches. And
replays are 10x as frequent, so separating backlog from live traffic matters more.
