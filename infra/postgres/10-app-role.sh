#!/usr/bin/env bash
set -euo pipefail

# Runs once for a NEW volume. The migration owner owns schema objects; the
# application role receives only the grants explicitly provided by migrations.
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE livestar_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'livestar_app')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO livestar_app', current_database())
\gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO livestar_app;
SQL
