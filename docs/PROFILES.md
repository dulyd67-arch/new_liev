# User profiles

Public profiles live at `/u/:username`. `/profile` requires sign-in and opens
the current member's public profile. The header and mobile account navigation
lead there, while private account settings remain at `/settings`.

The profile shows the public display name, username, biography and avatar,
active follower/following counts, a verified current livestream and completed
broadcast-session metadata. Followers and following open paginated public
lists. Completed sessions are history entries, not recorded videos. Suspended,
deleted and terminated content is excluded from the corresponding public lists.
No badges, audiences or earnings are invented.

## Profile editing and photos

Owners edit their display name, biography and photo through the authenticated
`PATCH /api/v1/users/me` route. That route binds writes to the current account,
keeps the user-first deletion lock order and audits changed field names without
copying the profile values or image into the audit event.

The browser accepts JPEG, PNG and WebP source files up to 2 MiB and encodes a
thumbnail no larger than 256 × 256. The API independently checks the media type,
canonical base64, image signatures, dimensions up to 512 × 512 and a decoded
size up to 48 KiB. SVG and arbitrary remote image URLs are rejected.

Small validated thumbnails use the existing `user_profiles.avatar_key` column.
This keeps photos persistent on the current free deployment without relying on
Render's temporary filesystem or introducing another storage service. Migration
`202611220001_profile_avatars` adds only an independent 65,560-byte storage cap
and the runtime role's permission to update that one additional column.

Public responses contain a versioned same-origin `avatarUrl`, not the image's
base64 data. The image endpoint returns the validated image type, `nosniff`,
restrictive content policy and `no-store`. Deleting the account clears its photo;
inactive accounts cannot serve a public avatar. The authenticated account export
still includes the owner's own profile data.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/users/:username` | Safe public profile and real counts |
| GET | `/users/:username/avatar` | Active account's validated image |
| GET | `/users/:username/followers` | Public follower page |
| GET | `/users/:username/following` | Public followed-account page |
| GET | `/users/:username/streams` | Completed session metadata |
| GET | `/streams?creatorId=:uuid` | Current verified media for one creator |
| GET / POST / DELETE | `/social/:id` / `/social/:id/follow` | Existing authenticated follow operations |
| PATCH | `/users/me` | Actor-bound editing and optional `avatarDataUrl` |

List endpoints accept an optional UUID `cursor` and `limit` from 1 through 20.
They expose `items` and `nextCursor` and exclude credentials, birth dates, email,
private location, roles and payment details. A `null` avatar update removes the
photo. Profile and account pages retain their existing search `noindex` defaults;
the public homepage's search configuration is unchanged.

## Verification

Use `.env.test.example`, local PostgreSQL, Redis and LiveKit, apply migrations,
seed the reference configuration and build the app. Run:

```sh
npm test
npm run db:test
npm run test:profile:integration
npm run test:profile:browser
```

The profile integration and browser scripts restrict fixture mutations to
loopback test deployments and clean up only their own accounts. Integration CI
uses a separate API process on port 4005 to avoid sharing registration throttles
with other feature suites. Browser verification covers owner editing, image
loading, real follow state and counts, public lists and Arabic/English layouts.

Visitor copy uses product language. Service availability, age, privacy and DU's
promotional non-cash status remain factual. The unused legacy module placeholder
component was removed; active live streaming, gift and PK modules remain in use.
