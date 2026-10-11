-- Gateway clock check rule 2: the gateway sent event_time with no UTC offset and the api appended
-- Z. Stored so a gateway sending local time can be detected; event_time itself is never corrected.
ALTER TABLE readings ADD COLUMN naive_time boolean NOT NULL DEFAULT false;

-- Rule 3: each gateway's clock is judged from its last 20 readings by received_at.
CREATE INDEX readings_gateway_received_at ON readings (gateway_id, received_at DESC);
