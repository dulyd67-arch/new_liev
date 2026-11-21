import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Pool, type PoolClient } from 'pg';

// Fixtures exercise promotional DU, live battles and likes only. Keep all test
// data in a dedicated local database; these tests never use paid balances.
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) throw new Error('DATABASE_MIGRATION_URL is required for PK integration tests.');
if (!/test/i.test(decodeURIComponent(new URL(ownerUrl).pathname.slice(1))) && process.env.LIVESTAR_ALLOW_TEST_DB !== 'true') {
  throw new Error('PK integration tests require a dedicated test database.');
}
const pool = new Pool({ connectionString: ownerUrl, max: 14, statement_timeout: 15_000 });
const ROSE = 'd0000000-0000-4000-8000-000000000001';
const HEART = 'd0000000-0000-4000-8000-000000000002';

before(async () => {
  const result = await pool.query(`SELECT
    to_regprocedure('public.pk_invite(uuid,uuid,uuid,uuid,integer)') IS NOT NULL AS battles,
    to_regprocedure('public.stream_send_likes(uuid,uuid,integer,uuid)') IS NOT NULL AS likes,
    to_regprocedure('public.pk_settle_absent(uuid,uuid[])') IS NOT NULL AS presence`);
  assert.deepEqual(result.rows[0], { battles: true, likes: true, presence: true }, 'Apply the PK, likes and presence migrations before running their tests.');
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

async function failure(operation: () => Promise<unknown>, tag: string, code = '23514'): Promise<void> {
  await assert.rejects(operation, (error: Error & { code?: string }) => {
    assert.equal(error.code, code, error.message);
    assert.ok(error.message.includes(tag), error.message);
    return true;
  });
}

async function user(): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id,email,updated_at) VALUES($1,$2,now())', [id, `pk-${id}@integration.invalid`]);
  await pool.query('INSERT INTO user_profiles(user_id,username,display_name) VALUES($1,$2,$3)', [id, `pk_${id.replaceAll('-', '').slice(0, 24)}`, 'PK test fixture']);
  return id;
}

async function stream(creator = undefined as string | undefined): Promise<{ id: string; creator: string }> {
  const id = randomUUID();
  creator ??= await user();
  await pool.query("INSERT INTO live_streams(id,creator_id,title,status,livekit_room,started_at) VALUES($1,$2,'PK fixture','LIVE',$3,now())", [id, creator, `pk-fixture-${id}`]);
  return { id, creator };
}

async function fixture() {
  return { host: await stream(), guest: await stream(), sender: await user() };
}

async function invite(f: Awaited<ReturnType<typeof fixture>>, key = randomUUID(), duration = 300) {
  const result = await asApp((client) => client.query('SELECT * FROM public.pk_invite($1,$2,$3,$4,$5)', [f.host.creator, f.host.id, f.guest.id, key, duration]));
  return result.rows[0];
}

async function respond(actor: string, battle: string, action: string) {
  const result = await asApp((client) => client.query('SELECT * FROM public.pk_respond($1,$2,$3)', [actor, battle, action]));
  return result.rows[0];
}

async function snapshot(id: string) {
  const result = await asApp((client) => client.query('SELECT * FROM public.pk_snapshot($1)', [id]));
  return result.rows[0];
}

async function settleAbsent(battle: string | null, streamIds: (string | null)[] | null) {
  const result = await asApp((client) => client.query('SELECT * FROM public.pk_settle_absent($1,$2::uuid[])', [battle, streamIds]));
  return result.rows[0];
}

async function claim(actor: string) {
  await asApp((client) => client.query('SELECT * FROM public.du_claim_coins($1,$2)', [actor, randomUUID()]));
}

async function gift(actor: string, room: string, quantity = 1, giftId = ROSE) {
  const result = await asApp((client) => client.query('SELECT * FROM public.du_send_gift($1,$2,$3,$4::bigint,$5)', [actor, room, giftId, quantity, randomUUID()]));
  return result.rows[0];
}

