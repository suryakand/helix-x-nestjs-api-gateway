-- Ledger of the gateway's own schema migrations, kept apart from the product's schema_migrations (one row per file in this folder, version = file name minus .sql).
-- Written by `npm run db:migrate` and by the boot-time runner (DB_MIGRATIONS_RUN); every file also inserts
-- its own row, so a file run by hand with psql still leaves one. Never edit or renumber an applied file.
CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
  version    varchar(255) PRIMARY KEY,
  -- sha256 of the file; 'self-recorded' until the runner replaces it with the real one.
  checksum   varchar(64)  NOT NULL,
  applied_at timestamptz  NOT NULL DEFAULT now(),
  applied_by varchar(255) NOT NULL DEFAULT current_user
);

-- Ledger: record this file. The runner replaces the placeholder checksum with the real sha256.
INSERT INTO gateway_schema_migrations (version, checksum, applied_by)
VALUES ('000_create_gateway_schema_migrations', 'self-recorded', current_user)
ON CONFLICT (version) DO NOTHING;
