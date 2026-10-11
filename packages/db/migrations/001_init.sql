-- Full schema. The invariants live here as constraints; see DESIGN.md.

CREATE TABLE gateways (
  gateway_id    text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL
);

-- Invariant 3: the primary key collapses concurrent first sightings into one row.
CREATE TABLE devices (
  device_id             text PRIMARY KEY,
  status                text NOT NULL DEFAULT 'unregistered'
                        CHECK (status IN ('unregistered', 'registered')),
  name                  text,
  first_seen_at         timestamptz NOT NULL,
  first_seen_gateway_id text NOT NULL,
  claimed_at            timestamptz,
  CHECK (
    (status = 'unregistered' AND claimed_at IS NULL)
    OR (status = 'registered' AND claimed_at IS NOT NULL AND name IS NOT NULL)
  )
);

-- Invariant 1: one row per (gateway_id, device_id, sequence), however often it is resent.
CREATE TABLE readings (
  id           bigserial PRIMARY KEY,
  gateway_id   text NOT NULL,
  device_id    text NOT NULL REFERENCES devices (device_id),
  sequence     bigint NOT NULL,
  metric       text NOT NULL,
  value        double precision NOT NULL,
  event_time   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  late         boolean NOT NULL DEFAULT false,
  out_of_order boolean NOT NULL DEFAULT false,
  CONSTRAINT readings_identity UNIQUE (gateway_id, device_id, sequence)
);

CREATE INDEX readings_device_event_time_idx ON readings (device_id, event_time);
CREATE INDEX readings_device_gateway_idx ON readings (device_id, gateway_id);

-- Same identity as an existing reading but a different payload: the first copy is kept
-- in readings and the rejected copy is recorded here.
CREATE TABLE reading_conflicts (
  id          bigserial PRIMARY KEY,
  gateway_id  text NOT NULL,
  device_id   text NOT NULL,
  sequence    bigint NOT NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reading_conflicts_identity_idx ON reading_conflicts (gateway_id, device_id, sequence);

-- Invariant 2: one row per (device_id, metric), replaced only by a strictly greater
-- (event_time, gateway_id, sequence).
CREATE TABLE current_state (
  device_id  text NOT NULL REFERENCES devices (device_id),
  metric     text NOT NULL,
  value      double precision NOT NULL,
  event_time timestamptz NOT NULL,
  gateway_id text NOT NULL,
  sequence   bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, metric)
);