async function likes(actor: string, room: string, count = 1, key = randomUUID()) {
  const result = await asApp((client) => client.query('SELECT * FROM public.stream_send_likes($1,$2,$3,$4)', [actor, room, count, key]));
  return result.rows[0];
}

// Only the migration owner can modify a deadline fixture. The guard is disabled
// transactionally in this dedicated test database, then restored before commit.
async function deadline(battle: string, column: 'ends_at' | 'invitation_expires_at', offsetMs = 0) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE public.pk_battles DISABLE TRIGGER pk_battles_guard');
    await client.query(`UPDATE public.pk_battles SET ${column}=clock_timestamp()+($2::text || ' milliseconds')::interval WHERE id=$1`, [battle, offsetMs]);
    await client.query('ALTER TABLE public.pk_battles ENABLE TRIGGER pk_battles_guard');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('invitations preserve participants, UUID idempotency and server-owned timing', async () => {
  const f = await fixture();
  assert.equal(await snapshot(f.host.id), undefined);
  const key = randomUUID();
  const first = await invite(f, key);
  assert.equal(first.status, 'INVITED');
  assert.equal(first.host_stream_id, f.host.id);
  assert.equal(first.guest_stream_id, f.guest.id);
  assert.equal(first.host_user_id, f.host.creator);
  assert.equal(first.guest_user_id, f.guest.creator);
  assert.equal(first.inviter_id, f.host.creator);
  assert.equal(first.duration_seconds, 300);
  assert.equal(first.starts_at, null);
  assert.equal(first.ends_at, null);
  assert.equal(first.final_host_score, null);
  assert.equal(first.final_guest_score, null);
  assert.ok(first.invitation_expires_at.getTime() > first.created_at.getTime());
  const repeats = await Promise.all(Array.from({ length: 5 }, () => invite(f, key)));
  assert.ok(repeats.every((row) => row.id === first.id));
  await failure(() => invite(f, key, 180), 'PK_IDEMPOTENCY_CONFLICT');
  const third = await stream();
  await failure(() => invite({ ...f, guest: third }, key), 'PK_IDEMPOTENCY_CONFLICT');
  await respond(f.host.creator, first.id, 'CANCEL');
  assert.equal((await invite(f, key)).id, first.id);
  assert.equal((await invite(f, key)).status, 'CANCELED');
});

test('only the invited live host can accept; starts and ends use the server clock', async () => {
  const f = await fixture();
  const battle = await invite(f);
  await failure(() => respond(f.host.creator, battle.id, 'ACCEPT'), 'PK_FORBIDDEN');
  await failure(() => respond(f.sender, battle.id, 'ACCEPT'), 'PK_FORBIDDEN');
  const beforeAccept = Date.now();
  const active = await respond(f.guest.creator, battle.id, 'ACCEPT');
  assert.equal(active.status, 'ACTIVE');
  assert.ok(active.starts_at.getTime() >= beforeAccept - 1_000);
  assert.equal(active.ends_at.getTime() - active.starts_at.getTime(), 300_000);
  assert.equal((await respond(f.guest.creator, battle.id, 'ACCEPT')).starts_at.getTime(), active.starts_at.getTime());
  await failure(() => respond(f.host.creator, battle.id, 'CANCEL'), 'PK_STATE_CONFLICT');
  const fromBothSides = await Promise.all([snapshot(f.host.id), snapshot(f.guest.id)]);
  assert.ok(fromBothSides.every((row) => row.id === active.id && row.host_score === '0' && row.guest_score === '0'));
  assert.ok(fromBothSides.every((row) => row.server_now instanceof Date));
  const finished = await respond(f.host.creator, battle.id, 'LEAVE');
  assert.equal(finished.status, 'FINISHED');
  assert.equal(finished.winner_stream_id, f.guest.id);
  assert.equal((await respond(f.host.creator, battle.id, 'LEAVE')).settled_at.getTime(), finished.settled_at.getTime());
});

