-- SQLite twin of ../000_create_gateway_schema_migrations.sql (same versions, so both ledgers use the same names).
-- applied_at is ISO-8601 text.
CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
  version    varchar(255) PRIMARY KEY NOT NULL,
  checksum   varchar(64)  NOT NULL,
  applied_at varchar(40)  NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  applied_by varchar(255) NOT NULL DEFAULT ('sqlite')
);

-- Ledger: record this file. The runner replaces the placeholder checksum with the real sha256.
INSERT INTO gateway_schema_migrations (version, checksum, applied_by)
VALUES ('000_create_gateway_schema_migrations', 'self-recorded', 'sqlite')
ON CONFLICT (version) DO NOTHING;
