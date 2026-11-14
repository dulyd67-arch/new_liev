# Exact accounting arithmetic

`@livestar/money` is a pure Phase 1 accounting utility. It does not charge a card,
credit a wallet, verify an app-store receipt, issue a payout, or prove that a
settlement happened. All examples and tests are calculations only.

- Provider amounts retain their original currency and integer minor units. Supply
  the currency's actual exponent: JPY uses 0, USD 2, KWD 3. A provider-specific
  exception must come from that provider's currency metadata.
- The accounting reference unit is `USD_MICRO`: 1,000,000 units = USD 1. All money
  and coin quantities use TypeScript `bigint`, serialized as decimal strings at
  API boundaries. No monetary amount passes through JavaScript `Number`. These
  utilities support arbitrary-precision integers; persistence must enforce the
  signed 64-bit range of PostgreSQL `BIGINT` before inserting a value.
- FX rates are decimal strings of USD per original major currency unit, up to 12
  decimal places. Conversion rounds once to microdollars using half to even.
  Persist the actual settlement rate, currency, original amount, exponent,
  provider source and rate timestamp; this package does not fetch exchange rates.
- Eligible net revenue is actual settled gross less applicable processing fees,
  tax, refunds and dispute losses. Inputs must not overlap: a refund and a dispute
  for the same loss must not be deducted twice. Provider settlement ingestion must
  establish that the figures are authoritative. Deductions exceeding gross throw
  an error, requiring an explicit loss/reversal journal instead of hiding the loss.
- The default policy is 5,000/5,000 basis points. Creator share rounds down at one
  microdollar; the platform receives the residual, so shares always sum exactly to
  eligible net revenue. Policy version and basis points are snapshotted for each
  transaction. Historical transactions must retain their original policy.
- A purchased-coin lot carries its attributable actual net settlement value.
  Cumulative floor allocation ensures all of that value is attributed when the
  last coin is spent. Pending or unverifiable settlement value cannot be treated
  as available creator earnings. Later refunds/disputes use compensating entries.
- This arithmetic does not provide atomicity. A future wallet service must select
  eligible FIFO lots, lock them, validate ownership and spend limits, and persist
  gift allocations, lot state, revenue snapshots and balanced ledger entries in
  one idempotent database transaction. Purchased coins are not redeemable cash.

Run from the repository root:

```sh
npm run test --workspace=@livestar/money
npm run build --workspace=@livestar/money
```