test('cross-role concurrent invitations reserve each stream at most once', async () => {
  const f = await fixture();
  const third = await stream();
  const results = await Promise.allSettled([
    invite(f),
    invite({ ...f, host: third, guest: f.host }),
    invite({ ...f, host: f.guest, guest: third }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') {
    assert.equal(result.reason.code, '23514');
    assert.match(result.reason.message, /PK_BUSY/);
  }
  const overlaps = await pool.query(`SELECT participant,count(*)::int AS n FROM (
    SELECT host_stream_id AS participant FROM pk_battles WHERE status IN ('INVITED','ACTIVE')
    UNION ALL SELECT guest_stream_id FROM pk_battles WHERE status IN ('INVITED','ACTIVE')
  ) active WHERE participant = ANY($1::uuid[]) GROUP BY participant`, [[f.host.id, f.guest.id, third.id]]);
  assert.ok(overlaps.rows.every((row) => row.n === 1));
});

test('invitation authorization rejects missing, same, ended, inactive and blocked participants', async () => {
  const f = await fixture();
  await failure(() => invite(f, randomUUID(), 1), 'PK_INVALID_REQUEST');
  await failure(() => invite({ ...f, guest: f.host }), 'PK_INVALID_REQUEST');
  await failure(() => asApp((client) => client.query('SELECT * FROM pk_invite($1,$2,$3,$4,300)', [f.sender, f.host.id, f.guest.id, randomUUID()])), 'PK_FORBIDDEN');
  await failure(() => invite({ ...f, guest: { ...f.guest, id: randomUUID() } }), 'PK_STREAM_UNAVAILABLE');
  for (const [blocker, blocked] of [[f.host.creator, f.guest.creator], [f.guest.creator, f.host.creator]]) {
    await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)', [blocker, blocked]);
    await failure(() => invite(f), 'PK_BLOCKED');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [blocker, blocked]);
  }
  await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [f.guest.creator]);
  await failure(() => invite(f), 'PK_ACCOUNT_UNAVAILABLE');
  await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [f.guest.creator]);
  await pool.query("UPDATE live_streams SET status='ENDED',ended_at=now() WHERE id=$1", [f.guest.id]);
  await failure(() => invite(f), 'PK_STREAM_UNAVAILABLE');
});

test('accept rechecks current accounts, blocks and live stream status', async () => {
  for (const invalidation of ['block', 'account', 'stream']) {
    const f = await fixture();
    const battle = await invite(f);
    if (invalidation === 'block') {
      await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)', [f.guest.creator, f.host.creator]);
    } else if (invalidation === 'account') {
      await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [f.host.creator]);
    } else {
      await pool.query("UPDATE live_streams SET status='ENDED',ended_at=now() WHERE id=$1", [f.host.id]);
    }
    const result = await respond(f.guest.creator, battle.id, 'ACCEPT');
    assert.equal(result.status, 'CANCELED', invalidation);
    assert.equal(result.starts_at, null, invalidation);
    assert.equal(result.finish_reason, invalidation === 'block' ? 'BLOCKED' : 'STREAM_UNAVAILABLE');
  }
});

test('decline, cancel and expired invitations release both streams without starting a battle', async () => {
  const f = await fixture();
  const declined = await invite(f);
  assert.equal((await respond(f.guest.creator, declined.id, 'DECLINE')).status, 'DECLINED');
  const canceled = await invite(f);
  assert.equal((await respond(f.host.creator, canceled.id, 'CANCEL')).status, 'CANCELED');
  const expired = await invite(f);
  await deadline(expired.id, 'invitation_expires_at');
  const lateAcceptance = await respond(f.guest.creator, expired.id, 'ACCEPT');
  assert.equal(lateAcceptance.status, 'CANCELED');
  assert.equal(lateAcceptance.finish_reason, 'INVITATION_EXPIRED');
  assert.equal(lateAcceptance.starts_at, null);
  const row = await snapshot(f.host.id);
  assert.equal(row.id, expired.id);
  assert.equal(row.status, 'CANCELED');
  assert.equal(row.starts_at, null);
  assert.equal((await invite(f)).status, 'INVITED');
});

