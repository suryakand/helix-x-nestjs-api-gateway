-- SQLite twin of ../003_usage_billed_units.sql.

ALTER TABLE "usage_logs" ADD COLUMN "billed_units" integer NOT NULL DEFAULT 0;
ALTER TABLE "usage_daily" ADD COLUMN "billed_count" integer NOT NULL DEFAULT 0;

-- Ledger: record this file. The runner replaces the placeholder checksum with the real sha256.
INSERT INTO gateway_schema_migrations (version, checksum, applied_by)
VALUES ('003_usage_billed_units', 'self-recorded', 'sqlite')
ON CONFLICT (version) DO NOTHING;
