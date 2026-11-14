#!/usr/bin/env bash
set -euo pipefail
umask 077

# PostgreSQL 17 client, age and PG* connection variables are required. Supply
# PGPASSWORD through a secret manager or use a protected PGPASSFILE.
: "${PGDATABASE:?PGDATABASE required}"
: "${PGUSER:?PGUSER required}"
: "${BACKUP_AGE_RECIPIENT:?an age public recipient is required}"
command -v pg_dump >/dev/null
command -v age >/dev/null
backup_directory="${BACKUP_DIRECTORY:-./backups}"
mkdir -p "$backup_directory"
backup_temporary="$(mktemp -d)"
trap 'rm -rf "$backup_temporary"' EXIT
backup_name="livestar-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump.age"
pg_dump --format=custom --no-password --file="$backup_temporary/database.dump"
age --recipient "$BACKUP_AGE_RECIPIENT" \
  --output "$backup_temporary/database.dump.age" "$backup_temporary/database.dump"
mv "$backup_temporary/database.dump.age" "$backup_directory/$backup_name"

# Optional external encrypted copy using the operator's configured AWS identity.
# No static cloud credentials belong in this repository.
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  [[ "$BACKUP_S3_URI" == s3://* ]] || { echo 'BACKUP_S3_URI must start with s3://' >&2; exit 1; }
  aws s3 cp "$backup_directory/$backup_name" "${BACKUP_S3_URI%/}/$backup_name" \
    --only-show-errors --sse AES256
fi
printf 'Encrypted backup created: %s\n' "$backup_directory/$backup_name"
