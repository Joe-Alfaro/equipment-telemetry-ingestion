-- Rule 1: a reading's identity is (gateway_id, device_id, metric, sequence, event_time). A gateway
-- sample carries several metrics under one sequence and event_time; under the 4-part key every
-- metric after the first was rejected as a conflict. A conflict is now the same 5-part key with a
-- different value. The new key is strictly looser than the old one, so existing rows satisfy it.

ALTER TABLE readings DROP CONSTRAINT readings_identity;
ALTER TABLE readings
  ADD CONSTRAINT readings_identity UNIQUE (gateway_id, device_id, metric, sequence, event_time);

-- Rule 4: event_time - processed_at > FUTURE_SKEW_MS. A flag only; computed by the consumer.
ALTER TABLE readings ADD COLUMN future boolean NOT NULL DEFAULT false;
