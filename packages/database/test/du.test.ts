import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient } from '@prisma/client';

// All fixtures are fictional free DU units in a dedicated local test database.
// No legacy financial balance, payment receipt or creator earning is created.
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) throw new Error('DATABASE_MIGRATION_URL is required for DU integration tests.');
if (!/test/i.test(decodeURIComponent(new URL(ownerUrl).pathname.slice(1))) && process.env.LIVESTAR_ALLOW_TEST_DB !== 'true') {
  throw new Error('DU integration tests require a dedicated test database.');
}
const pool = new Pool({ connectionString: ownerUrl, max: 12, statement_timeout: 15_000 });
const ROSE = 'd0000000-0000-4000-8000-000000000001';
const HEART = 'd0000000-0000-4000-8000-000000000002';
const STAR = 'd0000000-0000-4000-8000-000000000005';
const ROCKET = 'd0000000-0000-4000-8000-000000000009';
const LION = 'd0000000-0000-4000-8000-000000000012';

before(async () => {
  const result = await pool.query("SELECT to_regprocedure('public.du_send_gift(uuid,uuid,uuid,bigint,text)') IS NOT NULL AS installed");
  assert.equal(result.rows[0].installed, true, 'Apply the DU migration before running its tests.');
});
after(async () => { await pool.end(); });

async function asApp<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE livestar_app');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function failure(operation: () => Promise<unknown>, message: string, code = '23514'): Promise<void> {
  await assert.rejects(operation, (error: Error & { code?: string }) => {
    assert.equal(error.code, code, error.message);
    assert.ok(error.message.includes(message), error.message);
    return true;
  });
}

async function user(): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id,email,updated_at) VALUES($1,$2,now())', [id, `du-${id}@integration.invalid`]);
  await pool.query('INSERT INTO user_profiles(user_id,username,display_name) VALUES($1,$2,$3)', [id, `du_${id.replaceAll('-', '').slice(0, 24)}`, 'DU test fixture']);
  return id;
}

async function fixture(): Promise<{ sender: string; creator: string; stream: string }> {
  const sender = await user();
  const creator = await user();
  const stream = randomUUID();
  await pool.query("INSERT INTO live_streams(id,creator_id,title,status,livekit_room,started_at) VALUES($1,$2,'DU fixture','LIVE',$3,now())", [stream, creator, `du-fixture-${stream}`]);
  return { sender, creator, stream };
}

async function claim(sender: string, key = randomUUID()) {
  const result = await asApp((client) => client.query('SELECT * FROM public.du_claim_coins($1,$2)', [sender, key]));
  return result.rows[0];
}

async function send(f: { sender: string; stream: string }, gift = ROSE, quantity = '1', key = randomUUID()) {
  const result = await asApp((client) => client.query('SELECT * FROM public.du_send_gift($1,$2,$3,$4::bigint,$5)', [f.sender, f.stream, gift, quantity, key]));
  return result.rows[0];
}

async function balance(sender: string): Promise<bigint> {
  const result = await pool.query('SELECT balance FROM du_wallets WHERE user_id=$1', [sender]);
  return BigInt(result.rows[0]?.balance ?? '0');
}

test('catalog is bilingual, varied, immutable and uses exact integer DU prices', async () => {
  const catalog = (await asApp((client) => client.query('SELECT * FROM du_gifts ORDER BY sort_order'))).rows;
  assert.equal(catalog.length, 12);
  assert.deepEqual(catalog.map((gift) => gift.price), ['1', '5', '10', '15', '25', '35', '50', '75', '100', '250', '500', '1000']);
  assert.ok(catalog.every((gift) => gift.name_ar && gift.name_en && gift.emoji && gift.effect));
  await failure(() => pool.query('UPDATE du_gifts SET price=2 WHERE id=$1', [ROSE]), 'Append-only');
  await failure(() => pool.query('DELETE FROM du_gifts WHERE id=$1', [ROSE]), 'Append-only');
  await failure(() => pool.query('INSERT INTO du_gifts SELECT $1,slug,name_ar,name_en,emoji,price,effect,sort_order FROM du_gifts WHERE id=$2', [randomUUID(), ROSE]), 'Append-only');
  await failure(() => pool.query('TRUNCATE du_gifts CASCADE'), 'Append-only');
});

