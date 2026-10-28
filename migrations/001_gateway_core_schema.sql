-- Gateway schema: usage limits per principal (principal_limits), metering (usage_logs raw, usage_daily rollup) and
-- the admin audit trail (admin_audit). Everything else about access (tenants, users, clients, permissions) lives in
-- Keycloak. Constraint names follow TypeORM's, so a database built by TypeORM is adopted as it is.

-- gen_random_uuid() is built into postgres 13+.
CREATE TABLE IF NOT EXISTS principal_limits (
  id               uuid         NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid         NOT NULL,
  principal_type   varchar(8)   NOT NULL,
  principal_key    varchar(255) NOT NULL,
  rate_limit_type  varchar(16)  NOT NULL DEFAULT 'UNLIMITED',
  rate_limit_value integer,
  fixed_used       integer      NOT NULL DEFAULT 0,
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "PK_f813181586c613e364b27b572a4" PRIMARY KEY (id),
  CONSTRAINT uq_principal_limits UNIQUE (tenant_id, principal_type, principal_key),
  CONSTRAINT chk_principal_limits CHECK (rate_limit_type = 'UNLIMITED' OR rate_limit_value > 0)
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id              bigserial    NOT NULL,
  ts              timestamptz  NOT NULL,
  tenant_id       uuid,
  auth_type       varchar(8),
  method          varchar(8)   NOT NULL,
  endpoint        varchar(200) NOT NULL,
  path            varchar(500) NOT NULL,
  response_status smallint     NOT NULL,
  duration_ms     integer      NOT NULL,
  client_ip       inet,
  principal_type  varchar(8),
  principal_key   varchar(255),
  principal_label varchar(255),
  CONSTRAINT "PK_38ed6efac407c7a3f818d90c279" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant_ts ON usage_logs (tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_principal ON usage_logs (tenant_id, principal_type, principal_key, ts);

CREATE TABLE IF NOT EXISTS usage_daily (
  day             date         NOT NULL,
  tenant_id       uuid         NOT NULL,
  endpoint        varchar(200) NOT NULL,
  request_count   integer      NOT NULL DEFAULT 0,
  error_count     integer      NOT NULL DEFAULT 0,
  principal_type  varchar(8)   NOT NULL,
  principal_key   varchar(255) NOT NULL,
  principal_label varchar(255),
  CONSTRAINT "PK_ff6fa455c8d3a74e5c3018d705d" PRIMARY KEY (day, tenant_id, endpoint, principal_type, principal_key)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_tenant_day ON usage_daily (tenant_id, day);

CREATE TABLE IF NOT EXISTS admin_audit (
  id          bigserial    NOT NULL,
  ts          timestamptz  NOT NULL DEFAULT now(),
  actor_key   varchar(255) NOT NULL,
  actor_label varchar(255) NOT NULL,
  tenant_id   uuid,
  action      varchar(64)  NOT NULL,
  target      varchar(255),
  detail      jsonb,
  CONSTRAINT "PK_5ad48a4d9d16397ef37e28bb0be" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant_ts ON admin_audit (tenant_id, ts);

-- Ledger: record this file. The runner replaces the placeholder checksum with the real sha256.
INSERT INTO gateway_schema_migrations (version, checksum, applied_by)
VALUES ('001_gateway_core_schema', 'self-recorded', current_user)
ON CONFLICT (version) DO NOTHING;