test('scores count only committed DU gift debits inside the accepted battle window', async () => {
  const f = await fixture();
  await claim(f.sender);
  await gift(f.sender, f.host.id, 7);
  const battle = await invite(f);
  await respond(f.guest.creator, battle.id, 'ACCEPT');
  await gift(f.sender, f.host.id, 3, HEART);
  await gift(f.sender, f.guest.id, 2, HEART);
  await likes(f.sender, f.guest.id, 20);
  const unrelated = await stream();
  await gift(f.sender, unrelated.id, 9);
  const live = await snapshot(f.host.id);
  assert.equal(live.status, 'ACTIVE');
  assert.equal(live.host_score, '15');
  assert.equal(live.guest_score, '10');
  await deadline(battle.id, 'ends_at');
  await gift(f.sender, f.guest.id, 30);
  const final = await snapshot(f.guest.id);
  assert.equal(final.status, 'FINISHED');
  assert.equal(final.final_host_score, '15');
  assert.equal(final.final_guest_score, '10');
  assert.equal(final.winner_stream_id, f.host.id);
  await gift(f.sender, f.guest.id, 10);
  const repeated = await snapshot(f.host.id);
  assert.equal(repeated.host_score, '15');
  assert.equal(repeated.guest_score, '10');
  assert.equal(repeated.settled_at.getTime(), final.settled_at.getTime());
});

test('equal DU totals settle as a tie and active stream departure forfeits to the peer', async () => {
  const f = await fixture();
  const tied = await invite(f);
  await respond(f.guest.creator, tied.id, 'ACCEPT');
  await deadline(tied.id, 'ends_at');
  const result = await snapshot(f.host.id);
  assert.equal(result.status, 'FINISHED');
  assert.equal(result.winner_stream_id, null);
  assert.equal(result.final_host_score, '0');
  assert.equal(result.final_guest_score, '0');
  const next = await invite(f);
  await respond(f.guest.creator, next.id, 'ACCEPT');
  await pool.query("UPDATE live_streams SET status='ENDED',ended_at=clock_timestamp() WHERE id=$1", [f.host.id]);
  await asApp((client) => client.query('SELECT public.pk_settle_stream($1)', [f.host.id]));
  const ended = await snapshot(f.guest.id);
  assert.equal(ended.id, next.id);
  assert.equal(ended.status, 'FINISHED');
  assert.equal(ended.winner_stream_id, f.guest.id);
  const pendingFixture = await fixture();
  const pending = await invite(pendingFixture);
  await asApp((client) => client.query('SELECT public.pk_settle_stream($1)', [pendingFixture.guest.id]));
  assert.equal((await snapshot(pendingFixture.host.id)).status, 'CANCELED');
  assert.equal((await pool.query('SELECT starts_at FROM pk_battles WHERE id=$1', [pending.id])).rows[0].starts_at, null);
});

test('presence settlement validates its battle and one or two unique actual participants', async () => {
  const f = await fixture();
  const battle = await invite(f);
  const unrelated = await stream();
  await failure(() => settleAbsent(null, [f.host.id]), 'PK_INVALID_REQUEST');
  await failure(() => settleAbsent(randomUUID(), [f.host.id]), 'PK_NOT_FOUND');
  for (const ids of [null, [], [null], [f.host.id, null], [f.host.id, f.host.id],
    [f.host.id, f.guest.id, unrelated.id], [unrelated.id], [f.host.id, unrelated.id], [randomUUID()]]) {
    await failure(() => settleAbsent(battle.id, ids), 'PK_INVALID_REQUEST');
  }
  await failure(() => asApp((client) => client.query(
    'SELECT public.pk_settle_absent($1,ARRAY[ARRAY[$2::uuid,$3::uuid]])',
    [battle.id, f.host.id, f.guest.id],
  )), 'PK_INVALID_REQUEST');
  assert.equal((await snapshot(f.host.id)).status, 'INVITED');
  const canceled = await settleAbsent(battle.id, [f.guest.id, f.host.id]);
  assert.equal(canceled.status, 'CANCELED');
  assert.equal(canceled.finish_reason, 'STREAM_UNAVAILABLE');
  assert.equal(canceled.starts_at, null);
  assert.equal(canceled.final_host_score, null);
  assert.equal(canceled.winner_stream_id, null);
  assert.deepEqual((await pool.query('SELECT DISTINCT status FROM live_streams WHERE id=ANY($1::uuid[])', [[f.host.id, f.guest.id]])).rows, [{ status: 'LIVE' }]);
});

