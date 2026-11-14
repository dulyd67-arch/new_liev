import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Pool, type PoolClient } from 'pg';

// Every record made here is an isolated integration fixture in a dedicated test
// database. Nothing here represents a provider receipt or a real settlement.
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) throw new Error('DATABASE_MIGRATION_URL is required; database integration tests may not be skipped.');
const databaseName = decodeURIComponent(new URL(ownerUrl).pathname.slice(1));
if (!/test/i.test(databaseName) && process.env.LIVESTAR_ALLOW_TEST_DB !== 'true') {
  throw new Error('Use a dedicated database whose name includes "test", or explicitly set LIVESTAR_ALLOW_TEST_DB=true.');
}

const pool = new Pool({
  connectionString: ownerUrl,
  max: 10,
  statement_timeout: 10_000,
  application_name: 'livestar-database-integration-fixtures',
});

type Entry = { account_id: string; amount: string };
type Unit = 'LIVECOIN' | 'USD_MICRO';
type DbError = Error & { code?: string };

before(async () => {
  await pool.query('SELECT 1');
  const migration = await pool.query("SELECT to_regprocedure('public.post_ledger_journal(text,public.\"LedgerUnit\",text,text,jsonb,uuid)') IS NOT NULL AS installed");
  assert.equal(migration.rows[0].installed, true, 'Apply all migrations before running integration tests.');
});

after(async () => { await pool.end(); });

async function expectSqlFailure(operation: () => Promise<unknown>, codes?: string[]): Promise<void> {
  await assert.rejects(operation, (error: DbError) => {
    assert.ok(error.code, `Expected a database error, received ${error.message}`);
    if (codes) assert.ok(codes.includes(error.code), `Expected SQLSTATE ${codes.join('/')}, received ${error.code}: ${error.message}`);
    return true;
  });
}

async function fixture(unit: Unit = 'LIVECOIN'): Promise<{ user: string; clearing: string; wallet: string; recipient: string }> {
  const user = randomUUID();
  const clearing = randomUUID();
  const wallet = randomUUID();
  const recipient = randomUUID();
  const tag = randomUUID();
  await pool.query('INSERT INTO users (id,email,updated_at) VALUES ($1,$2,now())', [user, `fixture-${tag}@integration.invalid`]);
  const walletKind = unit === 'LIVECOIN' ? 'COIN_WALLET' : 'CREATOR_AVAILABLE';
  const clearingKind = unit === 'LIVECOIN' ? 'COIN_ISSUANCE' : 'PROVIDER_CLEARING';
  await pool.query(`
    INSERT INTO ledger_accounts (id,owner_id,code,unit,kind,enforce_non_negative)
    VALUES ($1,NULL,$2,$3,$4,false), ($5,$6,$7,$3,$8,true), ($9,$6,$10,$3,$8,true)
  `, [clearing, `fixture:${tag}:clearing`, unit, clearingKind, wallet, user, `fixture:${tag}:wallet`, walletKind, recipient, `fixture:${tag}:recipient`]);
  return { user, clearing, wallet, recipient };
}

async function post(entries: Entry[], options: { key?: string; unit?: Unit; source?: string; sourceId?: string; reverses?: string | null } = {}): Promise<string> {
  const result = await pool.query(
    'SELECT public.post_ledger_journal($1,$2::public."LedgerUnit",$3,$4,$5::jsonb,$6::uuid) AS id',
    [options.key ?? `fixture:${randomUUID()}`, options.unit ?? 'LIVECOIN', options.source ?? 'INTEGRATION_FIXTURE', options.sourceId ?? 'not-a-provider-transaction', JSON.stringify(entries), options.reverses ?? null],
  );
  return result.rows[0].id as string;
}

async function balance(account: string): Promise<bigint> {
  const result = await pool.query('SELECT balance FROM ledger_accounts WHERE id=$1', [account]);
  return BigInt(result.rows[0].balance);
}

async function credit(accounts: { clearing: string; wallet: string }, amount: bigint, unit: Unit = 'LIVECOIN'): Promise<string> {
  return post([{ account_id: accounts.clearing, amount: (-amount).toString() }, { account_id: accounts.wallet, amount: amount.toString() }], { unit });
}

