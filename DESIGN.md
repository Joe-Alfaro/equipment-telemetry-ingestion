# Design

## Problem

Gateways on unreliable networks POST readings `{gateway_id, device_id, metric, value,
event_time, sequence}`. When offline, they buffer and later replay the backlog
interleaved with other gateways' live data. They also resend readings and report devices
nobody has registered. Whatever the delivery order: (1) every reading is stored exactly
once; (2) current state per device and metric is the reading with the greatest
`event_time`, never the latest arrival; (3) a new device reported by several gateways at
once is recorded once.

All three are made **order-independent and enforced in Postgres**, so neither the broker
nor the clock has to order anything:

- **Durable path.** The api returns 202 only after RabbitMQ's publisher confirm (the
  generator never retries). The consumer runs one transaction per message and acks after
  commit, so a crash leads to a redelivery, which the database rejects as a duplicate.
- **Identity:** UNIQUE `(gateway_id, device_id, sequence, event_time)` with
  `ON CONFLICT DO NOTHING`. `sequence` repeats across devices, and including `event_time`
  means a gateway that resets its counter loses nothing. Resends are byte-identical, so
  they collapse. The same key with a different payload keeps the first copy and logs the
  rest to `reading_conflicts`.
- **Current state:** one row per `(device, metric)`, replaced only when
  `(event_time, gateway_id, sequence)` is strictly greater. The tie-break exists because
  the clean scenario produces equal `event_time`s.
- **Registration:** `devices` PRIMARY KEY, inserted `ON CONFLICT DO NOTHING` in the
  reading's transaction. Claim is one `UPDATE ... WHERE status = 'unregistered'`, so one
  concurrent claim gets 200 and the others get 409.

## Late-data options

| Option                                       | Problem                                                                              | Verdict    |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | ---------- |
| Last arrival wins                            | A replay overwrites newer data (breaks invariant 2)                                  | Rejected   |
| Buffer N s, then apply in `event_time` order | Adds N s of latency to every reading, and anything later than N s still needs a rule | Rejected   |
| Per-gateway watermarks, finalize windows     | One silent gateway stalls everyone's view                                            | Rejected   |
| **Never wait, never drop, flag**             | "Current" may lag a disconnected gateway's newer data                                | **Chosen** |

## Choice

The conditional upsert can't be overwritten by older data, so waiting buys no
correctness for current state, only latency. Every reading is applied at once and stored
whatever its age, and lateness is shown rather than hidden:

- **`late`:** `processed_at - event_time > LATE_THRESHOLD_MS` (30 s). Future
  `event_time`s are accepted.
- **`out_of_order`:** the reading's `event_time` is strictly older than its metric's
  current state **at processing time**. It is stored but doesn't change current.
- **Stale gateway:** silent for more than 30 s. Its devices show **"possibly behind"**.

`out_of_order` is decided at processing time. The consumer applies up to 20 messages
concurrently, so the flag can depend on commit order: a gateway's in-order backlog can
commit slightly out of order, and the race loser is flagged when it commits second.
`current_state` never depends on processing order; it is a function of the set of
stored readings.

## Trace: --seed joe-alfaro

This trace was written by hand **before** the trace was ever sent to the system. The sequence was printed without sending, using a discard-port target and EOF at the confirmation prompt:

```
python3 telemetry_generator.py --target http://127.0.0.1:9 --scenario trace --seed joe-alfaro < /dev/null
```

Printed sequence (verbatim):

```
your personalized trace scenario (seed=joe-alfaro), device=trace-device-2493:
 #  gateway        metric          value   event_time offset (s)
 0  gw-a-joe-alfaro temperature     41.73                       0
 1  gw-b-joe-alfaro power_draw      32.63                       2
 2  gw-b-joe-alfaro temperature     36.52                       3
 3  gw-a-joe-alfaro temperature     91.83                       4
 4  gw-b-joe-alfaro temperature     23.15                       1
 5  gw-b-joe-alfaro status          81.31                       5
 5  gw-b-joe-alfaro status          81.31                       5
```

All rows have device `trace-device-2493`. The `#` column is the `sequence` sent on the wire.

### Rules applied