test('one confirmed publisher absence forfeits only PK while both live rooms remain reconnectable', async () => {
  const f = await fixture();
  await claim(f.sender);
  const battle = await invite(f);
  await respond(f.guest.creator, battle.id, 'ACCEPT');
  await gift(f.sender, f.host.id, 4);
  await gift(f.sender, f.guest.id, 1);
  const final = await settleAbsent(battle.id, [f.host.id]);
  assert.equal(final.status, 'FINISHED');
  assert.equal(final.finish_reason, 'FORFEIT');
  assert.equal(final.winner_stream_id, f.guest.id);
  assert.equal(final.final_host_score, '4');
  assert.equal(final.final_guest_score, '1');
  assert.deepEqual((await pool.query('SELECT DISTINCT status FROM live_streams WHERE id=ANY($1::uuid[])', [[f.host.id, f.guest.id]])).rows, [{ status: 'LIVE' }]);
});

test('both publisher absences freeze only the current round and never settle a newer battle', async () => {
  const f = await fixture();
  await claim(f.sender);
  await gift(f.sender, f.host.id, 8);
  const prior = await invite(f);
  await respond(f.guest.creator, prior.id, 'ACCEPT');
  await gift(f.sender, f.guest.id, 7);
  await respond(f.guest.creator, prior.id, 'LEAVE');
  await gift(f.sender, f.host.id, 3);
  const battle = await invite(f);
  await respond(f.guest.creator, battle.id, 'ACCEPT');
  await gift(f.sender, f.host.id, 2, HEART);
  await gift(f.sender, f.guest.id, 3);
  const final = await settleAbsent(battle.id, [f.guest.id, f.host.id]);
  assert.equal(final.status, 'FINISHED');
  assert.equal(final.finish_reason, 'BOTH_UNAVAILABLE');
  assert.equal(final.winner_stream_id, null, 'a score lead cannot invent a winner when both publishers are absent');
  assert.equal(final.final_host_score, '10');
  assert.equal(final.final_guest_score, '3');
  assert.ok(final.settled_at.getTime() < final.ends_at.getTime());
  await gift(f.sender, f.guest.id, 5);
  await gift(f.sender, f.host.id, 2);
  assert.deepEqual(await settleAbsent(battle.id, [f.host.id]), final, 'a later single absence cannot rewrite the terminal result');

  const next = await invite(f);
  await respond(f.guest.creator, next.id, 'ACCEPT');
  assert.deepEqual(await settleAbsent(battle.id, [f.host.id, f.guest.id]), final);
  assert.equal((await snapshot(f.host.id)).id, next.id);
  assert.equal((await snapshot(f.host.id)).status, 'ACTIVE', 'an old observation is scoped to its original battle');
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT set_config('livestar.pk_battle',$1,true)", [battle.id]);
    await failure(() => connection.query("UPDATE pk_battles SET winner_stream_id=$2,finish_reason='FORFEIT' WHERE id=$1", [battle.id, f.host.id]), 'PK_HISTORY_IMMUTABLE');
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
  }
  assert.deepEqual((await pool.query('SELECT * FROM pk_battles WHERE id=$1', [battle.id])).rows[0], final);
});

test('the natural deadline wins over a late both-absent observation and excludes later gifts', async () => {
  const f = await fixture();
  await claim(f.sender);
  const battle = await invite(f);
  await respond(f.guest.creator, battle.id, 'ACCEPT');
  await gift(f.sender, f.host.id, 4);
  await gift(f.sender, f.guest.id, 1);
  await deadline(battle.id, 'ends_at');
  await gift(f.sender, f.guest.id, 20);
  const final = await settleAbsent(battle.id, [f.host.id, f.guest.id]);
  assert.equal(final.status, 'FINISHED');
  assert.equal(final.finish_reason, 'COMPLETED');
  assert.equal(final.winner_stream_id, f.host.id);
  assert.equal(final.final_host_score, '4');
  assert.equal(final.final_guest_score, '1');
  assert.ok(final.settled_at.getTime() >= final.ends_at.getTime());
});