test('posts balanced exact BIGINT entries without JavaScript floating point', async () => {
  const f = await fixture('USD_MICRO');
  const amount = 9_007_199_254_740_993n;
  const journal = await credit(f, amount, 'USD_MICRO');
  assert.equal(await balance(f.wallet), amount);
  assert.equal(await balance(f.clearing), -amount);
  const sums = await pool.query('SELECT count(*)::int AS lines, sum(amount)::text AS total FROM wallet_ledger WHERE journal_id=$1', [journal]);
  assert.equal(sums.rows[0].lines, 2);
  assert.equal(sums.rows[0].total, '0');
  const projection = await pool.query('SELECT a.balance::text AS balance, sum(l.amount)::text AS total FROM ledger_accounts a JOIN wallet_ledger l ON l.account_id=a.id WHERE a.id=$1 GROUP BY a.id', [f.wallet]);
  assert.equal(projection.rows[0].balance, projection.rows[0].total);
});

test('identical idempotency retries return one journal; mismatched retry is rejected', async () => {
  const f = await fixture();
  const key = `fixture:retry:${randomUUID()}`;
  const entries = [{ account_id: f.clearing, amount: '-100' }, { account_id: f.wallet, amount: '100' }];
  const first = await post(entries, { key });
  assert.equal(await post([...entries].reverse(), { key }), first, 'Canonical entry order must not change request identity.');
  assert.equal(await balance(f.wallet), 100n);
  await expectSqlFailure(() => post([{ account_id: f.clearing, amount: '-101' }, { account_id: f.wallet, amount: '101' }], { key }), ['23505']);
  await expectSqlFailure(() => post(entries, { key, sourceId: 'different-request' }), ['23505']);
  const count = await pool.query('SELECT count(*)::int AS n FROM ledger_journals WHERE idempotency_key=$1', [key]);
  assert.equal(count.rows[0].n, 1);
});

test('concurrent identical requests mint once', async () => {
  const f = await fixture();
  const key = `fixture:concurrent-retry:${randomUUID()}`;
  const entries = [{ account_id: f.clearing, amount: '-250' }, { account_id: f.wallet, amount: '250' }];
  const ids = await Promise.all(Array.from({ length: 6 }, () => post(entries, { key })));
  assert.equal(new Set(ids).size, 1);
  assert.equal(await balance(f.wallet), 250n);
});

