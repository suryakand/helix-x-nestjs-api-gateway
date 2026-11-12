-- Per-user narrowing: the service permissions an admin allowed a user in a tenant (principal_limits is the gateway's
-- one row per principal). NULL = no narrowing; the user's group bundle in Keycloak still sets the maximum.

ALTER TABLE principal_limits ADD COLUMN IF NOT EXISTS allowed_permissions text[];

-- Ledger: record this file. The runner replaces the placeholder checksum with the real sha256.
INSERT INTO gateway_schema_migrations (version, checksum, applied_by)
VALUES ('002_principal_allowed_permissions', 'self-recorded', current_user)
ON CONFLICT (version) DO NOTHING;