- **Dedup key:** `(gateway_id, device_id, sequence, event_time)`. Including `event_time` means a gateway that resets its sequence counter can't lose readings. A repeated key with the same metric and value is a duplicate: no new history row, no state change and no flags. A repeated key with a different metric or value is a conflict: the first copy is kept and the conflict is counted.
- **Current state:** kept per `(device_id, metric)`. A reading replaces it only if `(event_time, gateway_id, sequence)` is strictly greater than the stored reading's.
- **`late`:** set when `processed_at - event_time > 30 s`.
- **`out_of_order`:** set when the reading's `event_time` is older than the current `event_time` for its `(device, metric)` at processing time. The reading is still stored.
- **Future `event_time`s** are accepted as they are.

### Timing

Let `B` be the generator's `base = now()`, taken just before printing. Reading `i` has `event_time = B + offset`. It is sent at about `B + 0.05·i` s because sends are 50 ms apart and `--yes` skips the prompt. Processing adds only a few milliseconds through the API, RabbitMQ and the consumer. So:

`lag = processed_at - event_time ≈ 0.05·i - offset` (plus milliseconds of pipeline delay)

Negative lag means the `event_time` is in the future when the reading is processed. The trace assumes the consumer processes messages in arrival order (single queue, FIFO).

### Step by step (arrival order)

| Step | seq        | gateway         | metric      | value | event_time | lag (approx.) | Result                                                                                                                                                                                                                                                                                               | late         | out_of_order                            | Current after this step                                                    |
| ---- | ---------- | --------------- | ----------- | ----- | ---------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------- | -------------------------------------------------------------------------- |
| 1    | 0          | gw-a-joe-alfaro | temperature | 41.73 | B+0 s      | +0.00 s       | stored. First sighting: device `trace-device-2493` is created as `unregistered`, first seen via gw-a-joe-alfaro                                                                                                                                                                                      | no           | no (no prior temperature)               | temperature = **41.73** (gw-a, seq 0, B+0)                                 |
| 2    | 1          | gw-b-joe-alfaro | power_draw  | 32.63 | B+2 s      | −1.95 s       | stored                                                                                                                                                                                                                                                                                               | no           | no (no prior power_draw)                | temperature 41.73; power_draw = **32.63** (gw-b, seq 1, B+2)               |
| 3    | 2          | gw-b-joe-alfaro | temperature | 36.52 | B+3 s      | −2.90 s       | stored. B+3 > B+0, so it replaces temperature                                                                                                                                                                                                                                                        | no           | no                                      | temperature = **36.52** (gw-b, seq 2, B+3); power_draw 32.63               |
| 4    | 3          | gw-a-joe-alfaro | temperature | 91.83 | B+4 s      | −3.85 s       | stored. B+4 > B+3, so it replaces temperature                                                                                                                                                                                                                                                        | no           | no                                      | temperature = **91.83** (gw-a, seq 3, B+4); power_draw 32.63               |
| 5    | 4          | gw-b-joe-alfaro | temperature | 23.15 | B+1 s      | −0.80 s       | stored. B+1 < B+4, so temperature is **not** changed                                                                                                                                                                                                                                                 | no           | **yes** (B+1 is older than current B+4) | temperature 91.83 (unchanged); power_draw 32.63                            |
| 6    | 5          | gw-b-joe-alfaro | status      | 81.31 | B+5 s      | −4.75 s       | stored                                                                                                                                                                                                                                                                                               | no           | no (no prior status)                    | temperature 91.83; power_draw 32.63; status = **81.31** (gw-b, seq 5, B+5) |
| 7    | 5 (resend) | gw-b-joe-alfaro | status      | 81.31 | B+5 s      | −4.70 s       | **duplicate**. The resend is byte-identical, so it has the same `event_time` (B+5). The key `(gw-b-joe-alfaro, trace-device-2493, 5, B+5)` already exists, so `ON CONFLICT DO NOTHING` applies. Metric and value also match, so this is a plain duplicate, not a conflict. The API still returns 202 | n/a (no row) | n/a (no row)                            | unchanged                                                                  |

Notes:

- **No reading is late.** The largest lag is that of seq 0, at about 0 s plus pipeline delay. That is far below 30 s. Five of the six stored readings have future `event_time`s when they are processed. A reading would be flagged late only if the pipeline stalled for more than 30 s plus its offset, for example if the consumer were down during the run.
- **The tie-break is never used.** No two readings for the same metric share an `event_time`.
- **`out_of_order` on seq 4 does not depend on strict FIFO.** It is flagged as long as seq 2 or seq 3 is processed before it. Only seq 0 (B+0) is older than seq 4.

