# DU wallet and LIVE gifts

DU is LiveStar's **virtual, promotional gift coin**, not a cryptocurrency,
payment receipt, USD balance, or creator payout. Nothing in this release buys,
redeems, or transfers money. Every new member begins with a zero balance and
may explicitly claim **100 free DU once per account**. No repeated faucet or
arbitrary credit endpoint is exposed. Creating another account is not a paid
purchase and creates no eligible gift revenue.

## Using the feature

Open `/wallet`, sign in, and press the welcome-coin button if eligible. During
someone else's LIVE, open the gift button, choose a gift and quantity, then
confirm the displayed DU total. The balance changes only after the server
commits the operation. The creator sees the actual gift and its animation.
Received-gift counters show audience appreciation, not spendable DU or money.
The wallet includes the member's own immutable claim and spending history.

| Gift | DU each |
| --- | ---: |
| Rose 🌹 | 1 |
| Heart 💖 | 5 |
| Coffee ☕ | 10 |
| Applause 👏 | 15 |
| Star ⭐ | 25 |
| Butterfly 🦋 | 35 |
| Crown 👑 | 50 |
| Fire 🔥 | 75 |
| Rocket 🚀 | 100 |
| Diamond 💎 | 250 |
| Galaxy 🌌 | 500 |
| Lion 🦁 | 1,000 |

Gifts above the available balance cannot be sent. Purchasing additional DU
is disabled until a real payment provider and its verified settlement flow
are implemented. There are no simulated purchases presented as successful.

## Server and database

- `apps/api/src/du/`: authenticated wallet, claim, history, catalog and gift APIs.
- `apps/api/src/social/`: persisted follow/unfollow and content reports.
- `packages/database/prisma/migrations/202611150001_du_promotional_wallet/`:
  additive DU schema, twelve gifts, posting functions, integrity triggers and
  scoped runtime grants.
- `202611150002_du_error_contract/`: preserves the first migration and adjusts
  explicit domain errors to survive Prisma's error normalization.
- `apps/web/src/components/wallet-page.tsx`: wallet and history.
- `gift-panel.tsx`: gift picker, replay-safe retries and committed-event feed.
- `watch-page.tsx`: full-viewport video, overlay comments, gifts, sharing,
  real follow/report actions and native fullscreen where supported.

REST paths under `/api/v1`:

| Method | Path | Access |
| --- | --- | --- |
| GET | `/wallet` | Own account |
| GET | `/wallet/history?before=<sequence>` | Own account, paginated |
| POST | `/wallet/claim` | Own account, one-time grant |
| GET | `/gifts` | Public catalog |
| POST | `/streams/:id/gifts` | Authenticated sender |
| GET | `/streams/:id/gifts?after=<sequence>` | Public live gift events |
| GET | `/social/:userId` | Own follow state |
| POST / DELETE | `/social/:userId/follow` | Own follow relation |
| POST | `/streams/:id/report` | Authenticated reporter |

Claim bodies contain a UUID `idempotencyKey`. Sending also requires `giftId`
and integer `quantity` from 1 to 99. Reusing a key with a different request
returns HTTP 409. A successful replay returns the original transaction.
Amounts and cursors use decimal strings throughout the API and BigInt in the UI.

Posting functions serialize each sender's request keys, lock active users
before streams, and serialize each stream's gift sequence. A committed gift
debits the sender and records its balance and snapshotted unit price in one
transaction. Negative balances, overspending, self-gifts, ended streams and
blocked accounts are rejected. Initial polling establishes a current cursor;
opening a stream never animates all its old gifts again.

The trusted API supplies the authenticated user ID; database credentials are
server-only. `livestar_app` can read DU rows and invoke the specific posting
functions, but cannot update wallet balances, insert/delete transactions, edit
the catalog or invoke the dormant paid ledger. Audit history is append-only
and retained across account pseudonymization. DU and the legacy fiat ledger
have no transfer path between them.

Animations and queues are bounded, respect reduced motion, and are triggered
by committed server events. Picker portals follow the native fullscreen host.
Timed-out submissions retain their idempotency key for a safe retry.

## Verification

Use only an isolated local database and local media server:

```sh
set -a
source .env.test.example
set +a
npm run db:migrate
npm run db:seed
npm run build
npm run db:test
npm test
```

Start the test API on port 4001 and the production Next server on port 3000
with the same trusted local environment, then run:

```sh
npm run test:du:integration
npm run test:du:browser
```

The integration tests require loopback endpoints and a database name containing
`test`; they never create cloud fixtures. They exercise ordinary authentication,
restricted-role database behavior, claims, exact debits, replay conflicts,
overspend races, blocks, history privacy, follows and reports. The browser
test publishes real local audio/video and tests mobile AR/EN wallet and gifts,
fullscreen modals, creator delivery and stopping the actual stream.

Apply the additive migrations through the existing deployment startup. Never
run test scripts against the public database, rewrite applied migration
checksums, or expose owner credentials to the API or browser.
