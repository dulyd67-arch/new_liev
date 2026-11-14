# Backup and restore templates

These scripts are runnable operator tools, not an installed backup service.
Install PostgreSQL 17 client tools and `age` on a restricted backup host.
Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and a protected `PGPASSFILE` or
secret-injected `PGPASSWORD`. Do not put credentials in command arguments.

`BACKUP_AGE_RECIPIENT` is the public encryption key. Keep its private identity
outside the database host. `BACKUP_DIRECTORY` defaults to `./backups`.
Run `bash infra/backup/backup.sh`; optionally configure `BACKUP_S3_URI` and an AWS
identity for an external copy. Failure to upload returns nonzero and must alert.
The local encrypted backup remains available after an upload failure.

Schedule the command in your infrastructure scheduler (for example daily),
monitor its exit status, configure immutable external retention, and periodically
restore to a separate empty database. This repository does not configure those
operator-specific services. For a production RPO below one day, provision
continuous WAL archiving and point-in-time recovery separately.

For restore, create an empty database owned by the migration owner and precreate
the restricted `livestar_app` role. Set the target PG variables and
`BACKUP_AGE_IDENTITY=/secure/path/age-identity`, then run
`bash infra/backup/restore.sh /path/backup.dump.age`. Restore uses one transaction,
refuses existing tables, and preserves ACLs; the restoring role becomes the
object owner. Do not serve traffic until ledger balance, row counts and
application readiness have been verified. An untested backup is not recovery.
