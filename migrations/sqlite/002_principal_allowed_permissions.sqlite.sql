-- SQLite twin of ../002_principal_allowed_permissions.sql. text[] → JSON text (simple-json), NULL = no narrowing.

ALTER TABLE "principal_limits" ADD COLUMN "allowed_permissions" text;

-- Ledger: record this file. The runner replaces the placeholder checksum with the real sha256.
INSERT INTO gateway_schema_migrations (version, checksum, applied_by)
VALUES ('002_principal_allowed_permissions', 'self-recorded', 'sqlite')
ON CONFLICT (version) DO NOTHING;
