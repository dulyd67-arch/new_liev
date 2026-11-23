# Platform administration

`/admin` is an authenticated console for active `ADMIN` and `SUPER_ADMIN`
accounts. The header and the owner's profile show an administration link only
for these roles. Anonymous visitors receive the ordinary sign-in gate; members
and moderators do not receive dashboard data.

Both the HTTP guard and the narrow mutation functions check authorization.
Authentication reads the current account, session and roles from PostgreSQL;
client-side navigation and role claims alone do not grant administrator access.
There is no public role-assignment or administrator-registration endpoint, no
default password, and no email allowlist that elevates future registrations.

Initial owner access is an operator-only assignment to an existing active
account. The assignment is audited and existing sessions are revoked when the
privilege changes, requiring a normal sign-in with the account's existing
password. Owner identity is not embedded in application source or migrations.

## Dashboard data

The console contains real account totals, seven-day registration counts,
stored open broadcast-session counts, report queues, and promotional DU gift
activity. Open-session totals do not claim that every publisher is connected.
Each stream row obtains bounded, actual media-provider presence information;
unavailable observations use an unknown state and a null viewer count.

User lists include only fields needed for administration. Passwords, birth
dates, session and verification tokens, private location and payment records
are excluded. Audit pages expose only `ADMIN_*` events and an allowlisted
operation payload. Report text is rendered as text rather than executable HTML.

DU activity remains non-cash and promotional. Purchases, withdrawals, payment
providers and cash revenue are not enabled by this console.

## Actions and failure behavior

All actions require a reason and an idempotency UUID bound to the actor, target
and request body. Repeating the same operation does not duplicate its effects;
reusing its identifier for another target or decision is rejected. Terminal
report decisions cannot be overwritten. Existing audit records are immutable.

Suspension commits the account state and session revocations atomically, then
attempts to stop the account's remaining media rooms. Provider failures leave
the account suspended and return the outstanding cleanup explicitly. The UI
offers a retry and does not claim that media stopped when cleanup failed.
Restoration is blocked while open sessions remain and never revives revoked
sessions. Administrators cannot suspend themselves or another staff account.

Stream termination first reserves an immutable stop request in PostgreSQL.
This binds concurrent retries before provider I/O, so a conflicting key cannot
delete an unrelated room. The API then deletes the actual LiveKit room, settles
PK outside user-row transactions, and commits `TERMINATED` with moderation and
audit records. Failures remain retryable. A database trigger prevents stale
owner operations from changing a terminated status or its end time.

Completing a report records its decision; it does not implicitly stop a stream.
An independent stop action remains available for an associated open stream.
Room deletion stops the current broadcast and the API refuses new credentials
for closed or suspended accounts. Already-issued media credentials retain the
provider's existing token-expiry semantics; this is not a new global JWT
revocation service.

## API and database

Read endpoints are `/admin/overview`, `/admin/users`, `/admin/streams`,
`/admin/reports` and `/admin/audit`. Lists use bounded cursor pagination.

Mutation endpoints are:

- `POST /admin/users/:id/suspend`
- `POST /admin/users/:id/restore`
- `POST /admin/streams/:id/terminate`
- `PATCH /admin/reports/:id`

Migration `202611220002_platform_admin` grants the application role only three
administration functions: `admin_set_user_status`, `admin_terminate_stream` and
`admin_review_report`. Actor/request and actor-lock helpers stay private. No
raw user-status, role-assignment or report-update privileges are added.

## Verification

Use the trusted loopback `.env.test.example` setup, migrate, seed and build.
Run the API and database suites, followed by:

```sh
npm run test:admin:integration
npm run test:admin:browser
```

Restart the local API between these two suites so their disposable account
registrations do not share a registration-rate window.

Integration CI uses its own API process on port 4007 so other feature suites do
not share its registration-rate bucket. Fixtures create ordinary accounts,
assign staff roles only within the isolated local test database, and clean up
their own identities without rewriting audit evidence. Media tests use owned
local LiveKit rooms. Public deployment checks are anonymous and read-only;
they do not create production staff, reports, streams or moderation events.