test('new accounts have no DU or financial wallet; explicit claim grants 100 exactly once', async () => {
  const sender = await user();
  const before = await pool.query('SELECT (SELECT count(*)::int FROM du_wallets WHERE user_id=$1) AS du, (SELECT count(*)::int FROM coin_wallets WHERE user_id=$1) AS finance', [sender]);
  assert.deepEqual(before.rows[0], { du: 0, finance: 0 });
  const key = randomUUID();
  const first = await claim(sender, key);
  assert.equal(first.type, 'CLAIM');
  assert.equal(first.amount, '100');
  assert.equal(first.balance_after, '100');
  assert.equal((await claim(sender, key)).id, first.id);
  await failure(() => claim(sender), 'DU_ALREADY_CLAIMED');
  assert.equal(await balance(sender), 100n);
  const state = await pool.query('SELECT claimed_at FROM du_wallets WHERE user_id=$1', [sender]);
  assert.ok(state.rows[0].claimed_at);
  const finance = await pool.query('SELECT count(*)::int AS n FROM ledger_accounts WHERE owner_id=$1', [sender]);
  assert.equal(finance.rows[0].n, 0);
});

test('concurrent same-key and different-key claims mint a single 100 DU grant', async () => {
  const sender = await user();
  const key = randomUUID();
  const rows = await Promise.all(Array.from({ length: 6 }, () => claim(sender, key)));
  assert.equal(new Set(rows.map((row) => row.id)).size, 1);
  assert.equal(await balance(sender), 100n);
  const another = await user();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => claim(another)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(await balance(another), 100n);
});

test('gift debit, transaction snapshot and stream feed event commit atomically; creator earns no DU or money', async () => {
  const f = await fixture();
  await claim(f.sender);
  const transaction = await send(f, HEART, '3');
  assert.equal(transaction.type, 'GIFT');
  assert.equal(transaction.unit_price, '5');
  assert.equal(transaction.quantity, '3');
  assert.equal(transaction.amount, '-15');
  assert.equal(transaction.balance_after, '85');
  assert.equal(transaction.creator_id, f.creator);
  assert.equal(transaction.stream_id, f.stream);
  assert.equal(await balance(f.sender), 85n);
  assert.equal(await balance(f.creator), 0n);
  const sums = await pool.query(`SELECT sum(amount)::text AS projection,
    (SELECT sum(-amount)::text FROM du_transactions WHERE stream_id=$2 AND type='GIFT') AS stream_total,
    (SELECT count(*)::int FROM creator_earnings WHERE creator_id=$3) AS earnings
    FROM du_transactions WHERE user_id=$1`, [f.sender, f.stream, f.creator]);
  assert.deepEqual(sums.rows[0], { projection: '85', stream_total: '15', earnings: 0 });
});

test('concurrent identical gifts debit once, and idempotency conflicts never mutate balances', async () => {
  const f = await fixture();
  const claimKey = randomUUID();
  await claim(f.sender, claimKey);
  const key = randomUUID();
  const transactions = await Promise.all(Array.from({ length: 6 }, () => send(f, HEART, '2', key)));
  assert.equal(new Set(transactions.map((transaction) => transaction.id)).size, 1);
  assert.equal(await balance(f.sender), 90n);
  await failure(() => send(f, HEART, '3', key), 'DU_IDEMPOTENCY_CONFLICT');
  await failure(() => send(f, ROSE, '2', key), 'DU_IDEMPOTENCY_CONFLICT');
  await failure(() => send(f, HEART, '2', claimKey), 'DU_IDEMPOTENCY_CONFLICT');
  await failure(() => claim(f.sender, key), 'DU_IDEMPOTENCY_CONFLICT');
  assert.equal(await balance(f.sender), 90n);
});

test('Prisma preserves the tagged idempotency domain error used by the API', async () => {
  const sender = await user();
  const key = randomUUID();
  await claim(sender, key);
  const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  try {
    await assert.rejects(() => prisma.$transaction(async (client) => {
      await client.$executeRawUnsafe('SET LOCAL ROLE livestar_app');
      return client.$queryRaw`SELECT * FROM public.du_send_gift(${sender}::uuid,${randomUUID()}::uuid,${ROSE}::uuid,${1n}::bigint,${key})`;
    }), (error: Error & { code?: string; meta?: { code?: string; message?: string } }) => {
      assert.equal(error.code, 'P2010');
      assert.equal(error.meta?.code, '23514');
      assert.ok(error.meta?.message?.includes('DU_IDEMPOTENCY_CONFLICT'), 'Prisma must retain the DU domain tag for HTTP409 mapping');
      return true;
    });
  } finally { await prisma.$disconnect(); }
  assert.equal(await balance(sender), 100n);
});

