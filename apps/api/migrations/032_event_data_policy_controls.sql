ALTER TABLE event_data_policies
  DROP CONSTRAINT IF EXISTS event_data_policies_retention_days_allowed;

ALTER TABLE event_data_policies
  ADD CONSTRAINT event_data_policies_retention_days_allowed
  CHECK (retention_days IN (30, 60, 90, 180, 365));