test('row locks prevent concurrent double spending and preserve atomic balances', async () => {
  const f = await fixture();
  await credit(f, 100n);
  const spend = () => post([{ account_id: f.wallet, amount: '-80' }, { account_id: f.recipient, amount: '80' }]);
  const results = await Promise.allSettled([spend(), spend()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(await balance(f.wallet), 20n);
  assert.equal(await balance(f.recipient), 80n);
  assert.equal(await balance(f.clearing), -100n);
});

test('invalid journals roll back completely: imbalance, duplicate account, zero, fractional, mixed unit, missing FK and insufficient balance', async () => {
  const f = await fixture();
  const otherUnit = await fixture('USD_MICRO');
  await credit(f, 10n);
  const cases: Entry[][] = [
    [{ account_id: f.wallet, amount: '-5' }, { account_id: f.recipient, amount: '4' }],
    [{ account_id: f.wallet, amount: '-5' }, { account_id: f.wallet, amount: '5' }],
    [{ account_id: f.wallet, amount: '0' }, { account_id: f.recipient, amount: '0' }],
    [{ account_id: f.wallet, amount: '-1.5' }, { account_id: f.recipient, amount: '1.5' }],
    [{ account_id: f.wallet, amount: '-5' }, { account_id: otherUnit.wallet, amount: '5' }],
    [{ account_id: f.wallet, amount: '-5' }, { account_id: randomUUID(), amount: '5' }],
    [{ account_id: f.wallet, amount: '-11' }, { account_id: f.recipient, amount: '11' }],
    [{ account_id: f.wallet, amount: '1' }],
    // The signed BIGINT minimum cannot be negated into a reversal line. A
    // three-line balanced posting must reject it without keeping any credits.
    [
      { account_id: f.clearing, amount: '-9223372036854775808' },
      { account_id: f.wallet, amount: '4611686018427387904' },
      { account_id: f.recipient, amount: '4611686018427387904' },
    ],
  ];
  for (const entries of cases) {
    const key = `fixture:invalid:${randomUUID()}`;
    await expectSqlFailure(() => post(entries, { key }));
    const count = await pool.query('SELECT count(*)::int AS n FROM ledger_journals WHERE idempotency_key=$1', [key]);
    assert.equal(count.rows[0].n, 0, 'No journal may survive failed posting.');
    assert.equal(await balance(f.wallet), 10n);
    assert.equal(await balance(f.recipient), 0n);
  }
});

test('posted journals, ledger lines and account balances reject direct mutation', async () => {
  const f = await fixture();
  const journal = await credit(f, 20n);
  await expectSqlFailure(() => pool.query('UPDATE ledger_journals SET source_id=$2 WHERE id=$1', [journal, 'rewrite']), ['23514']);
  await expectSqlFailure(() => pool.query('DELETE FROM ledger_journals WHERE id=$1', [journal]), ['23514']);
  await expectSqlFailure(() => pool.query('UPDATE wallet_ledger SET amount=999 WHERE journal_id=$1', [journal]), ['23514']);
  await expectSqlFailure(() => pool.query('DELETE FROM wallet_ledger WHERE journal_id=$1', [journal]), ['23514']);
  await expectSqlFailure(() => pool.query('UPDATE ledger_accounts SET balance=999 WHERE id=$1', [f.wallet]), ['23514']);
  await expectSqlFailure(() => pool.query('UPDATE ledger_accounts SET enforce_non_negative=false WHERE id=$1', [f.wallet]), ['23514']);
  assert.equal(await balance(f.wallet), 20n);
});

test('an explicit reversing journal offsets a posting exactly once', async () => {
  const f = await fixture();
  const original = await credit(f, 40n);
  const reversed = await post([{ account_id: f.clearing, amount: '40' }, { account_id: f.wallet, amount: '-40' }], { reverses: original });
  assert.notEqual(reversed, original);
  assert.equal(await balance(f.wallet), 0n);
  assert.equal(await balance(f.clearing), 0n);
  await expectSqlFailure(() => post([{ account_id: f.clearing, amount: '40' }, { account_id: f.wallet, amount: '-40' }], { reverses: original }));
  assert.equal(await balance(f.wallet), 0n);
});

test('committed journals are sealed against later appending and empty journals cannot commit', async () => {
  const f = await fixture();
  const journal = await credit(f, 5n);
  await expectSqlFailure(() => pool.query('INSERT INTO wallet_ledger (id,journal_id,account_id,unit,amount) VALUES ($1,$2,$3,\'LIVECOIN\',1)', [randomUUID(), journal, f.recipient]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = randomUUID();
    await client.query('INSERT INTO ledger_journals (id,unit,idempotency_key,request_hash,source_type,source_id) VALUES ($1,\'LIVECOIN\',$2,$3,\'INTEGRATION_FIXTURE\',\'empty-journal\')', [id, `fixture:empty:${id}`, '0'.repeat(64)]);
    await expectSqlFailure(() => client.query('COMMIT'), ['23514']);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal(await balance(f.wallet), 5n);
});

test('initial 50/50 revenue policy is seeded; subsequent policies are future-only and immutable', async () => {
  const baseline = await pool.query('SELECT creator_bps,platform_bps FROM revenue_splits WHERE id=$1', ['00000000-0000-4000-8000-000000000001']);
  assert.equal(baseline.rows.length, 1, 'Run the configuration seed before integration tests.');
  assert.equal(baseline.rows[0].creator_bps, 5000);
  assert.equal(baseline.rows[0].platform_bps, 5000);
  const id = randomUUID();
  const effective = new Date(Date.now() + 86_400_000 + Math.floor(Math.random() * 100_000));
  await pool.query('INSERT INTO revenue_splits (id,creator_bps,platform_bps,effective_at,reason) VALUES ($1,5000,5000,$2,\'integration fixture future policy\')', [id, effective]);
  await expectSqlFailure(() => pool.query('UPDATE revenue_splits SET creator_bps=6000,platform_bps=4000 WHERE id=$1', [id]), ['23514']);
  await expectSqlFailure(() => pool.query('DELETE FROM revenue_splits WHERE id=$1', [id]), ['23514']);
  await expectSqlFailure(() => pool.query('INSERT INTO revenue_splits (id,creator_bps,platform_bps,effective_at,reason) VALUES ($1,5000,4000,$2,\'invalid total fixture\')', [randomUUID(), new Date(effective.getTime() + 1)]), ['23514']);
  await expectSqlFailure(() => pool.query('INSERT INTO revenue_splits (id,creator_bps,platform_bps,effective_at,reason) VALUES ($1,5000,5000,$2,\'backdated fixture\')', [randomUUID(), new Date('2001-01-01T00:00:00Z')]), ['23514']);
});

test('financial catalog constraints, foreign keys and append-only audit logs are enforced', async () => {
  await expectSqlFailure(() => pool.query('INSERT INTO gifts (id,code,name_ar,name_en,price_coins,updated_at) VALUES ($1,$2,\'test\',\'test\',0,now())', [randomUUID(), `f-${randomUUID().replaceAll('-', '')}`]), ['23514']);
  await expectSqlFailure(() => pool.query('INSERT INTO follows (follower_id,followed_id) VALUES ($1,$2)', [randomUUID(), randomUUID()]), ['23503']);
  const f = await fixture();
  const auditId = randomUUID();
  await pool.query('INSERT INTO admin_audit_logs (id,actor_id,action,entity_type,entity_id,request_id) VALUES ($1,$2,\'INTEGRATION_FIXTURE\',\'TEST\',$3,$4)', [auditId, f.user, f.wallet, randomUUID()]);
  await expectSqlFailure(() => pool.query('UPDATE admin_audit_logs SET action=\'rewrite\' WHERE id=$1', [auditId]), ['23514']);
  await expectSqlFailure(() => pool.query('DELETE FROM admin_audit_logs WHERE id=$1', [auditId]), ['23514']);
});

async function asApp(action: (client: PoolClient) => Promise<unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE livestar_app');
    await action(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('runtime role cannot directly create users, delete accounts or post money', async () => {
  const f = await fixture();
  await asApp(async (client) => {
    const result = await client.query('SELECT balance FROM ledger_accounts WHERE id=$1', [f.wallet]);
    assert.equal(result.rows[0].balance, '0');
  });
  const denied = [
    (client: PoolClient) => client.query('UPDATE ledger_accounts SET balance=1 WHERE id=$1', [f.wallet]),
    (client: PoolClient) => client.query('DELETE FROM users WHERE id=$1', [f.user]),
    (client: PoolClient) => client.query('INSERT INTO users (id,email,updated_at) VALUES ($1,$2,now())', [randomUUID(), `forbidden-${randomUUID()}@integration.invalid`]),
    (client: PoolClient) => client.query('SELECT public.post_ledger_journal($1,\'LIVECOIN\',\'INTEGRATION_FIXTURE\',\'forbidden\',$2::jsonb,NULL)', [`fixture:forbidden:${randomUUID()}`, JSON.stringify([{ account_id: f.clearing, amount: '-1' }, { account_id: f.wallet, amount: '1' }])]),
  ];
  for (const operation of denied) await expectSqlFailure(() => asApp(operation), ['42501']);
  assert.equal(await balance(f.wallet), 0n);
});

test('overlapping transfers in both directions use a stable lock order without deadlocks', async () => {
  const f = await fixture();
  await credit(f, 100n);
  await post([{ account_id: f.clearing, amount: '-100' }, { account_id: f.recipient, amount: '100' }]);
  const transfers = Array.from({ length: 20 }, (_unused, index) => index % 2 === 0
    ? [{ account_id: f.wallet, amount: '-1' }, { account_id: f.recipient, amount: '1' }]
    : [{ account_id: f.recipient, amount: '-1' }, { account_id: f.wallet, amount: '1' }]);
  await Promise.all(transfers.map((entries) => post(entries)));
  assert.equal(await balance(f.wallet), 100n);
  assert.equal(await balance(f.recipient), 100n);
  const totals = await pool.query('SELECT sum(balance)::text AS total FROM ledger_accounts WHERE id=ANY($1::uuid[])', [[f.wallet, f.recipient, f.clearing]]);
  assert.equal(totals.rows[0].total, '0');
});

test('BIGINT overflow rejects the entire posting instead of wrapping or partially updating balances', async () => {
  const f = await fixture();
  const maximum = 9_223_372_036_854_775_807n;
  await credit(f, maximum);
  const key = `fixture:overflow:${randomUUID()}`;
  await expectSqlFailure(() => post([
    { account_id: f.clearing, amount: '-1' },
    { account_id: f.wallet, amount: '1' },
  ], { key }), ['22003']);
  assert.equal(await balance(f.wallet), maximum);
  assert.equal(await balance(f.clearing), -maximum);
  const survived = await pool.query('SELECT count(*)::int AS count FROM ledger_journals WHERE idempotency_key=$1', [key]);
  assert.equal(survived.rows[0].count, 0);
});

test('a failed second posting rolls back earlier postings in the same outer transaction', async () => {
  const f = await fixture();
  const key = `fixture:outer-atomic:${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT public.post_ledger_journal($1,\'LIVECOIN\',\'INTEGRATION_FIXTURE\',\'outer-transaction\',$2::jsonb,NULL)', [key, JSON.stringify([
      { account_id: f.clearing, amount: '-10' }, { account_id: f.wallet, amount: '10' },
    ])]);
    await expectSqlFailure(() => client.query('SELECT public.post_ledger_journal($1,\'LIVECOIN\',\'INTEGRATION_FIXTURE\',\'outer-transaction\',$2::jsonb,NULL)', [`${key}:invalid`, JSON.stringify([
      { account_id: f.wallet, amount: '-11' }, { account_id: f.recipient, amount: '11' },
    ])]), ['23514']);
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal(await balance(f.wallet), 0n);
  assert.equal(await balance(f.clearing), 0n);
  const survived = await pool.query('SELECT count(*)::int AS count FROM ledger_journals WHERE idempotency_key=$1', [key]);
  assert.equal(survived.rows[0].count, 0);
});

test('reversals reject partial amounts and unavailable funds without consuming the reversal slot', async () => {
  const f = await fixture();
  const original = await credit(f, 100n);
  await expectSqlFailure(() => post([
    { account_id: f.clearing, amount: '99' }, { account_id: f.wallet, amount: '-99' },
  ], { reverses: original }), ['23514']);
  await post([{ account_id: f.wallet, amount: '-80' }, { account_id: f.recipient, amount: '80' }]);
  await expectSqlFailure(() => post([
    { account_id: f.clearing, amount: '100' }, { account_id: f.wallet, amount: '-100' },
  ], { reverses: original }), ['23514']);
  assert.equal(await balance(f.wallet), 20n);
  await post([{ account_id: f.recipient, amount: '-80' }, { account_id: f.wallet, amount: '80' }]);
  await post([{ account_id: f.clearing, amount: '100' }, { account_id: f.wallet, amount: '-100' }], { reverses: original });
  assert.equal(await balance(f.wallet), 0n);
  assert.equal(await balance(f.clearing), 0n);
});

test('wallet ownership, account unit and protected opening balances are checked before use', async () => {
  const f = await fixture();
  const other = await fixture();
  const usd = await fixture('USD_MICRO');
  await expectSqlFailure(() => pool.query('INSERT INTO coin_wallets (id,user_id,ledger_account_id) VALUES ($1,$2,$3)', [randomUUID(), other.user, f.wallet]), ['23514']);
  await expectSqlFailure(() => pool.query('INSERT INTO coin_wallets (id,user_id,ledger_account_id) VALUES ($1,$2,$3)', [randomUUID(), usd.user, usd.wallet]), ['23514']);
  await pool.query('INSERT INTO coin_wallets (id,user_id,ledger_account_id) VALUES ($1,$2,$3)', [randomUUID(), f.user, f.wallet]);
  await expectSqlFailure(() => pool.query('INSERT INTO ledger_accounts (id,owner_id,code,unit,kind,enforce_non_negative,balance) VALUES ($1,$2,$3,\'LIVECOIN\',\'COIN_WALLET\',true,1)', [randomUUID(), f.user, `fixture:nonzero-opening:${randomUUID()}`]), ['23514']);
  await expectSqlFailure(() => pool.query('INSERT INTO ledger_accounts (id,owner_id,code,unit,kind,enforce_non_negative) VALUES ($1,$2,$3,\'LIVECOIN\',\'COIN_WALLET\',false)', [randomUUID(), f.user, `fixture:unprotected-wallet:${randomUUID()}`]), ['23514']);
  await expectSqlFailure(() => pool.query('INSERT INTO ledger_accounts (id,owner_id,code,unit,kind,enforce_non_negative) VALUES ($1,$2,$3,\'USD_MICRO\',\'COIN_WALLET\',true)', [randomUUID(), f.user, `fixture:wrong-unit:${randomUUID()}`]), ['23514']);
});

test('posted request identity rejects malformed JSON and normalizes UUID spelling', async () => {
  const f = await fixture();
  const invalid: unknown[] = [
    null,
    {},
    [],
    [{ account_id: f.clearing, amount: -1 }, { account_id: f.wallet, amount: 1 }],
    [{ account_id: f.clearing, amount: '-1', extra: true }, { account_id: f.wallet, amount: '1' }],
    [{ account_id: f.clearing, amount: '-01' }, { account_id: f.wallet, amount: '01' }],
    [{ account_id: f.clearing, amount: '-1' }, { account_id: f.wallet }],
  ];
  for (const entries of invalid) {
    await expectSqlFailure(() => pool.query('SELECT public.post_ledger_journal($1,\'LIVECOIN\',\'INTEGRATION_FIXTURE\',\'malformed-json\',$2::jsonb,NULL)', [`fixture:malformed:${randomUUID()}`, JSON.stringify(entries)]));
    assert.equal(await balance(f.wallet), 0n);
  }
  const key = `fixture:uuid-normalization:${randomUUID()}`;
  const original = await post([{ account_id: f.clearing, amount: '-3' }, { account_id: f.wallet, amount: '3' }], { key });
  const retry = await post([{ account_id: f.wallet.toUpperCase(), amount: '3' }, { account_id: f.clearing.toUpperCase(), amount: '-3' }], { key });
  assert.equal(retry, original);
  assert.equal(await balance(f.wallet), 3n);
});

test('coin lots require matching settled ownership and preserve exact cumulative attribution', async () => {
  const f = await fixture();
  const other = await fixture();
  const wallet = randomUUID();
  const otherWallet = randomUUID();
  const packageId = randomUUID();
  const orderId = randomUUID();
  const lotId = randomUUID();
  const tag = randomUUID();
  await pool.query('INSERT INTO coin_wallets (id,user_id,ledger_account_id) VALUES ($1,$2,$3),($4,$5,$6)', [wallet, f.user, f.wallet, otherWallet, other.user, other.wallet]);
  await pool.query('INSERT INTO coin_packages (id,code,coins,currency,currency_exponent,price_minor,provider,updated_at) VALUES ($1,$2,3,\'USD\',2,1,\'STRIPE\',now())', [packageId, `f:${tag.replaceAll('-', '')}`]);
  // Database fixtures only: this does not represent a verified external receipt.
  await pool.query(`INSERT INTO payment_orders (
    id,user_id,package_id,provider,provider_order_id,idempotency_key,status,
    coins,currency,currency_exponent,amount_minor,fx_rate_to_usd,fx_observed_at,fx_source,
    gross_usd_micros,processing_fee_usd_micros,tax_usd_micros,settled_net_usd_micros,
    settlement_reference,settled_at,updated_at
  ) VALUES ($1,$2,$3,'STRIPE',$4,$5,'SETTLED',3,'USD',2,1,1,now(),'INTEGRATION_FIXTURE',10000,0,0,10000,$6,now(),now())`,
  [orderId, f.user, packageId, `fixture-order:${tag}`, `fixture-order-idempotency:${tag}`, `fixture-settlement:${tag}`]);
  const insert = (id: string, walletId: string, coinsIssued = '3', netUsdMicros = '10000') => pool.query(
    'INSERT INTO coin_lots (id,wallet_id,payment_order_id,coins_issued,coins_remaining,settled_net_usd_micros) VALUES ($1,$2,$3,$4,$4,$5)',
    [id, walletId, orderId, coinsIssued, netUsdMicros],
  );
  await expectSqlFailure(() => insert(randomUUID(), otherWallet), ['23514']);
  await expectSqlFailure(() => insert(randomUUID(), wallet, '4'), ['23514']);
  await expectSqlFailure(() => insert(randomUUID(), wallet, '3', '9999'), ['23514']);
  await insert(lotId, wallet);
  await expectSqlFailure(() => pool.query('UPDATE coin_lots SET coins_remaining=2,allocated_net_usd_micros=3334 WHERE id=$1', [lotId]), ['23514']);
  await pool.query('UPDATE coin_lots SET coins_remaining=2,allocated_net_usd_micros=3333 WHERE id=$1', [lotId]);
  await expectSqlFailure(() => pool.query('UPDATE coin_lots SET coins_remaining=3,allocated_net_usd_micros=0 WHERE id=$1', [lotId]), ['23514']);
  await expectSqlFailure(() => pool.query('UPDATE coin_lots SET settled_net_usd_micros=10001 WHERE id=$1', [lotId]), ['23514']);
  await pool.query('UPDATE coin_lots SET coins_remaining=1,allocated_net_usd_micros=6666 WHERE id=$1', [lotId]);
  await pool.query('UPDATE coin_lots SET coins_remaining=0,allocated_net_usd_micros=10000 WHERE id=$1', [lotId]);
  const end = await pool.query('SELECT coins_remaining::text,allocated_net_usd_micros::text FROM coin_lots WHERE id=$1', [lotId]);
  assert.deepEqual(end.rows[0], { coins_remaining: '0', allocated_net_usd_micros: '10000' });
});
