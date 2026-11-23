import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Pool, type PoolClient } from 'pg';

// Every actor and moderation record in this suite is an isolated local fixture.
// No cloud room, real account or financial posting is created here.
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) throw new Error('DATABASE_MIGRATION_URL is required for administration database tests.');
const url = new URL(ownerUrl);
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || !/test/i.test(decodeURIComponent(url.pathname))) {
  throw new Error('Administration database tests require an isolated local test database.');
}
const pool = new Pool({ connectionString: ownerUrl, max: 12, statement_timeout: 15_000 });

before(async () => {
  const result = await pool.query(`SELECT
    to_regprocedure('public.admin_set_user_status(uuid,uuid,text,text,uuid)') IS NOT NULL AS users,
    to_regprocedure('public.admin_terminate_stream(uuid,uuid,text,uuid,boolean)') IS NOT NULL AS streams,
    to_regprocedure('public.admin_review_report(uuid,uuid,text,text,uuid)') IS NOT NULL AS reports`);
  assert.deepEqual(result.rows[0], { users: true, streams: true, reports: true }, 'Apply administration migration10 first.');
});
after(async () => { await pool.end(); });

async function asApp<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE livestar_app');
    const value = await operation(client); await client.query('COMMIT'); return value;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function failure(operation: () => Promise<unknown>, tag: string, code = '23514'): Promise<void> {
  await assert.rejects(operation, (error: Error & { code?: string }) => {
    assert.equal(error.code, code, error.message);
    assert.ok(error.message.includes(tag), error.message); return true;
  });
}
async function user(role = 'USER'): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO public.users(id,email,updated_at) VALUES($1,$2,now())', [id, `admin-db-${id}@integration.invalid`]);
  await pool.query('INSERT INTO public.user_profiles(user_id,username,display_name) VALUES($1,$2,$3)', [id, `adm_${id.replaceAll('-', '').slice(0, 24)}`, 'Admin database fixture']);
  await pool.query('INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name=$2', [id, role]);
  return id;
}
async function session(userId: string, clientType = 'WEB'): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO public.sessions(id,user_id,refresh_token_hash,family_id,client_type,expires_at)
    VALUES($1,$2,$3,$4,$5::public."SessionClientType",now()+interval '1 day')`, [id, userId, randomUUID().replaceAll('-', '').padEnd(64, '0'), randomUUID(), clientType]);
  return id;
}
async function stream(creator?: string, status = 'LIVE'): Promise<string> {
  const id = randomUUID(); creator ??= await user();
  await pool.query(`INSERT INTO public.live_streams(id,creator_id,title,livekit_room,status,started_at,ended_at)
    VALUES($1,$2,'Administration fixture',$3,$4::public."StreamStatus",
      CASE WHEN $4='SCHEDULED' THEN NULL ELSE now() END,
      CASE WHEN $4 IN('ENDED','TERMINATED') THEN now() ELSE NULL END)`, [id, creator, `admin-db-${id}`, status]);
  return id;
}
async function report(): Promise<string> {
  const id = randomUUID(); const reporter = await user(); const target = await user();
  await pool.query(`INSERT INTO public.reports(id,reporter_id,target_user_id,reason_code,details)
    VALUES($1,$2,$3,'STREAM_REPORT','Administration fixture report')`, [id, reporter, target]);
  return id;
}
async function setStatus(actor: string | null, target: string | null, status = 'SUSPENDED', reason: string | null = 'Fixture account review', key: string | null = randomUUID()) {
  return (await asApp(client => client.query('SELECT * FROM public.admin_set_user_status($1,$2,$3,$4,$5)', [actor, target, status, reason, key]))).rows[0];
}
async function terminate(actor: string | null, id: string | null, reason: string | null = 'Fixture stream review', key: string | null = randomUUID(), stopped: boolean | null = false) {
  return (await asApp(client => client.query('SELECT * FROM public.admin_terminate_stream($1,$2,$3,$4,$5)', [actor, id, reason, key, stopped]))).rows[0];
}
async function review(actor: string | null, id: string | null, status = 'REVIEWING', reason: string | null = 'Fixture report review', key: string | null = randomUUID()) {
  return (await asApp(client => client.query('SELECT * FROM public.admin_review_report($1,$2,$3,$4,$5)', [actor, id, status, reason, key]))).rows[0];
}
async function audit(actor: string, key: string) {
  return (await pool.query('SELECT * FROM public.admin_audit_logs WHERE actor_id=$1 AND request_id=$2 ORDER BY created_at,id', [actor, key])).rows;
}

test('administration grants only three public RPCs and does not broaden raw writes or private helper execution', async () => {
  const result = await pool.query(`SELECT
    has_function_privilege('livestar_app','public.admin_set_user_status(uuid,uuid,text,text,uuid)','EXECUTE') AS users,
    has_function_privilege('livestar_app','public.admin_terminate_stream(uuid,uuid,text,uuid,boolean)','EXECUTE') AS streams,
    has_function_privilege('livestar_app','public.admin_review_report(uuid,uuid,text,text,uuid)','EXECUTE') AS reports,
    has_function_privilege('livestar_app','public.admin_request_lock(uuid,uuid,text,uuid)','EXECUTE') AS request_helper,
    has_function_privilege('livestar_app','public.admin_lock_actor(uuid,uuid)','EXECUTE') AS actor_helper,
    has_function_privilege('livestar_app','public.guard_terminated_stream()','EXECUTE') AS trigger_helper,
    has_column_privilege('livestar_app','public.users','status','UPDATE') AS user_status,
    has_table_privilege('livestar_app','public.user_roles','INSERT') AS roles,
    has_column_privilege('livestar_app','public.reports','status','UPDATE') AS report_status,
    has_table_privilege('livestar_app','public.moderation_actions','INSERT') AS raw_moderation,
    has_table_privilege('livestar_app','public.wallet_ledger','INSERT') AS finance`);
  assert.deepEqual(result.rows[0], { users: true, streams: true, reports: true, request_helper: false, actor_helper: false, trigger_helper: false, user_status: false, roles: false, report_status: false, raw_moderation: false, finance: false });
});

test('normal members and moderators cannot use any administration mutation', async () => {
  const target = await user(), room = await stream(), receipt = await report();
  for (const role of ['USER', 'CREATOR', 'MODERATOR']) {
    const actor = await user(role);
    await failure(() => setStatus(actor, target), 'ADMIN_FORBIDDEN');
    await failure(() => terminate(actor, room), 'ADMIN_FORBIDDEN');
    await failure(() => review(actor, receipt), 'ADMIN_FORBIDDEN');
  }
});

test('invalid identity, keys, status and bounded reasons fail without leaving audit or moderation records', async () => {
  const actor = await user('ADMIN'), target = await user();
  for (const args of [[null, target, 'SUSPENDED', 'Valid reason', randomUUID()], [actor, null, 'SUSPENDED', 'Valid reason', randomUUID()], [actor, target, 'SUSPENDED', 'Valid reason', null], [actor, target, 'DELETED', 'Valid reason', randomUUID()], [actor, target, 'SUSPENDED', null, randomUUID()], [actor, target, 'SUSPENDED', ' \n ', randomUUID()], [actor, target, 'SUSPENDED', 'a'.repeat(1001), randomUUID()]] as const) {
    await failure(() => setStatus(args[0], args[1], args[2], args[3], args[4]), 'ADMIN_INVALID_REQUEST');
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.admin_audit_logs WHERE actor_id=$1', [actor])).rows[0].count, 0);
});

test('suspension atomically revokes both session channels and records one moderation event and audit', async () => {
  const actor = await user('SUPER_ADMIN'), target = await user();
  await session(target); await session(target, 'MOBILE'); const key = randomUUID();
  const result = await setStatus(actor, target, 'SUSPENDED', '  Fixture restriction  ', key);
  assert.equal(result.status, 'SUSPENDED');
  const sessions = await pool.query('SELECT revoked_at FROM public.sessions WHERE user_id=$1', [target]);
  assert.equal(sessions.rows.length, 2); assert.ok(sessions.rows.every(row => row.revoked_at));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.moderation_actions WHERE target_user_id=$1 AND type='SUSPEND'", [target])).rows[0].count, 1);
  const events = await audit(actor, key); assert.equal(events.length, 1);
  assert.equal(events[0].action, 'ADMIN_USER_SUSPENDED');
  assert.deepEqual(events[0].before, { status: 'ACTIVE' });
  assert.deepEqual(events[0].after, { operation: 'SET_USER_STATUS', status: 'SUSPENDED', reason: 'Fixture restriction' });
});

test('a failed outer transaction rolls back suspension, both session revocations and all moderation evidence together', async () => {
  const actor = await user('ADMIN'), target = await user(), key = randomUUID();
  await session(target); await session(target, 'MOBILE');
  await assert.rejects(() => asApp(async client => {
    await client.query('SELECT public.admin_set_user_status($1,$2,$3,$4,$5)', [actor, target, 'SUSPENDED', 'Roll back the whole request', key]);
    throw new Error('Fixture failure after mutation');
  }), /Fixture failure after mutation/);
  assert.equal((await pool.query('SELECT status FROM public.users WHERE id=$1', [target])).rows[0].status, 'ACTIVE');
  assert.ok((await pool.query('SELECT revoked_at FROM public.sessions WHERE user_id=$1', [target])).rows.every(row => row.revoked_at === null));
  assert.equal((await audit(actor, key)).length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.moderation_actions WHERE target_user_id=$1', [target])).rows[0].count, 0);
});

test('concurrent exact suspension retries apply once and key reuse cannot change the target or request body', async () => {
  const actor = await user('ADMIN'), target = await user(), another = await user(); const key = randomUUID();
  const rows = await Promise.all(Array.from({ length: 5 }, () => setStatus(actor, target, 'SUSPENDED', 'Same fixture request', key)));
  assert.ok(rows.every(row => row.status === 'SUSPENDED')); assert.equal((await audit(actor, key)).length, 1);
  await failure(() => setStatus(actor, another, 'SUSPENDED', 'Same fixture request', key), 'ADMIN_IDEMPOTENCY_CONFLICT');
  await failure(() => setStatus(actor, target, 'ACTIVE', 'Same fixture request', key), 'ADMIN_IDEMPOTENCY_CONFLICT');
  await failure(() => setStatus(actor, target, 'SUSPENDED', 'Changed fixture reason', key), 'ADMIN_IDEMPOTENCY_CONFLICT');
  assert.equal((await pool.query('SELECT status FROM public.users WHERE id=$1', [another])).rows[0].status, 'ACTIVE');
});

test('self and every staff account are protected and unavailable targets cannot be restored', async () => {
  const actor = await user('SUPER_ADMIN');
  await failure(() => setStatus(actor, actor), 'ADMIN_TARGET_PROTECTED');
  for (const role of ['ADMIN', 'SUPER_ADMIN', 'MODERATOR']) await failure(async () => setStatus(actor, await user(role)), 'ADMIN_TARGET_PROTECTED');
  const target = await user();
  await pool.query("UPDATE public.users SET status='DELETION_PENDING',deleted_at=now() WHERE id=$1", [target]);
  await failure(() => setStatus(actor, target, 'ACTIVE'), 'ADMIN_TARGET_UNAVAILABLE');
  await failure(() => setStatus(actor, randomUUID()), 'ADMIN_NOT_FOUND');
});

test('restore requires media-session cleanup, never restores revoked sessions, and stale suspension replay cannot suspend again', async () => {
  const actor = await user('ADMIN'), target = await user(); const room = await stream(target, 'SCHEDULED'); const oldKey = randomUUID();
  const oldSession = await session(target);
  await setStatus(actor, target, 'SUSPENDED', 'Suspension before cleanup', oldKey);
  await failure(() => setStatus(actor, target, 'ACTIVE'), 'ADMIN_STATE_CONFLICT');
  const stopKey = randomUUID(); await terminate(actor, room, 'Fixture media cleanup', stopKey); await terminate(actor, room, 'Fixture media cleanup', stopKey, true);
  assert.equal((await setStatus(actor, target, 'ACTIVE')).status, 'ACTIVE');
  assert.ok((await pool.query('SELECT revoked_at FROM public.sessions WHERE id=$1', [oldSession])).rows[0].revoked_at);
  const freshSession = await session(target, 'MOBILE');
  const replay = await setStatus(actor, target, 'SUSPENDED', 'Suspension before cleanup', oldKey);
  assert.equal(replay.status, 'ACTIVE'); assert.equal((await audit(actor, oldKey)).length, 1);
  assert.equal((await pool.query('SELECT revoked_at FROM public.sessions WHERE id=$1', [freshSession])).rows[0].revoked_at, null);
});

test('replayed requests recheck actor roles and availability rather than preserving revoked administrator access', async () => {
  const actor = await user('ADMIN'), target = await user(), key = randomUUID();
  await setStatus(actor, target, 'SUSPENDED', 'Original authorized request', key);
  await pool.query('DELETE FROM public.user_roles WHERE user_id=$1', [actor]);
  await failure(() => setStatus(actor, target, 'SUSPENDED', 'Original authorized request', key), 'ADMIN_FORBIDDEN');
  await pool.query("INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name='ADMIN'", [actor]);
  await pool.query("UPDATE public.users SET status='SUSPENDED' WHERE id=$1", [actor]);
  await failure(() => setStatus(actor, target, 'SUSPENDED', 'Original authorized request', key), 'ADMIN_ACCOUNT_UNAVAILABLE');
});

test('stream reservation replays, stream confirmations and report replays reject revoked or deleted actors', async () => {
  const actor = await user('ADMIN'), room = await stream(), receipt = await report(), stopKey = randomUUID(), reviewKey = randomUUID();
  await terminate(actor, room, 'Authorized pending cleanup', stopKey);
  await review(actor, receipt, 'RESOLVED', 'Authorized report decision', reviewKey);
  await pool.query('DELETE FROM public.user_roles WHERE user_id=$1', [actor]);
  for (const stopped of [false, true]) await failure(() => terminate(actor, room, 'Authorized pending cleanup', stopKey, stopped), 'ADMIN_FORBIDDEN');
  await failure(() => review(actor, receipt, 'RESOLVED', 'Authorized report decision', reviewKey), 'ADMIN_FORBIDDEN');
  await pool.query("INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name='ADMIN'", [actor]);
  await pool.query("UPDATE public.users SET status='DELETION_PENDING',deleted_at=now() WHERE id=$1", [actor]);
  await failure(() => terminate(actor, room, 'Authorized pending cleanup', stopKey, true), 'ADMIN_ACCOUNT_UNAVAILABLE');
  await failure(() => review(actor, receipt, 'RESOLVED', 'Authorized report decision', reviewKey), 'ADMIN_ACCOUNT_UNAVAILABLE');
  assert.equal((await pool.query('SELECT status FROM public.live_streams WHERE id=$1', [room])).rows[0].status, 'LIVE');
  assert.equal((await audit(actor, stopKey)).length, 1);
  assert.equal((await audit(actor, reviewKey)).length, 1);
});

test('competing same-key requests bind exactly one target before mutation', async () => {
  const actor = await user('ADMIN'), one = await user(), two = await user(), key = randomUUID();
  const results = await Promise.allSettled([setStatus(actor, one, 'SUSPENDED', 'Concurrent bound request', key), setStatus(actor, two, 'SUSPENDED', 'Concurrent bound request', key)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const rejected = results.find(row => row.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /ADMIN_IDEMPOTENCY_CONFLICT/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.users WHERE id=ANY($1::uuid[]) AND status='SUSPENDED'", [[one, two]])).rows[0].count, 1);
});

test('stream preparation durably reserves a key without claiming the media stopped or creating a terminal state', async () => {
  const actor = await user('ADMIN'), room = await stream(), key = randomUUID();
  const first = await terminate(actor, room, 'Review running broadcast', key);
  assert.equal(first.status, 'LIVE'); assert.equal(first.ended_at, null);
  await terminate(actor, room, 'Review running broadcast', key);
  const events = await audit(actor, key); assert.equal(events.length, 1);
  assert.equal(events[0].action, 'ADMIN_STREAM_STOP_REQUESTED'); assert.equal(events[0].after.phase, 'REQUESTED');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.moderation_actions WHERE stream_id=$1', [room])).rows[0].count, 0);
});

test('media confirmation requires a prior reservation and closed historical sessions cannot initiate termination', async () => {
  const actor = await user('ADMIN'), room = await stream();
  await failure(() => terminate(actor, room, 'No prior reservation', randomUUID(), true), 'ADMIN_STATE_CONFLICT');
  await failure(async () => terminate(actor, await stream(undefined, 'ENDED')), 'ADMIN_STATE_CONFLICT');
  await failure(() => terminate(actor, room, 'Invalid media flag', randomUUID(), null), 'ADMIN_INVALID_REQUEST');
});

test('confirmed stream termination appends both phases once and repeats do not rewrite its time or moderation', async () => {
  const actor = await user('ADMIN'), room = await stream(), key = randomUUID();
  await terminate(actor, room, 'Confirmed fixture stop', key);
  const finals = await Promise.all(Array.from({ length: 4 }, () => terminate(actor, room, 'Confirmed fixture stop', key, true)));
  const final = finals[0];
  assert.equal(final.status, 'TERMINATED'); assert.ok(final.ended_at);
  assert.ok(finals.every(row => row.status === 'TERMINATED' && row.ended_at.toISOString() === final.ended_at.toISOString()));
  for (const stopped of [false, true]) {
    const replay = await terminate(actor, room, 'Confirmed fixture stop', key, stopped);
    assert.equal(replay.ended_at.toISOString(), final.ended_at.toISOString());
  }
  assert.equal((await audit(actor, key)).length, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.moderation_actions WHERE stream_id=$1', [room])).rows[0].count, 1);
});

test('conflicting stream reservation cannot touch a second room or reuse another mutation key', async () => {
  const actor = await user('ADMIN'), one = await stream(), two = await stream(), key = randomUUID();
  const results = await Promise.allSettled([terminate(actor, one, 'Bound stream request', key), terminate(actor, two, 'Bound stream request', key)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const rejected = results.find(row => row.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /ADMIN_IDEMPOTENCY_CONFLICT/);
  assert.equal((await audit(actor, key)).length, 1);
  assert.ok((await pool.query('SELECT status FROM public.live_streams WHERE id=ANY($1::uuid[])', [[one, two]])).rows.every(row => row.status === 'LIVE'));
  await failure(async () => setStatus(actor, await user(), 'SUSPENDED', 'Bound stream request', key), 'ADMIN_IDEMPOTENCY_CONFLICT');
});

test('a reserved live stream remains terminated when an owner-end response races its media cleanup', async () => {
  const actor = await user('ADMIN'), room = await stream(), key = randomUUID();
  await terminate(actor, room, 'Moderation wins owner-end race', key);
  await pool.query("UPDATE public.live_streams SET status='ENDED',ended_at=now() WHERE id=$1", [room]);
  const final = await terminate(actor, room, 'Moderation wins owner-end race', key, true);
  assert.equal(final.status, 'TERMINATED');
  await failure(() => pool.query("UPDATE public.live_streams SET status='ENDED' WHERE id=$1", [room]), 'ADMIN_TERMINATED_IMMUTABLE');
  await failure(() => pool.query("UPDATE public.live_streams SET status='LIVE' WHERE id=$1", [room]), 'ADMIN_TERMINATED_IMMUTABLE');
  await failure(() => pool.query("UPDATE public.live_streams SET ended_at=ended_at+interval '1 second' WHERE id=$1", [room]), 'ADMIN_TERMINATED_IMMUTABLE');
});

test('another authorized termination request for a terminated room does not duplicate moderation', async () => {
  const actor = await user('SUPER_ADMIN'), room = await stream(), key = randomUUID();
  await terminate(actor, room, 'First confirmed stop', key); await terminate(actor, room, 'First confirmed stop', key, true);
  const another = randomUUID(); const result = await terminate(actor, room, 'Already terminated confirmation', another);
  assert.equal(result.status, 'TERMINATED');
  assert.equal((await audit(actor, another)).length, 1);
  assert.equal((await audit(actor, another))[0].action, 'ADMIN_STREAM_TERMINATED');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.moderation_actions WHERE stream_id=$1', [room])).rows[0].count, 1);
});

test('report decisions are atomic, terminal and body-bound with immutable decision times', async () => {
  const actor = await user('ADMIN'), receipt = await report(), reviewKey = randomUUID(), finalKey = randomUUID();
  assert.equal((await review(actor, receipt, 'REVIEWING', 'Review fixture evidence', reviewKey)).status, 'REVIEWING');
  const final = await review(actor, receipt, 'RESOLVED', 'Resolved fixture evidence', finalKey);
  assert.equal(final.status, 'RESOLVED'); assert.ok(final.resolved_at);
  const replay = await review(actor, receipt, 'RESOLVED', 'Resolved fixture evidence', finalKey);
  assert.equal(replay.resolved_at.toISOString(), final.resolved_at.toISOString()); assert.equal((await audit(actor, finalKey)).length, 1);
  assert.equal((await review(actor, receipt, 'REVIEWING', 'Review fixture evidence', reviewKey)).status, 'RESOLVED');
  await failure(() => review(actor, receipt, 'DISMISSED'), 'ADMIN_STATE_CONFLICT');
  await failure(() => review(actor, receipt, 'RESOLVED', 'Different resolution reason', finalKey), 'ADMIN_IDEMPOTENCY_CONFLICT');
});

test('concurrent exact report decisions apply once and competing terminal decisions cannot overwrite each other', async () => {
  const actor = await user('ADMIN'), receipt = await report(), key = randomUUID();
  await Promise.all(Array.from({ length: 4 }, () => review(actor, receipt, 'DISMISSED', 'Duplicate evidence decision', key)));
  assert.equal((await audit(actor, key)).length, 1);
  const another = await report();
  const results = await Promise.allSettled([review(actor, another, 'RESOLVED'), review(actor, another, 'DISMISSED')]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.match((results.find(row => row.status === 'rejected') as PromiseRejectedResult).reason.message, /ADMIN_STATE_CONFLICT/);
});

test('request keys are scoped to actors but cannot cross entity or operation boundaries', async () => {
  const actor = await user('ADMIN'), second = await user('SUPER_ADMIN'), one = await report(), two = await report(), key = randomUUID();
  await review(actor, one, 'REVIEWING', 'Actor scoped request', key);
  await review(second, two, 'REVIEWING', 'Actor scoped request', key);
  await failure(() => review(actor, two, 'REVIEWING', 'Actor scoped request', key), 'ADMIN_IDEMPOTENCY_CONFLICT');
  await failure(async () => terminate(actor, await stream(), 'Actor scoped request', key), 'ADMIN_IDEMPOTENCY_CONFLICT');
});

test('actor role is checked after waiting on ordered user locks', async () => {
  const actor = await user('ADMIN'), target = await user(), blocker = await pool.connect();
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE', [actor]);
    let finished = false;
    const operation = setStatus(actor, target).then(value => { finished = true; return value; }, error => { finished = true; throw error; });
    const result = operation.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(finished, false);
    await blocker.query('DELETE FROM public.user_roles WHERE user_id=$1', [actor]); await blocker.query('COMMIT');
    const error = await result; assert.match(error.message, /ADMIN_FORBIDDEN/);
    assert.equal((await pool.query('SELECT status FROM public.users WHERE id=$1', [target])).rows[0].status, 'ACTIVE');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

test('runtime cannot bypass administration RPCs and even the owner cannot rewrite the audit', async () => {
  const actor = await user('SUPER_ADMIN'), target = await user(), receipt = await report(), key = randomUUID();
  await setStatus(actor, target, 'SUSPENDED', 'Immutable administration evidence', key);
  await failure(() => asApp(client => client.query("UPDATE public.users SET status='ACTIVE' WHERE id=$1", [target])), 'permission denied', '42501');
  await failure(() => asApp(client => client.query("UPDATE public.reports SET status='DISMISSED' WHERE id=$1", [receipt])), 'permission denied', '42501');
  await failure(() => asApp(client => client.query("INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name='SUPER_ADMIN'", [target])), 'permission denied', '42501');
  await failure(() => pool.query("UPDATE public.admin_audit_logs SET action='REWRITTEN' WHERE actor_id=$1 AND request_id=$2", [actor, key]), 'Append-only record');
  await failure(() => pool.query('DELETE FROM public.admin_audit_logs WHERE actor_id=$1 AND request_id=$2', [actor, key]), 'Append-only record');
});
