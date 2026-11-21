# LiveStar database

Prisma 6/PostgreSQL is the authoritative domain schema. SQL migrations add checks,
append-only guards, accounting posting rules and least-privilege grants that cannot
be expressed in Prisma. Use **migrations**, never `prisma db push`, for application
environments: pushing the schema alone omits these financial protections.

`DATABASE_URL` is the restricted application connection; `DATABASE_MIGRATION_URL`
is the separate owner connection used only by migration/administration tasks. Keep
the latter out of the API and web process environments in production.

- `prisma/schema.prisma`: relational domain models and generated TypeScript types.
- `prisma/migrations`: versioned SQL, including database-enforced financial rules.
- `prisma/seed.ts`: idempotent reference configuration; never a user or money seed.
- `src/index.ts`: shared generated Prisma client exports.
- `test/pk.test.ts`: LIVE PK invitations, server-clock DU scores, gift-commit races,
  immutable results, persistent likes and per-user rate limits.
- `test/ledger.test.ts`: PostgreSQL integration fixtures; requires a dedicated test
  database, all migrations and the configuration seed.
- `test/auth.test.ts`: registration, consent, session/challenge, least-privilege and
  pseudonymization integration fixtures.
- `test/fixtures/phase1.schema.prisma`: immutable initial-schema snapshot, retained
  so later schema changes cannot silently rewrite the deployed initial migration.
- `test/test_schema_static.py`: offline schema/migration consistency checks.

The initial SQL migration was rendered offline with
`scripts/render-initial-migration.py` because package downloads were unavailable.
The renderer now reads the frozen Phase 1 snapshot; all later DDL uses a new Prisma
migration. On 2026-11-07, Prisma validation/client generation, all 24 PostgreSQL 17
integration tests and all 9 Python static checks passed. Re-run `npm run
db:validate`, `npm run db:generate`, migrations and `npm run db:test` against a
dedicated test database whenever the schema or financial/authentication rules change.
After the initial deployment, create subsequent migrations with Prisma; do not
regenerate or edit an applied migration.

Amounts use signed `BIGINT`, converted at API boundaries to decimal strings. Original
money uses currency-specific minor units and an explicit exponent. Functional
accounting uses millionths of USD (`USD_MICRO`). Foreign exchange snapshots use
`NUMERIC(30,12)` plus source and observation time. No JavaScript `number` conversion
is permitted for monetary calculations.

`LIVECOIN` and `USD_MICRO` are separate ledger books. Composite foreign keys prevent
cross-unit lines. Protected coin and creator liability accounts cannot go negative.
The balance stored on each account is a transactional projection of its immutable
ledger lines; financial operations must use the posting function supplied by SQL
migrations. Correction is an offsetting journal, never editing a posted line.

Purchased coin lots retain their real payment settlement attribution. Gift allocations
record how much settled net proceeds each consumed lot contributed. A gift snapshots
the selected revenue policy, quantity, coin price and creator/platform amounts, so
later catalog or policy changes cannot rewrite historical economics. Purchased coins
are consumable platform credits, not withdrawable USD. Only released creator proceeds
can fund a payout.

## Authentication data boundaries

The authentication migration adds hashed single-use `AuthChallenge` records and
separates `WEB` and `MOBILE` refresh sessions. Session rotation cannot change the
owner, family or channel, and revocation/challenge consumption cannot be undone.

`register_user(uuid,text,text,text,text,date,text,text,text)` is the only application
registration path. It normalizes identity, records adult self-attestation and
terms/privacy consent, creates the profile, and assigns exactly the seeded `USER`
role. A supplied date of birth never sets external `age_verified_at` evidence.

The runtime can update only the authentication/profile columns granted by the
migration; it cannot insert users directly, change role membership/status or write
financial records. These grants are for the trusted API service across rows. The
API must still bind every operation to its authenticated subject and check RBAC.

`request_account_deletion(uuid)` immediately marks the user `DELETION_PENDING`,
pseudonymizes email/profile, clears the password and self-attested birth date,
revokes all sessions and consumes outstanding challenges. Stable user IDs and
existing financial/audit foreign keys survive. Consent versions/timestamps and
legally retained records remain pending a documented retention/erasure process;
the function does not claim to erase backups, external KYC systems or all retained
data. Coin-wallet identity is immutable even to future financial worker updates.

PII deletion must retain pseudonymized user IDs for financial foreign keys. KYC data
is limited to external provider references and status; identity documents and banking
credentials do not belong in these tables. Never store provider secrets in JSON
settings, audit payloads or outbox events.


## LIVE PK and likes

`pk_invite(actor,host_stream,guest_stream,idempotency_uuid,duration_seconds)`
reserves two existing LIVE streams, with a 60-second invitation and a server-owned
180- or 300-second battle. `pk_respond(actor,battle,action)` accepts `ACCEPT`,
`DECLINE`, `CANCEL` or `LEAVE`. The API must bind the actor to its authenticated
subject and verify both real publishers before inviting or accepting.
`pk_snapshot(stream)` lazily expires invitations and freezes completed results;
`pk_settle_stream(stream)` cancels invitations or forfeits active battles when a
host departs. An early departure awards the available peer the win; both hosts
unavailable or a block produces no winner. A completed timer uses the higher DU
score, with a null winner for a tie. Final results and participant identities
cannot be rewritten.

Scores sum only committed negative `GIFT` amounts in `du_transactions`, for the
matching stream and creator, from `starts_at` inclusive to `ends_at` exclusive.
Early settlement also caps the scoring window at settlement time. PK functions
serialize both streams' DU advisory locks before freezing scores; gift timestamps
use the wall clock after their locks, so a transaction opened before the deadline
cannot backdate a late gift. PK functions serialize reservations across both host
and guest roles, lock users before stream rows, and must run in their own API
transaction without previously held user or stream row locks. No cron is required.

`stream_send_likes(actor,stream,count,idempotency_uuid)` persists batches of 1–20
likes, with at most 120 likes per actor in a rolling server-clock minute across
all streams. A matching retry returns its original event without consuming the
quota again; a reused key with a different stream or count raises a tagged domain
error. Totals are exact decimal strings from `sum(count::numeric)`. Both tables
are read-only to `livestar_app`; only the restricted RPCs can write them. PK and
likes never create payments, earnings, financial wallets or redeemable balances.
