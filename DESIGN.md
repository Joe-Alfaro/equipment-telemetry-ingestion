# Design

## Problem

Gateways on unreliable networks POST readings `{gateway_id, device_id, metric, value,
event_time, sequence}`. When offline they buffer, then replay the backlog interleaved
with other gateways' live data. They also resend readings and report unregistered
devices. Whatever the delivery order, three things must hold:

1. every reading is stored exactly once;
2. current state per device and metric is the reading with the greatest `event_time`;
3. a new device reported by several gateways at once is recorded once.

All three are **order-independent and enforced in Postgres**:

- **Durable path:** the api returns 202 only after RabbitMQ's publisher confirm, because
  the generator never retries. The consumer runs one transaction per message and acks
  after commit, so a crash means a redelivery, which the database rejects as a duplicate.
- **Identity:** UNIQUE `(gateway_id, device_id, sequence, event_time)`, inserted with
  `ON CONFLICT DO NOTHING`. `sequence` repeats across devices, and keying on `event_time`
  too means a gateway that resets its counter loses nothing. Byte-identical resends
  collapse. The same key with a different payload keeps the first copy and logs the
  others to `reading_conflicts`.
- **Current state:** one row per `(device, metric)`, replaced only when
  `(event_time, gateway_id, sequence)` is strictly greater. The tie-break handles the
  clean scenario's equal `event_time`s.
- **Registration:** `devices` PRIMARY KEY, inserted `ON CONFLICT DO NOTHING` in the
  reading's transaction. A claim is one `UPDATE ... WHERE status = 'unregistered'`, so
  exactly one concurrent claim gets 200 and the others get 409.

## Late-data options

| Option                                | Problem                                                        | Verdict    |
| ------------------------------------- | -------------------------------------------------------------- | ---------- |
| Last arrival wins                     | A replay overwrites newer data                                 | Rejected   |
| Buffer N s, apply in event-time order | N s of latency on every reading; later data still needs a rule | Rejected   |
| Per-gateway watermarks                | One silent gateway stalls every view                           | Rejected   |
| **Never wait, never drop, flag**      | "Current" may lag a disconnected gateway's newer data          | **Chosen** |

## Choice

The conditional upsert can't be overwritten by older data, so waiting would add latency
without making current state any more correct. Every reading is applied immediately and
stored whatever its age, and lateness is shown rather than hidden:

- **`late`:** `processed_at - event_time > 30 s` (`LATE_THRESHOLD_MS`). Future
  `event_time`s are accepted.
- **`out_of_order`:** the reading's `event_time` is strictly older than its metric's
  current state **at processing time**. It is stored but doesn't change current state.
- **Stale gateway:** silent for more than 30 s. Its devices show **"possibly behind"**.

Because `out_of_order` is decided at processing time, and the consumer applies up to 20
messages concurrently, the flag can depend on commit order. A race loser, for example, is
flagged when it commits second. `current_state` never depends on processing order: it is
a function of the set of stored readings.

## Trace: --seed joe-alfaro

Written by hand before the trace was ever sent. [TRACE.md](TRACE.md) has the full trace,
the timing derivation, the re-run analysis and the evidence. Printed sequence (device
`trace-device-2493`; `#` is the wire `sequence`):

```
 #  gateway        metric          value   event_time offset (s)
 0  gw-a-joe-alfaro temperature     41.73                       0
 1  gw-b-joe-alfaro power_draw      32.63                       2
 2  gw-b-joe-alfaro temperature     36.52                       3
 3  gw-a-joe-alfaro temperature     91.83                       4
 4  gw-b-joe-alfaro temperature     23.15                       1
 5  gw-b-joe-alfaro status          81.31                       5
 5  gw-b-joe-alfaro status          81.31                       5
```

Predicted, in arrival order (B = base time):

| seq | Result                                | late | out_of_order | Current after the step                |
| --- | ------------------------------------- | ---- | ------------ | ------------------------------------- |
| 0   | stored; device created `unregistered` | no   | no           | temp 41.73 (B+0)                      |
| 1   | stored                                | no   | no           | temp 41.73; power 32.63               |
| 2   | stored                                | no   | no           | temp 36.52 (B+3); power 32.63         |
| 3   | stored                                | no   | no           | temp 91.83 (B+4); power 32.63         |
| 4   | stored, B+1 < B+4                     | no   | **yes**      | unchanged                             |
| 5   | stored                                | no   | no           | temp 91.83; power 32.63; status 81.31 |
| 5   | duplicate (identical key and payload) | –    | –            | unchanged                             |

**Final current per metric:** temperature 91.83 (gw-a, seq 3, B+4), power_draw 32.63
(gw-b, seq 1, B+2), status 81.31 (gw-b, seq 5, B+5). No vibration. Nothing is late,
because every lag is under 1 s and five of the six event times are in the future.

**Actual vs predicted:**

- **Match:** the real run stored 6 rows (the resend was a duplicate), and current is
  91.83 / 32.63 / 81.31, with 0 late and `out_of_order` only on seq 4.
- **Differences:** sends were about 59 ms apart, not 50 ms, which changed the lags but no
  flag. The "possibly behind" badge only renders on board cards, so the inbox didn't show
  it while the device was unclaimed.
- **Device status:** the trace leaves `trace-device-2493` unregistered. It shows
  `registered` in the database only because it was claimed afterwards, during the
  post-run UI checks.

## 1h vs 1min offline

**1 minute:** the gateway goes stale after 30 s and its devices show "possibly behind".
On reconnect, the backlog is stored in full and readings older than 30 s are flagged
`late`. Current state never regresses.

**1 hour:** correctness holds. These break, in order:

1. **The replay floods the shared queue.** An hour of backlog arrives one request, one
   message and one transaction per reading, in the same FIFO queue as live data. Every
   device's dashboard lags until the backlog drains. Fix: a batch endpoint, plus a
   low-priority queue for readings already older than the threshold.
2. **Hour-old values show as current** for devices that only this gateway reports. The
   only signal is "possibly behind".
3. **Nearly the whole backlog is flagged `late`,** so the flag becomes noise.
4. **The gateway's buffer may overflow** upstream. That loss is invisible to the system.

## 10x gateways

The invariants rest on constraints and row locks, so they hold with any number of api
or consumer replicas.

- **api:** stateless, so add replicas, and batch readings per request.
- **Consumer and Postgres:** competing consumers until Postgres becomes the limit (one
  transaction per reading, plus hot `current_state` rows). Next steps: multi-row inserts,
  queues sharded by device, `readings` partitioned by time, and a `device_gateways`
  table.
- **Live view:** every SSE event refetches both device lists. Next steps: per-device
  fetches or patch payloads, and paging.
- **Replays** become 10× as frequent, so separating backlog from live traffic matters
  more.
