#!/usr/bin/env bash
set -euo pipefail
umask 077

# Restore into a separately created EMPTY database owned by the migration user.
# Do not point PGDATABASE at an active production database.
: "${PGDATABASE:?PGDATABASE required}"
: "${PGUSER:?PGUSER required}"
: "${BACKUP_AGE_IDENTITY:?path to an age private identity is required}"
[[ $# -eq 1 && -f "$1" ]] || { echo 'Usage: restore.sh backup.dump.age' >&2; exit 1; }
command -v age >/dev/null
command -v pg_restore >/dev/null
restore_existing="$(psql -XAt --no-password --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S');")"
[[ "$restore_existing" == 0 ]] || { echo 'Restore refused: target public schema is not empty.' >&2; exit 1; }
restore_temporary="$(mktemp -d)"
trap 'rm -rf "$restore_temporary"' EXIT
age --decrypt --identity "$BACKUP_AGE_IDENTITY" --output "$restore_temporary/database.dump" "$1"
pg_restore --single-transaction --exit-on-error --no-owner --no-password "$restore_temporary/database.dump"
printf 'Restore completed. Verify journal reconciliation before serving traffic.\n'