### Final state

- **History:** 6 rows for `trace-device-2493`, one per seq 0–5. The resend added nothing. Ordered by `event_time`, they are:

  | event_time | seq | gateway         | metric      | value | late | out_of_order |
  | ---------- | --- | --------------- | ----------- | ----- | ---- | ------------ |
  | B+0        | 0   | gw-a-joe-alfaro | temperature | 41.73 | no   | no           |
  | B+1        | 4   | gw-b-joe-alfaro | temperature | 23.15 | no   | **yes**      |
  | B+2        | 1   | gw-b-joe-alfaro | power_draw  | 32.63 | no   | no           |
  | B+3        | 2   | gw-b-joe-alfaro | temperature | 36.52 | no   | no           |
  | B+4        | 3   | gw-a-joe-alfaro | temperature | 91.83 | no   | no           |
  | B+5        | 5   | gw-b-joe-alfaro | status      | 81.31 | no   | no           |

- **Current per metric:**

  | metric      | value                 | event_time | gateway         | seq |
  | ----------- | --------------------- | ---------- | --------------- | --- |
  | temperature | 91.83                 | B+4        | gw-a-joe-alfaro | 3   |
  | power_draw  | 32.63                 | B+2        | gw-b-joe-alfaro | 1   |
  | status      | 81.31                 | B+5        | gw-b-joe-alfaro | 5   |
  | vibration   | none (never reported) |            |                 |     |

- **Flags:** `late` is set on 0 readings. `out_of_order` is set on 1 reading (seq 4, temperature 23.15).
- **Device:** there is exactly one `trace-device-2493` record. Its status is `unregistered`, so it appears in the "New devices" inbox and not on the board until it is claimed. It was first seen via gw-a-joe-alfaro. Both gateways appear in `gateways`. About 30 s after the run, both gateways are stale because they have sent nothing since, so the device is shown as "possibly behind".
- **Re-running the trace against the same database** (run 2, with base `B2`) sends the same `(gateway, device, sequence)` triples with new `event_time`s, so the 4-part keys are new.
  - **History:** run 2 adds 6 new rows, for 12 in total. Its seq 5 resend is again 1 duplicate.
  - **Current:** each metric moves to run 2's reading: temperature 91.83 at B2+4, power_draw 32.63 at B2+2 and status 81.31 at B2+5. The values are the same as run 1's; the `event_time`s are run 2's.
  - **Flags:** the same in each run: 0 late, and out_of_order only on that run's seq 4.
  - **Run 2's seq 0** (temperature at B2+0) is not out of order relative to run 1's B1+4, provided the runs start more than 4 s apart.

## 1h vs 1min offline

**1 minute:** the gateway is stale after 30 s, so its devices show "possibly behind". The
backlog is stored in full on reconnect, and readings more than 30 s old are flagged
`late`. Current never regresses, and the badge clears with the next message.

**1 hour:** correctness holds, but freshness and latency break, in this order:

1. **The replay floods the shared queue.** An hour of backlog arrives as one request,
   message and transaction per reading, in the same FIFO queue as every healthy gateway's
   live data. Every device's dashboard lags until the backlog drains, including devices
   that were never offline. Fix: a batch endpoint, and a separate low-priority queue for
   readings already older than the threshold.
2. **Hour-old values are shown as current** for devices only that gateway reports. The
   only signal is "possibly behind".
3. **Nearly the whole backlog is flagged `late`,** so the flag becomes noise.
4. **The gateway's own buffer may overflow** upstream. That loss is invisible, because
   sequence gaps aren't evidence of loss.

## 10x gateways

The invariants rest on constraints and row locks, so they hold with any number of api or
consumer replicas. Concurrency changes only `out_of_order` flags.

- **api:** stateless, so add replicas. Batch readings per request to amortize the
  publisher confirms.
- **Consumer and Postgres:** competing consumers until Postgres is the limit (one
  transaction per reading; hot `current_state` rows). Next: multi-row inserts per message
  batch, queues sharded by device, `readings` partitioned by time with retention, and a
  `device_gateways` table instead of a `DISTINCT` over readings.
- **Live view:** every SSE event refetches both device lists. Next: per-device fetches or
  patch payloads, and paging.
- **Replays** happen 10× as often, so splitting backlog from live traffic matters more.