test('both-absence finalization waits for the current DU gift commit before freezing scores', async () => {
  const f = await fixture();
  await claim(f.sender);
  const battle = await invite(f);
  await respond(f.guest.creator, battle.id, 'ACCEPT');
  const connection = await pool.connect();
  let pending: ReturnType<typeof settleAbsent> | undefined;
  try {
    await connection.query('BEGIN');
    await connection.query('SET LOCAL ROLE livestar_app');
    await connection.query('SELECT * FROM public.du_send_gift($1,$2,$3,5,$4)', [f.sender, f.host.id, ROSE, randomUUID()]);
    pending = settleAbsent(battle.id, [f.host.id, f.guest.id]);
    const early = await Promise.race([pending.then(() => 'finished'), new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 75))]);
    assert.equal(early, 'waiting');
    await connection.query('COMMIT');
    const final = await pending;
    assert.equal(final.finish_reason, 'BOTH_UNAVAILABLE');
    assert.equal(final.winner_stream_id, null);
    assert.equal(final.final_host_score, '5');
    assert.equal(final.final_guest_score, '0');
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
    if (pending) await pending.catch(() => undefined);
  }
});

test('only the restricted runtime receives the battle-bound presence RPC grant', async () => {
  const result = await pool.query(`SELECT
    has_function_privilege('livestar_app','public.pk_settle_absent(uuid,uuid[])','EXECUTE') AS runtime,
    to_regprocedure('public.pk_settle_absent(uuid[])') IS NULL AS battle_bound,
    EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid='public.pk_settle_absent(uuid,uuid[])'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute`);
  assert.deepEqual(result.rows[0], { runtime: true, battle_bound: true, public_execute: false });
});

test('finalization waits for an in-flight gift commit before freezing the score', async () => {
  const f = await fixture();
  await claim(f.sender);
  const battle = await invite(f);
  await respond(f.guest.creator, battle.id, 'ACCEPT');
  await deadline(battle.id, 'ends_at', 180);
  const connection = await pool.connect();
  let pending: ReturnType<typeof snapshot> | undefined;
  try {
    await connection.query('BEGIN');
    await connection.query('SET LOCAL ROLE livestar_app');
    await connection.query('SELECT * FROM public.du_send_gift($1,$2,$3,5,$4)', [f.sender, f.host.id, ROSE, randomUUID()]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    pending = snapshot(f.guest.id);
    const early = await Promise.race([pending.then(() => 'finished'), new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 75))]);
    assert.equal(early, 'waiting', 'a score must not freeze before the gift transaction commits');
    await connection.query('COMMIT');
    const final = await pending;
    assert.equal(final.status, 'FINISHED');
    assert.equal(final.host_score, '5');
    assert.equal(final.guest_score, '0');
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
    if (pending) await pending.catch(() => undefined);
  }
});

test('a transaction opened before the deadline cannot backdate a gift sent after finalization', async () => {
  const f = await fixture();
  await claim(f.sender);
  const battle = await invite(f);
  await respond(f.guest.creator, battle.id, 'ACCEPT');
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SET LOCAL ROLE livestar_app');
    await connection.query('SELECT now()');
    await deadline(battle.id, 'ends_at', 80);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const final = await snapshot(f.host.id);
    assert.equal(final.status, 'FINISHED');
    const late = (await connection.query('SELECT * FROM public.du_send_gift($1,$2,$3,1,$4)', [f.sender, f.host.id, ROSE, randomUUID()])).rows[0];
    await connection.query('COMMIT');
    assert.ok(late.created_at.getTime() >= final.ends_at.getTime(), 'gift timestamp must be assigned after acquiring its locks');
    assert.equal((await snapshot(f.host.id)).host_score, '0');
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
  }
});

