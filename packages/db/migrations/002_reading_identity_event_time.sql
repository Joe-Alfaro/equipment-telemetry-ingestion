-- Decision e2: a reading's identity includes event_time. With the 3-part key, a gateway whose
-- sequence counter resets (or a re-run of the seeded trace) would have new readings rejected as
-- conflicts. Real resends are byte-identical, so they still collapse under the 4-part key.
-- The new key is strictly looser than the old one, so existing rows always satisfy it.

ALTER TABLE readings DROP CONSTRAINT readings_identity;
ALTER TABLE readings
  ADD CONSTRAINT readings_identity UNIQUE (gateway_id, device_id, sequence, event_time);
