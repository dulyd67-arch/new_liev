# Live PK battles and hearts

Two broadcasters who are already LIVE can invite each other to a five-minute
PK round. The second broadcaster explicitly accepts or declines. Both keep
publishing to their own existing LiveKit rooms, and the split view subscribes
to the other broadcaster with the existing viewer-only token. An invitation
never grants publishing access to another room.

## User flow

1. Start two live streams from two separate accounts/devices.
2. In the Studio, press PK, choose an available live broadcaster and send the
   invitation. The recipient opens PK and accepts. Invitations expire after
   one minute, and a stream cannot join two pending/active rounds.
3. Both studios and viewers display host-left/guest-right video, a server-timed
   countdown and each side's actual gift score. Gift buttons on each half show
   the recipient before sending. Headphones help prevent audio feedback.

The 300-second round is timed by the database. Only real committed DU gifts
created within its start/end interval count. Each DU spent counts as one gift
point for that stream. Earlier/later gifts and likes do not change PK points.
The server persists the final scores and winner, or a tie for equal completed
scores. This remains the promotional DU system: no money, payouts or paid
purchase flow is introduced.

Leaving the PK round or explicitly ending a participating stream can forfeit
the round without stopping the other broadcaster's own publication. Confirmed
publisher disconnection uses a 15-second grace period; muted tracks remain
connected, and media-provider failures do not count as a confirmed departure.
If both publishers are unavailable, the round ends without inventing a winner.
Presence observation is bound to its battle ID, so an old observation cannot
finish a replacement round. Reconciliation is performed during polling; there
is no separate paid worker. A service restart safely restarts the absence grace.

## Likes

Signed-in members can tap the heart button. The animation responds to each
actual tap, while the displayed total comes from committed server events.
Taps are batched into requests of 1–20 likes. A request UUID is preserved on
ambiguous retries, preventing duplicate counting. The server enforces a limit
of 120 likes per account per minute across streams. Visitors can see totals
and sign in to interact. Likes create no DU credits or financial value.

## Source map

- `apps/api/src/battles/`: public snapshots and like totals; authenticated
  candidate discovery, invitations, actions and like batches.
- `packages/database/prisma/migrations/202611160001_live_pk_likes/`: PK state,
  slot exclusivity, real gift scoring, immutable results and like events. This
  also assigns new gift timestamps after their posting locks are acquired.
- `202611210001_pk_presence_settlement/`: scoped settlement for observed absent
  participants, including both absent and stale-observation protection.
- `apps/web/src/components/pk-controls.tsx`: invitations, controls, server clock
  and scoreboard. `live-likes.tsx` handles heart batches and feedback.
- `opponent-feed.tsx`: a separate, bounded subscribe-only media connection,
  filtered to the expected creator, with audio controls and cleanup.
- `studio-page.tsx`, `watch-page.tsx`, `gift-panel.tsx`: split-view integration,
  recipient-specific gifts and real event overlays for both streams.

Authenticated mutation routes are under `/api/v1`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/streams/:id/battle` | Current/latest battle and server time |
| GET | `/battles/invitations` | Your received invitations |
| GET | `/battles/candidates` | Available broadcasters actually publishing |
| POST | `/streams/:id/battles` | Invite with opponent stream and request UUID |
| POST | `/battles/:id/accept` | Invited broadcaster accepts |
| POST | `/battles/:id/decline` | Invited broadcaster declines |
| POST | `/battles/:id/cancel` | Inviter cancels a pending request |
| POST | `/battles/:id/leave` | Participating broadcaster leaves |
| GET / POST | `/streams/:id/likes` | Public total / authenticated batch |

Public GET snapshots can reconcile timeouts and finalize results. They cannot
invent scores, select winners or change participant identities. Runtime table
writes and private helper execution are restricted; narrow database functions
perform the transitions atomically. Blocks, unavailable accounts, stale stream
states and ownership are validated by the server/database. No client clock or
browser-submitted score is authoritative.

## Verification and operation

Use `.env.test.example` with local PostgreSQL, Redis and LiveKit, then migrate,
seed and build. Start the API on 4001 and Next on 3000 using that same trusted
local environment. Run:

```sh
npm run db:test
npm test
npm run test:pk:integration
npm run test:pk:browser
```

The integration scripts reject remote test endpoints. The browser regression
uses two ordinary accounts publishing actual local WebRTC tracks and a third
mobile viewer, tests both gift recipients and like persistence, and checks
round settlement plus media cleanup. Test camera frames are generated by the
browser's test device and are not production assets.

Production uses the existing LiveKit settings; no new API key or paid service
is required. A PK viewer opens two media connections, which count against the
provider's existing quotas. The hosting/media free plans do not imply unlimited
concurrent rounds. Cloud media must be tested from a normal phone/network when
the workspace browser's managed WebRTC policy prevents that path; keep that
policy intact.