test('concurrent overspending admits one debit and failed send leaves no event or balance change', async () => {
  const f = await fixture();
  await claim(f.sender);
  const results = await Promise.allSettled([send(f, ROSE, '80'), send(f, ROSE, '80')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(await balance(f.sender), 20n);
  const history = await pool.query("SELECT count(*)::int AS n,sum(-amount)::text AS total FROM du_transactions WHERE stream_id=$1 AND type='GIFT'", [f.stream]);
  assert.deepEqual(history.rows[0], { n: 1, total: '80' });
});

test('exact sum of many sends matches wallet projection and ordered stream sequence', async () => {
  const f = await fixture();
  await claim(f.sender);
  const transactions = await Promise.all(Array.from({ length: 25 }, () => send(f, ROSE)));
  assert.equal(transactions.length, 25);
  assert.equal(await balance(f.sender), 75n);
  const history = await pool.query('SELECT seq,amount,balance_after FROM du_transactions WHERE stream_id=$1 ORDER BY seq', [f.stream]);
  assert.equal(history.rows.reduce((total, row) => total + BigInt(row.amount), 0n), -25n);
  assert.equal(history.rows.at(-1)?.balance_after, '75');
  for (let index = 1; index < history.rows.length; index++) {
    assert.ok(BigInt(history.rows[index].seq) > BigInt(history.rows[index - 1].seq));
    assert.equal(BigInt(history.rows[index].balance_after), BigInt(history.rows[index - 1].balance_after) - 1n);
  }
  const projection = await pool.query('SELECT sum(amount)::text AS total FROM du_transactions WHERE user_id=$1', [f.sender]);
  assert.equal(projection.rows[0].total, '75');
});

test('a second sender cannot publish a higher stream sequence before an earlier gift commits', async () => {
  const f = await fixture();
  const otherSender = await user();
  await claim(f.sender);
  await claim(otherSender);
  const firstConnection = await pool.connect();
  let second: Promise<Awaited<ReturnType<typeof send>>> | undefined;
  try {
    await firstConnection.query('BEGIN');
    await firstConnection.query('SET LOCAL ROLE livestar_app');
    const first = (await firstConnection.query('SELECT * FROM public.du_send_gift($1,$2,$3,1,$4)', [f.sender, f.stream, ROSE, randomUUID()])).rows[0];
    second = send({ sender: otherSender, stream: f.stream });
    const early = await Promise.race([second.then(() => 'committed'), new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 75))]);
    assert.equal(early, 'waiting', 'later stream events must wait for the earlier commit');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM du_transactions WHERE stream_id=$1', [f.stream])).rows[0].n, 0);
    await firstConnection.query('COMMIT');
    const next = await second;
    assert.ok(BigInt(next.seq) > BigInt(first.seq));
    const published = (await pool.query('SELECT seq FROM du_transactions WHERE stream_id=$1 ORDER BY seq', [f.stream])).rows;
    assert.deepEqual(published.map((row) => row.seq), [first.seq, next.seq]);
  } finally {
    await firstConnection.query('ROLLBACK');
    firstConnection.release();
    if (second) await second.catch(() => undefined);
  }
});

test('gifting follows creator-before-stream lock order used by stream activation', async () => {
  const f = await fixture();
  await claim(f.sender);
  const activation = await pool.connect();
  let pending: Promise<Awaited<ReturnType<typeof send>>> | undefined;
  try {
    await activation.query('BEGIN');
    await activation.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.creator]);
    pending = send(f);
    const waiting = await Promise.race([pending.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 75))]);
    assert.equal(waiting, true);
    // A gift that locks the stream before its users would deadlock here.
    await activation.query("UPDATE live_streams SET status='LIVE' WHERE id=$1", [f.stream]);
    await activation.query('COMMIT');
    assert.equal((await pending).amount, '-1');
  } finally {
    await activation.query('ROLLBACK');
    activation.release();
    if (pending) await pending.catch(() => undefined);
  }
});

