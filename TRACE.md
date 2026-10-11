# Trace: --seed Joe-Alfaro

The full hand trace, with its timing derivation and the re-run analysis. [DESIGN.md](DESIGN.md#trace---seed-joe-alfaro) has the summary.

**Seed change.** An earlier version of this trace used `--seed joe-alfaro`. The seed is now exactly `Joe-Alfaro` (case-sensitive), because the brief asks for the "GitHub username" and that is its exact spelling. The generator seeds its random generator with the string itself, so the two seeds produce entirely different traces. The old trace and its results were dropped.

This prediction was written by hand **before** the trace was ever run. The `Joe-Alfaro` trace has not been sent to any system. The sequence was printed without sending, using a discard-port target and EOF at the confirmation prompt. The generator raised `EOFError` at `input()`, before its send loop:

```
python3 telemetry_generator.py --target http://127.0.0.1:9 --scenario trace --seed Joe-Alfaro < /dev/null
```

Printed sequence (verbatim):

```
your personalized trace scenario (seed=Joe-Alfaro), device=trace-device-8720:
 #  gateway        metric          value   event_time offset (s)
 0  gw-a-Joe-Alfaro power_draw      90.94                       0
 1  gw-a-Joe-Alfaro vibration       56.07                       4
 2  gw-b-Joe-Alfaro status          83.48                       1
 3  gw-b-Joe-Alfaro status          85.86                       2
 4  gw-b-Joe-Alfaro status          82.05                       3
 5  gw-b-Joe-Alfaro status          58.44                       5
 5  gw-b-Joe-Alfaro status          58.44                       5
```

All rows have device `trace-device-8720`. The `#` column is the `sequence` sent on the wire.

## Rules applied

- **Identity:** `(gateway_id, device_id, metric, sequence, event_time)`. Several metrics that share a sequence and an `event_time` are separate readings. Including `event_time` means a gateway that resets its sequence counter can't lose readings. A repeated key with the same value is a duplicate: no new history row, no state change and no flags. A repeated key with a different value is a conflict: the first copy is kept and the conflict is counted.
- **Current state:** kept per `(device_id, metric)`. A reading replaces it only if `(event_time, gateway_id, sequence)` is strictly greater than the stored reading's.
- **`late`:** set when `processed_at - event_time > 30 s`.
- **`out_of_order`:** set when the reading's `event_time` is older than the current `event_time` for its `(device, metric)` at processing time. The reading is still stored.
- **`future`:** set when `event_time - processed_at > 60 s` (`FUTURE_SKEW_MS`). It is only a flag: the reading is stored and applied to current state as normal.

## Timing

Let `B` be the generator's `base = now()`, taken just before printing. Reading `i` has `event_time = B + offset`. It is sent at about `B + 0.05·i` s because sends are 50 ms apart and `--yes` skips the prompt. Processing adds only a few milliseconds through the API, RabbitMQ and the consumer. So:

`lag = processed_at - event_time ≈ 0.05·i - offset` (plus milliseconds of pipeline delay)

Negative lag means the `event_time` is in the future when the reading is processed. The trace assumes the consumer processes messages in arrival order (single queue, FIFO).

## Step by step (arrival order)

| Step | seq        | gateway         | metric     | value | event_time | lag (approx.) | Result                                                                                                                                                                                                                                                                                                  | late         | out_of_order             | future       | Current after this step                                                  |
| ---- | ---------- | --------------- | ---------- | ----- | ---------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------ | ------------ | ------------------------------------------------------------------------ |
| 1    | 0          | gw-a-Joe-Alfaro | power_draw | 90.94 | B+0 s      | +0.00 s       | stored. First sighting: device `trace-device-8720` is created as `unregistered`, first seen via gw-a-Joe-Alfaro                                                                                                                                                                                         | no           | no (no prior power_draw) | no           | power_draw = **90.94** (gw-a, seq 0, B+0)                                |
| 2    | 1          | gw-a-Joe-Alfaro | vibration  | 56.07 | B+4 s      | −3.95 s       | stored                                                                                                                                                                                                                                                                                                  | no           | no (no prior vibration)  | no           | power_draw 90.94; vibration = **56.07** (gw-a, seq 1, B+4)               |
| 3    | 2          | gw-b-Joe-Alfaro | status     | 83.48 | B+1 s      | −0.90 s       | stored                                                                                                                                                                                                                                                                                                  | no           | no (no prior status)     | no           | power_draw 90.94; vibration 56.07; status = **83.48** (gw-b, seq 2, B+1) |
| 4    | 3          | gw-b-Joe-Alfaro | status     | 85.86 | B+2 s      | −1.85 s       | stored. B+2 > B+1, so it replaces status                                                                                                                                                                                                                                                                | no           | no                       | no           | power_draw 90.94; vibration 56.07; status = **85.86** (gw-b, seq 3, B+2) |
| 5    | 4          | gw-b-Joe-Alfaro | status     | 82.05 | B+3 s      | −2.80 s       | stored. B+3 > B+2, so it replaces status                                                                                                                                                                                                                                                                | no           | no                       | no           | power_draw 90.94; vibration 56.07; status = **82.05** (gw-b, seq 4, B+3) |
| 6    | 5          | gw-b-Joe-Alfaro | status     | 58.44 | B+5 s      | −4.75 s       | stored. B+5 > B+3, so it replaces status                                                                                                                                                                                                                                                                | no           | no                       | no           | power_draw 90.94; vibration 56.07; status = **58.44** (gw-b, seq 5, B+5) |
| 7    | 5 (resend) | gw-b-Joe-Alfaro | status     | 58.44 | B+5 s      | −4.70 s       | **duplicate**. The resend is byte-identical, so it has the same `event_time` (B+5). The key `(gw-b-Joe-Alfaro, trace-device-8720, status, 5, B+5)` already exists, so `ON CONFLICT DO NOTHING` applies. The value also matches, so this is a plain duplicate, not a conflict. The API still returns 202 | n/a (no row) | n/a (no row)             | n/a (no row) | unchanged                                                                |

Notes:

- **No reading is late.** The largest lag is that of seq 0, at about 0 s plus pipeline delay. That is far below 30 s. A reading would be flagged late only if the pipeline stalled for more than 30 s plus its offset, for example if the consumer were down during the run.
- **No reading is future.** Five of the six stored readings have future `event_time`s when they are processed, but the largest skew is about 4.75 s (seq 5), far below 60 s.
- **No reading is out of order.** The only metric reported more than once is status, and its four readings (seq 2–5) arrive in increasing `event_time` order: B+1, B+2, B+3, B+5. The trace's one out-of-order arrival is vibration's B+4 arriving second, but it is vibration's only reading, so there is nothing to compare it with.
- **`out_of_order` assumes FIFO processing.** The status readings are sent 50 ms apart. If the consumer's concurrent processing (prefetch 20) committed one of them after a newer status, that reading would be flagged `out_of_order` and would not change current state. Current state would still end at 58.44 (B+5), because it depends only on the set of stored readings.
- **The tie-break is never used.** No two readings for the same metric share an `event_time`.

## Final state

- **History:** 6 rows for `trace-device-8720`, one per seq 0–5. The resend added nothing and logged no conflict. Ordered by `event_time`, they are:

  | event_time | seq | gateway         | metric     | value | late | out_of_order | future |
  | ---------- | --- | --------------- | ---------- | ----- | ---- | ------------ | ------ |
  | B+0        | 0   | gw-a-Joe-Alfaro | power_draw | 90.94 | no   | no           | no     |
  | B+1        | 2   | gw-b-Joe-Alfaro | status     | 83.48 | no   | no           | no     |
  | B+2        | 3   | gw-b-Joe-Alfaro | status     | 85.86 | no   | no           | no     |
  | B+3        | 4   | gw-b-Joe-Alfaro | status     | 82.05 | no   | no           | no     |
  | B+4        | 1   | gw-a-Joe-Alfaro | vibration  | 56.07 | no   | no           | no     |
  | B+5        | 5   | gw-b-Joe-Alfaro | status     | 58.44 | no   | no           | no     |

- **Current per metric:**

  | metric      | value                 | event_time | gateway         | seq |
  | ----------- | --------------------- | ---------- | --------------- | --- |
  | power_draw  | 90.94                 | B+0        | gw-a-Joe-Alfaro | 0   |
  | vibration   | 56.07                 | B+4        | gw-a-Joe-Alfaro | 1   |
  | status      | 58.44                 | B+5        | gw-b-Joe-Alfaro | 5   |
  | temperature | none (never reported) |            |                 |     |

- **Flags:** `late` is set on 0 readings, `out_of_order` on 0 and `future` on 0.
- **Device:** there is exactly one `trace-device-8720` record. Its status is `unregistered`, so it appears in the "New devices" inbox and not on the board until it is claimed. It was first seen via gw-a-Joe-Alfaro. Both gateways appear in `gateways`. About 30 s after the run, both gateways are stale because they have sent nothing since, so the device is shown as "possibly behind".
- **Re-running the trace against the same database** (run 2, with base `B2`) sends the same `(gateway, device, metric, sequence)` tuples with new `event_time`s, so the 5-part keys are new.
  - **History:** run 2 adds 6 new rows, for 12 in total. Its seq 5 resend is again 1 duplicate.
  - **Current:** each metric moves to run 2's reading: power_draw 90.94 at B2+0, vibration 56.07 at B2+4 and status 58.44 at B2+5. The values are the same as run 1's; the `event_time`s are run 2's.
  - **Flags:** the same in each run: 0 late, 0 out_of_order and 0 future.
  - **Run 2's first status** (seq 2 at B2+1) is not out of order relative to run 1's B1+5, provided the runs start more than 4 s apart.

## Actual vs predicted

The prediction above was committed in `d7f8a67` before this run and is unchanged. Statements above that the trace "has not been sent" describe that point in time.

Run **once**, on 2026-10-11, against a `docker compose up --build` stack built from a fresh clone of the fix-round branch. Before the run, the stack had been used only for the clean, replay and race scenarios and the poison checks, so no other trace data was present:

```
python3 telemetry_generator.py --target http://localhost:8080 --scenario trace --seed Joe-Alfaro --yes
```

The generator printed the same sequence as above, then `sent.` Here B = 20:11:49.019098 UTC. Rows for `trace-device-8720` by `event_time` (times are the seconds past 20:11):

| event_time | seq | gateway         | metric     | value | received_at | processed_at | late | out_of_order | future |
| ---------- | --- | --------------- | ---------- | ----- | ----------- | ------------ | ---- | ------------ | ------ |
| 49.019098  | 0   | gw-a-Joe-Alfaro | power_draw | 90.94 | 49.031      | 49.032       | f    | f            | f      |
| 50.019098  | 2   | gw-b-Joe-Alfaro | status     | 83.48 | 49.140      | 49.140       | f    | f            | f      |
| 51.019098  | 3   | gw-b-Joe-Alfaro | status     | 85.86 | 49.195      | 49.196       | f    | f            | f      |
| 52.019098  | 4   | gw-b-Joe-Alfaro | status     | 82.05 | 49.250      | 49.250       | f    | f            | f      |
| 53.019098  | 1   | gw-a-Joe-Alfaro | vibration  | 56.07 | 49.085      | 49.086       | f    | f            | f      |
| 54.019098  | 5   | gw-b-Joe-Alfaro | status     | 58.44 | 49.303      | 49.305       | f    | f            | f      |

| What               | Predicted                                        | Actual                                                                                   | Match |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----- |
| History            | 6 rows, seq 0–5; the seq 5 resend is a duplicate | 6 rows, seq 0–5; no 7th row                                                              | yes   |
| Conflicts          | 0                                                | 0 in `reading_conflicts`                                                                 | yes   |
| Current power_draw | 90.94 (gw-a, seq 0, B+0)                         | 90.94 (gw-a-Joe-Alfaro, seq 0, B+0)                                                      | yes   |
| Current vibration  | 56.07 (gw-a, seq 1, B+4)                         | 56.07 (gw-a-Joe-Alfaro, seq 1, B+4)                                                      | yes   |
| Current status     | 58.44 (gw-b, seq 5, B+5)                         | 58.44 (gw-b-Joe-Alfaro, seq 5, B+5)                                                      | yes   |
| Temperature        | none                                             | no `current_state` row                                                                   | yes   |
| `late`             | 0                                                | 0 (largest lag 13 ms, seq 0)                                                             | yes   |
| `out_of_order`     | 0                                                | 0                                                                                        | yes   |
| `future`           | 0                                                | 0 (largest skew about 4.7 s, seq 5)                                                      | yes   |
| Device             | one `unregistered` record, first seen via gw-a   | one `unregistered` record, first seen via gw-a-Joe-Alfaro at 49.031                      | yes   |
| Gateways           | both recorded                                    | both recorded; gw-b's `last_seen_at` (49.366) is after the seq 5 row, from the duplicate | yes   |

**Result: the system matched the prediction exactly.** The read API (`GET /api/devices?status=unregistered`) showed the same three current values. The integration test `packages/db/src/scenarios.integration.test.ts` encodes this prediction, with fixed timestamps, and passes.