test('invitation locks users before streams, matching activation lock order', async () => {
  const f = await fixture();
  const activation = await pool.connect();
  let pending: ReturnType<typeof invite> | undefined;
  try {
    await activation.query('BEGIN');
    await activation.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.guest.creator]);
    pending = invite(f);
    const waiting = await Promise.race([pending.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 75))]);
    assert.equal(waiting, true);
    await activation.query("UPDATE live_streams SET status='LIVE' WHERE id=$1", [f.guest.id]);
    await activation.query('COMMIT');
    assert.equal((await pending).status, 'INVITED');
  } finally {
    await activation.query('ROLLBACK');
    activation.release();
    if (pending) await pending.catch(() => undefined);
  }
});

test('likes persist exact totals and concurrent idempotent requests apply once', async () => {
  const f = await fixture();
  const key = randomUUID();
  const replies = await Promise.all(Array.from({ length: 6 }, () => likes(f.sender, f.host.id, 20, key)));
  assert.equal(new Set(replies.map((row) => row.id)).size, 1);
  assert.ok(replies.every((row) => row.total === '20' && row.count === 20));
  await failure(() => likes(f.sender, f.host.id, 19, key), 'LIKES_IDEMPOTENCY_CONFLICT');
  await failure(() => likes(f.sender, f.guest.id, 20, key), 'LIKES_IDEMPOTENCY_CONFLICT');
  assert.equal((await likes(f.sender, f.host.id, 13)).total, '33');
  const ownLike = await likes(f.host.creator, f.host.id, 4);
  assert.equal(ownLike.user_id, f.host.creator);
  assert.equal(ownLike.count, 4);
  assert.equal(ownLike.total, '37');
  const totals = await asApp((client) => client.query('SELECT sum(count)::text AS total,count(*)::int AS events FROM stream_likes WHERE stream_id=$1', [f.host.id]));
  assert.deepEqual(totals.rows[0], { total: '37', events: 3 });
  await pool.query("UPDATE live_streams SET status='ENDED',ended_at=now() WHERE id=$1", [f.host.id]);
  await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [f.sender]);
  assert.equal((await likes(f.sender, f.host.id, 20, key)).id, replies[0].id);
});

test('likes enforce the server-side 120 per minute user limit across streams and concurrent calls', async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled(Array.from({ length: 7 }, (_, index) => likes(f.sender, index % 2 ? f.host.id : f.guest.id, 20)));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 6);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  for (const outcome of outcomes) if (outcome.status === 'rejected') {
    assert.equal(outcome.reason.code, '23514');
    assert.match(outcome.reason.message, /LIKES_RATE_LIMITED/);
  }
  assert.equal((await pool.query('SELECT sum(count)::text AS n FROM stream_likes WHERE user_id=$1', [f.sender])).rows[0].n, '120');
  await failure(() => likes(f.sender, f.host.id), 'LIKES_RATE_LIMITED');
  const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename='stream_likes'");
  assert.ok(index.rows.some((row) => /\(user_id, created_at/.test(row.indexdef)), 'rate-limit lookup needs the user/time index');
});

test('likes reject invalid counts, unavailable accounts, ended streams and both block directions', async () => {
  const f = await fixture();
  for (const count of [0, -1, 21]) await failure(() => likes(f.sender, f.host.id, count), 'LIKES_INVALID_REQUEST');
  await failure(() => likes(f.sender, randomUUID()), 'LIKES_STREAM_UNAVAILABLE');
  for (const [blocker, blocked] of [[f.sender, f.host.creator], [f.host.creator, f.sender]]) {
    await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)', [blocker, blocked]);
    await failure(() => likes(f.sender, f.host.id), 'LIKES_BLOCKED');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [blocker, blocked]);
  }
  for (const actor of [f.sender, f.host.creator]) {
    await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [actor]);
    await failure(() => likes(f.sender, f.host.id), 'LIKES_ACCOUNT_UNAVAILABLE');
    await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [actor]);
  }
  await pool.query("UPDATE live_streams SET status='ENDED',ended_at=now() WHERE id=$1", [f.host.id]);
  await failure(() => likes(f.sender, f.host.id), 'LIKES_STREAM_UNAVAILABLE');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM stream_likes WHERE user_id=$1', [f.sender])).rows[0].n, 0);
});