test('successful replay survives stream end, account changes and blocks without a second charge', async () => {
  const f = await fixture();
  const claimKey = randomUUID();
  const grant = await claim(f.sender, claimKey);
  const key = randomUUID();
  const transaction = await send(f, STAR, '1', key);
  await pool.query("UPDATE live_streams SET status='ENDED',ended_at=now() WHERE id=$1", [f.stream]);
  await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [f.sender]);
  await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)', [f.creator, f.sender]);
  assert.equal((await send(f, STAR, '1', key)).id, transaction.id);
  assert.equal((await claim(f.sender, claimKey)).id, grant.id);
  await failure(() => send(f), 'DU_STREAM_UNAVAILABLE');
  assert.equal(await balance(f.sender), 75n);
});

test('missing/inactive/deleted accounts, self gifting, ended streams and either block direction are rejected', async () => {
  const f = await fixture();
  await claim(f.sender);
  await failure(() => send({ ...f, sender: f.creator }), 'DU_SELF_GIFT');
  await failure(() => send({ ...f, stream: randomUUID() }), 'DU_STREAM_UNAVAILABLE');
  await failure(() => send(f, randomUUID()), 'DU_GIFT_UNAVAILABLE');
  for (const [blocker, blocked] of [[f.sender, f.creator], [f.creator, f.sender]]) {
    await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)', [blocker, blocked]);
    await failure(() => send(f), 'DU_BLOCKED');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [blocker, blocked]);
  }
  for (const actor of [f.sender, f.creator]) {
    await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [actor]);
    await failure(() => send(f), 'DU_ACCOUNT_UNAVAILABLE');
    await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [actor]);
    await pool.query('UPDATE users SET deleted_at=now() WHERE id=$1', [actor]);
    await failure(() => send(f), 'DU_ACCOUNT_UNAVAILABLE');
    await pool.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [actor]);
  }
  const inactive = await user();
  await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [inactive]);
  await failure(() => claim(inactive), 'DU_ACCOUNT_UNAVAILABLE');
  await failure(() => claim(randomUUID()), 'DU_ACCOUNT_UNAVAILABLE');
  assert.equal(await balance(f.sender), 100n);
});

test('invalid integers, overflow, insufficient funds and malformed identities never create history', async () => {
  const f = await fixture();
  for (const quantity of ['0', '-1', '100']) await failure(() => send(f, ROSE, quantity), 'DU_INVALID_REQUEST');
  await failure(() => send(f), 'DU_INSUFFICIENT_BALANCE');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM du_wallets WHERE user_id=$1', [f.sender])).rows[0].n, 0);
  await claim(f.sender);
  await failure(() => send(f, ROSE, '9007199254740993'), 'DU_INVALID_REQUEST');
  await failure(() => send(f, LION, '9223372036854775807'), 'DU_INVALID_REQUEST');
  await failure(() => send(f, ROCKET, '2'), 'DU_INSUFFICIENT_BALANCE');
  await failure(() => send(f, ROSE, '1', ''), 'DU_INVALID_REQUEST');
  await failure(() => send(f, ROSE, '1', ' '.repeat(3)), 'DU_INVALID_REQUEST');
  await failure(() => send(f, ROSE, '1', 'a'.repeat(201)), 'DU_INVALID_REQUEST');
  await failure(() => send(f, ROSE, '1', `${'a'.repeat(200)} `), 'DU_INVALID_REQUEST');
  await failure(() => claim(f.sender, ` ${'a'.repeat(200)}`), 'DU_INVALID_REQUEST');
  await failure(() => claim(f.sender, ''), 'DU_INVALID_REQUEST');
  for (const quantity of ['1.5', '9223372036854775808']) {
    await assert.rejects(() => send(f, ROSE, quantity), (error: Error & { code?: string }) => ['22P02', '22003'].includes(error.code ?? ''));
  }
  assert.equal(await balance(f.sender), 100n);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM du_transactions WHERE stream_id=$1', [f.stream])).rows[0].n, 0);
  assert.equal((await send(f, ROSE, '99')).balance_after, '1', 'maximum allowed quantity remains usable');
});

test('runtime social grants support duplicate-safe follow, unfollow and reporting while denying rewrites', async () => {
  const f = await fixture();
  await asApp(async (client) => {
    await client.query('INSERT INTO follows(follower_id,followed_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [f.sender, f.creator]);
    await client.query('INSERT INTO follows(follower_id,followed_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [f.sender, f.creator]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM follows WHERE follower_id=$1 AND followed_id=$2', [f.sender, f.creator])).rows[0].n, 1);
    await client.query('DELETE FROM follows WHERE follower_id=$1 AND followed_id=$2', [f.sender, f.creator]);
    await client.query("INSERT INTO reports(id,reporter_id,target_user_id,stream_id,reason_code) VALUES($1,$2,$3,$4,'OTHER') RETURNING id", [randomUUID(), f.sender, f.creator, f.stream]);
  });
  for (const operation of [
    (client: PoolClient) => client.query('UPDATE follows SET followed_id=$1 WHERE follower_id=$2', [f.sender, f.creator]),
    (client: PoolClient) => client.query("UPDATE reports SET status='RESOLVED' WHERE reporter_id=$1", [f.sender]),
  ]) {
    await assert.rejects(() => asApp(operation), (error: Error & { code?: string }) => error.code === '42501');
  }
});

