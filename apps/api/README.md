# LiveStar API — Phase 2

NestJS API for real account registration, authentication, refresh rotation, password
recovery, email verification, own profiles and privacy requests. Streaming,
purchases, gift spending and payouts remain disabled until their phases pass.

Run from the repository root after migrations, seed and Prisma generation:

```sh
npm run build
npm run start:api
npm run test --workspace=@livestar/api
```

OpenAPI: `/api/docs` and `/api/openapi.json`. Implemented routes:

| Method | Path under `/api/v1` | Authentication / behavior |
| --- | --- | --- |
| GET | `/health/live`, `/health/ready`, `/platform` | Process/dependency health and actual enabled scope |
| POST | `/auth/register`, `/auth/login` | Trusted Origin required; refresh token in HttpOnly cookie only |
| POST | `/auth/refresh` | Trusted Origin plus refresh cookie; atomic rotation |
| POST | `/auth/logout` | Bearer plus trusted Origin; revoke device family, clear cookie |
| POST | `/auth/mobile/register`, `/auth/mobile/login` | Explicit MOBILE transport; refresh token returned for secure native storage |
| POST | `/auth/mobile/refresh` | JSON `refreshToken`; WEB tokens are rejected |
| POST | `/auth/mobile/logout` | Bearer; revoke device family |
| GET | `/auth/me` | Bearer; current actor and database-derived permissions |
| POST | `/auth/password/forgot`, `/auth/email/resend` | JSON `email`; generic 202 response |
| POST | `/auth/password/reset` | JSON one-use `token`, new `password`; revoke all sessions |
| POST | `/auth/email/verify` | JSON one-use `token`; mark actual email verification |
| GET/PATCH/DELETE | `/users/me` | Bearer; own profile / narrow updates / password-confirmed deletion request |
| GET | `/users/me/export` | Bearer; own identity, profile, consents and follows; no credential hashes |
| GET | `/users?query=star&limit=20`, `/users/:username` | Public active profile fields only |

Web registration JSON:

```json
{
  "email": "creator@example.com",
  "password": "a-long-unique-passphrase",
  "username": "creator_name",
  "displayName": "Creator Name",
  "birthDate": "1995-06-15",
  "locale": "ar",
  "termsVersion": "2026-11-07",
  "privacyVersion": "2026-11-07",
  "acceptTerms": true,
  "acceptPrivacy": true
}
```

Usernames start with a letter and use letters, digits or underscores (3–32).
Passwords are 12–128 characters. Age is self-attested at registration, minimum18;
`ageVerifiedAt` is never set by self-attestation. Server records consent times
and assigns only the seeded USER role. Extra privilege fields are rejected.

Login JSON contains `email,password`. Auth success returns `accessToken`,
`expiresIn:900`, and safe `user` fields. Registration also returns `emailDelivery`
(`sent` or `unavailable`). Only MOBILE transport returns `refreshToken` in JSON.
Web cookie `livestar_refresh` is HttpOnly, SameSite Strict, path `/api/v1/auth`,
and Secure in production. Web clients use `credentials:'include'`; all
cookie-sensitive POSTs require an exact `Origin` from `WEB_ORIGIN`. Native
clients use mobile routes and secure platform credential storage. All private
profile calls use `Authorization: Bearer <accessToken>`.

Refresh tokens are random256-bit values stored as SHA-256 hashes. Rotation
preserves the family's absolute30-day expiry; replay commits family revocation
before returning401. Clients must serialize refresh requests to avoid treating
legitimate concurrent refreshes as replay. Access JWTs carry sub/sid/issuer/
audience and expire in15minutes. Every bearer request checks the current active
session, active user and database roles; stale claims cannot grant permissions.

Passwords use async salted scrypt N131072/r8/p1 with a64-byte derived key. At
most two hash operations run per API process; excess work returns503. Auth
routes have tighter request limits than general endpoints. Process-local limits
must become shared Redis-backed limits before multi-replica production use.

Email verification and password reset tokens are one-use random256-bit values,
stored only hashed and valid30minutes. Links are delivered by SMTP; the token
is in a URL fragment (`/verify-email#token=...` or `/reset-password#token=...`),
which the Phase3 client must read and remove from browser history. Tokens never
appear in API responses or application logs. Local Mailpit captures actual SMTP
messages on port1025, with its developer UI on8025. Failed delivery can be
retried through resend/recovery endpoints. Delivery is best-effort in this
phase; durable retries and operational alerting are deployment work.

Deletion requires `DELETE /users/me` with JSON `{ "password": "..." }`.
The SQL function pseudonymizes account/profile data, clears credentials, revokes
sessions, consumes challenges and marks DELETION_PENDING. Required financial
and audit references remain; this is not a promise to erase retained records
immediately. Export currently covers the implemented identity domain only;
financial and streaming exports are added with those modules.

Environment settings:

- `DATABASE_URL`, `REDIS_URL`: required real service URLs. Runtime uses the
  restricted application role; never pass migration credentials to this process.
- `JWT_SECRET`: at least32 bytes, required in production. Development can use an
  ephemeral per-process secret if omitted; restarts then invalidate access JWTs.
- `JWT_ISSUER`, `JWT_AUDIENCE`: defaults `livestar`, `livestar-clients`.
- `WEB_ORIGIN`: comma-separated exact allowed origins; never wildcard.
- `APP_PUBLIC_URL`: email-link origin, HTTPS required in production.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, optional paired `SMTP_USER/SMTP_PASSWORD`.
  Production requires explicit SMTP host and TLS (465 or STARTTLS).
- `PORT` defaults4000, `API_HOST` defaults0.0.0.0.

Readiness checks real PostgreSQL and Redis, responds503 on dependency failure,
and recovers when services return. Liveness does not probe dependencies.
Shutdown closes Prisma, Redis and SMTP. DTO validation explicitly supplies its
type so both tsc production builds and tsx development enforce the same rules.