test('runtime cannot write battle state or likes and owner cannot rewrite their audit history', async () => {
  const f = await fixture();
  const battle = await invite(f);
  const event = await likes(f.sender, f.host.id, 3);
  const third = await stream();
  const denied = [
    (client: PoolClient) => client.query("UPDATE pk_battles SET status='ACTIVE' WHERE id=$1", [battle.id]),
    (client: PoolClient) => client.query('DELETE FROM pk_battles WHERE id=$1', [battle.id]),
    (client: PoolClient) => client.query('INSERT INTO stream_likes(id,stream_id,user_id,count,idempotency_key) VALUES($1,$2,$3,20,$4)', [randomUUID(), f.host.id, f.sender, randomUUID()]),
    (client: PoolClient) => client.query('UPDATE stream_likes SET count=20 WHERE id=$1', [event.id]),
    (client: PoolClient) => client.query('DELETE FROM stream_likes WHERE id=$1', [event.id]),
  ];
  for (const operation of denied) await failure(() => asApp(operation), 'permission denied', '42501');
  await assert.rejects(() => pool.query('UPDATE pk_battles SET guest_stream_id=$1 WHERE id=$2', [third.id, battle.id]));
  await assert.rejects(() => pool.query('DELETE FROM pk_battles WHERE id=$1', [battle.id]));
  await assert.rejects(() => pool.query('UPDATE stream_likes SET count=20 WHERE id=$1', [event.id]));
  await assert.rejects(() => pool.query('DELETE FROM stream_likes WHERE id=$1', [event.id]));
  assert.equal((await pool.query('SELECT count FROM stream_likes WHERE id=$1', [event.id])).rows[0].count, 3);
});

test('runtime cannot execute internal battle mutation or trigger helpers', async () => {
  const f = await fixture();
  const battle = await invite(f);
  const helpers = [
    (client: PoolClient) => client.query('SELECT public.pk_lock_participants($1::uuid[])', [[f.host.id, f.guest.id]]),
    (client: PoolClient) => client.query('SELECT public.pk_store(NULL::public.pk_battles)'),
    (client: PoolClient) => client.query('SELECT public.pk_reconcile($1,NULL::uuid)', [battle.id]),
    (client: PoolClient) => client.query('SELECT public.guard_pk_battle()'),
    (client: PoolClient) => client.query('SELECT public.guard_stream_like()'),
  ];
  for (const helper of helpers) await failure(() => asApp(helper), 'permission denied', '42501');
  assert.equal((await snapshot(f.host.id)).status, 'INVITED');
});

test('terminal battle audit rows remain immutable even with a matching owner guard setting', async () => {
  const f = await fixture();
  const declined = await invite(f);
  await respond(f.guest.creator, declined.id, 'DECLINE');
  const canceled = await invite(f);
  await respond(f.host.creator, canceled.id, 'CANCEL');
  const finished = await invite(f);
  await respond(f.guest.creator, finished.id, 'ACCEPT');
  await respond(f.host.creator, finished.id, 'LEAVE');

  for (const battle of [declined, canceled, finished]) {
    const before = (await pool.query('SELECT status,finish_reason,final_host_score,final_guest_score,winner_stream_id,settled_at FROM pk_battles WHERE id=$1', [battle.id])).rows[0];
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('livestar.pk_battle',$1,true)", [battle.id]);
      await failure(() => connection.query("UPDATE pk_battles SET finish_reason='REWRITTEN' WHERE id=$1", [battle.id]), 'PK_HISTORY_IMMUTABLE');
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
    const after = (await pool.query('SELECT status,finish_reason,final_host_score,final_guest_score,winner_stream_id,settled_at FROM pk_battles WHERE id=$1', [battle.id])).rows[0];
    assert.deepEqual(after, before);
  }
});