test('runtime cannot write DU tables, use sequences, call trigger helpers or post dormant financial journals', async () => {
  const f = await fixture();
  await claim(f.sender);
  const denied = [
    (client: PoolClient) => client.query('UPDATE du_wallets SET balance=999 WHERE user_id=$1', [f.sender]),
    (client: PoolClient) => client.query('UPDATE du_wallets SET claimed_at=NULL WHERE user_id=$1', [f.sender]),
    (client: PoolClient) => client.query('DELETE FROM du_wallets WHERE user_id=$1', [f.sender]),
    (client: PoolClient) => client.query('INSERT INTO du_wallets(user_id) VALUES($1)', [f.creator]),
    (client: PoolClient) => client.query('UPDATE du_gifts SET price=1 WHERE id=$1', [LION]),
    (client: PoolClient) => client.query('DELETE FROM du_transactions WHERE user_id=$1', [f.sender]),
    (client: PoolClient) => client.query("INSERT INTO du_transactions(type,user_id,amount,balance_after,idempotency_key) VALUES('CLAIM',$1,100,200,$2)", [f.sender, randomUUID()]),
    (client: PoolClient) => client.query("SELECT nextval('du_transactions_seq_seq')"),
    (client: PoolClient) => client.query('SELECT public.apply_du_transaction()'),
    (client: PoolClient) => client.query(`SELECT public.post_ledger_journal('du-forbidden','LIVECOIN','DU','forbidden','[]'::jsonb,NULL)`),
  ];
  for (const operation of denied) {
    await assert.rejects(() => asApp(operation), (error: Error & { code?: string }) => error.code === '42501');
  }
});

test('ordinary owner writes cannot change history, manufacture a transaction or edit the wallet projection', async () => {
  const f = await fixture();
  await claim(f.sender);
  const transaction = await send(f);
  await failure(() => pool.query('UPDATE du_transactions SET amount=-2 WHERE id=$1', [transaction.id]), 'Append-only');
  await failure(() => pool.query('DELETE FROM du_transactions WHERE id=$1', [transaction.id]), 'Append-only');
  await failure(() => pool.query('TRUNCATE du_transactions'), 'Append-only');
  await failure(() => pool.query('UPDATE du_wallets SET balance=100 WHERE user_id=$1', [f.sender]), 'DU_WALLET_PROJECTION_ONLY');
  await failure(() => pool.query('UPDATE du_wallets SET claimed_at=NULL WHERE user_id=$1', [f.sender]), 'DU_WALLET_PROJECTION_ONLY');
  await failure(() => pool.query('DELETE FROM du_wallets WHERE user_id=$1', [f.sender]), 'DU_WALLET_PERMANENT');
  await failure(() => pool.query('INSERT INTO du_wallets(user_id,balance) VALUES($1,100)', [f.creator]), 'DU_WALLET_PROJECTION_ONLY');
  await failure(() => pool.query("INSERT INTO du_transactions(type,user_id,amount,balance_after,idempotency_key) VALUES('CLAIM',$1,100,100,$2)", [f.creator, randomUUID()]), 'DU_ATOMIC_FUNCTION_ONLY');
});

test('soft deletion retains wallet and gifts while preventing new claims and sends', async () => {
  const f = await fixture();
  await claim(f.sender);
  const transaction = await send(f, HEART);
  await asApp((client) => client.query('SELECT public.request_account_deletion($1)', [f.sender]));
  assert.equal(await balance(f.sender), 95n);
  assert.equal((await pool.query('SELECT user_id FROM du_transactions WHERE id=$1', [transaction.id])).rows[0].user_id, f.sender);
  await failure(() => send(f), 'DU_ACCOUNT_UNAVAILABLE');
  await failure(() => claim(f.sender), 'DU_ACCOUNT_UNAVAILABLE');
});
