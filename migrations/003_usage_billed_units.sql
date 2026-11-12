-- Billed units per call, separate from the call count: on routes metered 'upstream' the upstream says what a call
-- cost (0 for a cached answer), on 'none' routes nothing is billed. usage_logs keeps each call's units, usage_daily
-- the sum next to request_count / error_count.

ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS billed_units int NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS billed_count int NOT NULL DEFAULT 0;

-- Ledger: record this file. The runner replaces the placeholder checksum with the real sha256.
INSERT INTO gateway_schema_migrations (version, checksum, applied_by)
VALUES ('003_usage_billed_units', 'self-recorded', current_user)
ON CONFLICT (version) DO NOTHING;
