import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';

// Media publication is tested by pk.browser.test.mjs. These local SQL fixtures
// exercise the real restricted-role API and database, never a cloud account.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function localUrl(raw, protocols, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid local test URL.`); }
  assert.ok(protocols.includes(url.protocol) && loopback.has(url.hostname.toLowerCase()), `${label} must use loopback; cloud fixtures are forbidden.`);
  return url;
}
const migration = localUrl(process.env.DATABASE_MIGRATION_URL, ['postgres:', 'postgresql:'], 'DATABASE_MIGRATION_URL');
const runtime = localUrl(process.env.DATABASE_URL, ['postgres:', 'postgresql:'], 'DATABASE_URL');
assert.match(decodeURIComponent(migration.pathname), /(?:^|[_-])test(?:$|[_-])/i, 'Use an isolated test database.');
assert.equal(runtime.pathname, migration.pathname); assert.equal(runtime.port, migration.port);
assert.equal(decodeURIComponent(runtime.username), 'livestar_app', 'The actual API must use its restricted application role.');
const endpoint = localUrl(process.env.PK_TEST_API_URL || process.env.LIVE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', ['http:', 'https:'], 'PK_TEST_API_URL');
assert.equal(endpoint.pathname.replace(/\/$/, ''), '/api/v1');
assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
localUrl(process.env.LIVEKIT_URL, ['ws:', 'wss:'], 'LIVEKIT_URL');
localUrl(process.env.LIVEKIT_API_URL, ['http:', 'https:'], 'LIVEKIT_API_URL');
const base = endpoint.origin + '/api/v1';
const owner = new pg.Pool({ connectionString: migration.href, max: 2 });
const app = new pg.Pool({ connectionString: runtime.href, max: 4 });

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}
function success(result, label = 'request') {
  assert.equal(result.status, 200, `${label} failed with HTTP ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}
function denial(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.data));
  if (code) assert.equal(result.data?.code, code);
}
async function account(label, accounts) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
  const identity = { email: `pk-${label}-${suffix}@integration.invalid`, username: `pk_${suffix}`, password: `PkFixture_${suffix}!` };
  const registered = await call('/auth/mobile/register', { method: 'POST', body: {
    ...identity, displayName: `PK ${label}`, birthDate: '1990-01-01', locale: 'en',
    termsVersion: '2026-11-07', privacyVersion: '2026-11-07', acceptTerms: true, acceptPrivacy: true,
  } });
  assert.equal(registered.status, 201, 'Create each disposable ordinary member through normal registration.');
  const fixture = { ...registered.data, identity };
  accounts.push(fixture);
  const roles = await owner.query('SELECT u.status,r.name FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.id=$1', [fixture.user.id]);
  assert.deepEqual(roles.rows, [{ status: 'ACTIVE', name: 'USER' }]);
  return fixture;
}

test('PK and likes: actual authorization, gift score boundaries, atomic quotas, settlement and retained immutable audit', { timeout: 120_000 }, async t => {
  const artifact = resolve(process.cwd(), 'artifacts');
  mkdirSync(artifact, { recursive: true });
  const report = { localOnly: true, passed: false, checks: [], cleanup: {}, startedAt: new Date().toISOString() };
  const accounts = [], streams = [], battles = [];
  let host, guest, outsider, sender;
  async function invite(key = randomUUID(), opponentId = guest.streamId) {
    const result = await app.query('SELECT * FROM public.pk_invite($1::uuid,$2::uuid,$3::uuid,$4::uuid,300)', [host.user.id, host.streamId, opponentId, key]);
    const row = result.rows[0];
    if (!battles.includes(row.id)) battles.push(row.id);
    return row;
  }
  async function active() {
    const pending = await invite();
    const result = await app.query("SELECT * FROM public.pk_respond($1::uuid,$2::uuid,'ACCEPT')", [guest.user.id, pending.id]);
    assert.equal(result.rows[0].status, 'ACTIVE');
    return result.rows[0];
  }
  const snapshot = () => call(`/streams/${host.streamId}/battle`).then(result => success(result, 'battle snapshot').battle);
  const action = (user, id, name) => call(`/battles/${id}/${name}`, { method: 'POST', token: user?.accessToken, body: {} });
  const check = (name, body) => t.test(name, async () => {
    try { await body(); report.checks.push({ name, passed: true }); }
    catch (error) { report.checks.push({ name, passed: false, message: error.message }); throw error; }
  });
  // Only nonterminal fixture clocks may be arranged. The owner transaction
  // rolls trigger changes back on error; terminal snapshots are never edited.
  async function expire(id, status) {
    assert.ok(battles.includes(id), 'Only a battle created by this test may have its clock arranged.');
    if (status === 'ACTIVE') await new Promise(resolve => setTimeout(resolve, 10));
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query('ALTER TABLE public.pk_battles DISABLE TRIGGER pk_battles_guard');
      const sql = status === 'INVITED'
        ? "UPDATE public.pk_battles SET created_at=clock_timestamp()-interval '2 minutes',invitation_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1 AND status='INVITED' AND host_user_id=$2 AND guest_user_id=$3 RETURNING id"
        : "UPDATE public.pk_battles SET ends_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1 AND status='ACTIVE' AND host_user_id=$2 AND guest_user_id=$3 RETURNING id";
      assert.equal((await client.query(sql, [id, host.user.id, guest.user.id])).rowCount, 1);
      await client.query('ALTER TABLE public.pk_battles ENABLE TRIGGER pk_battles_guard');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  try {
    assert.equal((await owner.query('SELECT current_database() AS name')).rows[0].name, decodeURIComponent(migration.pathname.slice(1)));
    assert.equal((await app.query('SELECT current_user AS name')).rows[0].name, 'livestar_app');
    for (const label of ['host', 'guest', 'outsider', 'sender']) await account(label, accounts);
    [host, guest, outsider, sender] = accounts;
    for (const user of [host, guest, outsider]) {
      user.streamId = randomUUID(); streams.push(user.streamId);
      await owner.query("INSERT INTO live_streams(id,creator_id,title,status,livekit_room,started_at) VALUES($1,$2,$3,'LIVE',$4,clock_timestamp())",
        [user.streamId, user.user.id, 'Local PK business-rule fixture; no media publication', `pk-test-${user.streamId}`]);
    }
    const catalog = success(await call('/gifts'), 'gift catalog');
    const gift = [...catalog.items].sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)))[0];
    const price = BigInt(gift.price); assert.ok(price > 0n && price <= 10n);
    const sendGift = (streamId, quantity = 1, key = randomUUID()) => call(`/streams/${streamId}/gifts`, { method: 'POST', token: sender.accessToken, body: { giftId: gift.id, quantity, idempotencyKey: key } });
    const like = (user, streamId = host.streamId, count = 20, key = randomUUID()) => call(`/streams/${streamId}/likes`, { method: 'POST', token: user?.accessToken, body: { count, idempotencyKey: key } });
    success(await call('/wallet/claim', { method: 'POST', token: sender.accessToken, body: { idempotencyKey: randomUUID() } }), 'real promotional claim');

    await check('normal API rejects forged ownership and unpublished rooms', async () => {
      const body = { opponentStreamId: guest.streamId, idempotencyKey: randomUUID() };
      denial(await call(`/streams/${host.streamId}/battles`, { method: 'POST', body }), 401);
      denial(await call(`/streams/${host.streamId}/battles`, { method: 'POST', body, token: outsider.accessToken }), 403, 'PK_FORBIDDEN');
      denial(await call(`/streams/${host.streamId}/battles`, { method: 'POST', body, token: host.accessToken }), 409, 'PK_STREAM_UNAVAILABLE');
      for (const invalid of [
        { ...body, idempotencyKey: 'not-a-uuid' },
        { ...body, score: '999', winnerStreamId: host.streamId },
      ]) denial(await call(`/streams/${host.streamId}/battles`, { method: 'POST', body: invalid, token: host.accessToken }), 400);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM pk_battles WHERE host_stream_id=$1', [host.streamId])).rows[0].n, 0);
    });

    await check('private invitations, exact peer permissions, cancel, decline and idempotent reservation', async () => {
      const key = randomUUID();
      const pair = await Promise.all([invite(key), invite(key)]);
      assert.equal(pair[0].id, pair[1].id);
      const pending = pair[0];
      denial(await call('/battles/invitations'), 401);
      for (const user of [host, outsider, sender]) assert.deepEqual(success(await call('/battles/invitations', { token: user.accessToken })).items, []);
      assert.deepEqual(success(await call('/battles/invitations', { token: guest.accessToken })).items.map(item => item.id), [pending.id]);
      denial(await action(undefined, pending.id, 'accept'), 401);
      denial(await action(host, pending.id, 'accept'), 403, 'PK_FORBIDDEN');
      denial(await action(outsider, pending.id, 'accept'), 403, 'PK_FORBIDDEN');
      denial(await action(guest, pending.id, 'accept'), 409, 'PK_STREAM_UNAVAILABLE');
      denial(await action(guest, pending.id, 'cancel'), 403, 'PK_FORBIDDEN');
      assert.equal(success(await action(host, pending.id, 'cancel')).battle.status, 'CANCELED');
      assert.equal((await invite(key)).id, pending.id, 'A retry must return the original canceled invitation.');
      await assert.rejects(invite(key, outsider.streamId), error => error.code === '23514' && error.message === 'PK_IDEMPOTENCY_CONFLICT');
      const declined = await invite();
      denial(await action(host, declined.id, 'decline'), 403, 'PK_FORBIDDEN');
      assert.equal(success(await action(guest, declined.id, 'decline')).battle.status, 'DECLINED');
      assert.equal(success(await action(guest, declined.id, 'decline')).battle.id, declined.id);
    });

    await check('expired invitations settle from the real database clock', async () => {
      const pending = await invite();
      await expire(pending.id, 'INVITED');
      // The normal action reconciles clock expiry before processing cancel.
      const expired = success(await action(host, pending.id, 'cancel')).battle;
      assert.equal(expired.id, pending.id); assert.equal(expired.status, 'CANCELED');
      assert.equal(expired.finishReason, 'INVITATION_EXPIRED'); assert.equal(expired.winnerStreamId, null);
      assert.deepEqual(success(await call('/battles/invitations', { token: guest.accessToken })).items, []);
    });

    let scoredBattle, giftKey, debit;
    await check('only committed DU gifts inside the active interval score, with no premature winner', async () => {
      success(await sendGift(host.streamId), 'gift before PK');
      scoredBattle = await active();
      const initial = await snapshot();
      assert.equal(initial.status, 'ACTIVE'); assert.equal(initial.hostScore, '0'); assert.equal(initial.guestScore, '0');
      assert.equal(initial.winnerStreamId, null); assert.equal(new Date(initial.endsAt) - new Date(initial.startsAt), 300_000);
      const serverNow = new Date(initial.serverNow).getTime();
      assert.ok(serverNow >= new Date(initial.startsAt).getTime() && serverNow < new Date(initial.endsAt).getTime());
      giftKey = randomUUID();
      const sends = await Promise.all([sendGift(host.streamId, 2, giftKey), sendGift(host.streamId, 2, giftKey)]);
      debit = success(sends[0], 'scoring gift').transaction;
      assert.equal(success(sends[1], 'gift retry').transaction.id, debit.id);
      success(await sendGift(guest.streamId), 'opponent scoring gift');
      const scored = await snapshot();
      assert.equal(scored.hostScore, String(price * 2n)); assert.equal(scored.guestScore, String(price));
      assert.equal(scored.winnerStreamId, null); assert.equal(scored.status, 'ACTIVE');
      const wallet = success(await call('/wallet', { token: sender.accessToken }));
      assert.equal(wallet.balance, String(100n - price * 4n)); assert.ok(BigInt(wallet.balance) >= 0n);
    });

    await check('likes validate input, count concurrent retries once, cap 120 per member across streams and never score', async () => {
      denial(await like(undefined), 401);
      for (const count of [0, -1, 1.5, 21]) denial(await like(sender, host.streamId, count), 400);
      denial(await call(`/streams/${host.streamId}/likes`, { method: 'POST', token: sender.accessToken, body: { count: 1, idempotencyKey: randomUUID(), total: '9999' } }), 400);
      assert.equal(success(await call(`/streams/${host.streamId}/likes`)).total, '0');
      const key = randomUUID();
      const repeated = await Promise.all([like(sender, host.streamId, 20, key), like(sender, host.streamId, 20, key)]);
      for (const result of repeated) {
        const accepted = success(result, 'concurrent likes replay');
        assert.equal(accepted.acceptedCount, 20); assert.equal(accepted.total, '20');
      }
      denial(await like(sender, host.streamId, 19, key), 409, 'LIKES_IDEMPOTENCY_CONFLICT');
      denial(await like(sender, guest.streamId, 20, key), 409, 'LIKES_IDEMPOTENCY_CONFLICT');
      const capped = await Promise.all(Array.from({ length: 6 }, () => like(sender)));
      assert.deepEqual(capped.map(result => result.status).sort(), [200, 200, 200, 200, 200, 429]);
      denial(capped.find(result => result.status === 429), 429, 'LIKES_RATE_LIMITED');
      assert.equal(success(await call(`/streams/${host.streamId}/likes`)).total, '120');
      denial(await like(sender, guest.streamId, 1), 429, 'LIKES_RATE_LIMITED');
      assert.equal(success(await like(outsider, host.streamId, 1)).total, '121', 'Another member has a separate quota.');
      const stored = await owner.query('SELECT count(*)::int AS batches,sum(count)::text AS total FROM stream_likes WHERE user_id=$1', [sender.user.id]);
      assert.deepEqual(stored.rows, [{ batches: 6, total: '120' }]);
      assert.equal((await snapshot()).hostScore, String(price * 2n), 'Likes cannot become DU gift points.');
    });

    await check('early leave forfeits to the other host and freezes exact nonnegative audit scores', async () => {
      denial(await action(outsider, scoredBattle.id, 'leave'), 403, 'PK_FORBIDDEN');
      const final = success(await action(guest, scoredBattle.id, 'leave')).battle;
      assert.equal(final.status, 'FINISHED'); assert.equal(final.finishReason, 'FORFEIT');
      assert.equal(final.winnerStreamId, host.streamId); assert.equal(final.hostScore, String(price * 2n)); assert.equal(final.guestScore, String(price));
      assert.ok(final.settledAt && BigInt(final.hostScore) >= 0n && BigInt(final.guestScore) >= 0n);
      const persisted = (await owner.query('SELECT final_host_score::text,final_guest_score::text,winner_stream_id,finish_reason FROM pk_battles WHERE id=$1', [final.id])).rows[0];
      assert.deepEqual(persisted, { final_host_score: String(price * 2n), final_guest_score: String(price), winner_stream_id: host.streamId, finish_reason: 'FORFEIT' });
      success(await sendGift(guest.streamId, 2), 'gift after settlement');
      const after = await snapshot();
      assert.equal(after.hostScore, final.hostScore); assert.equal(after.guestScore, final.guestScore); assert.equal(after.winnerStreamId, final.winnerStreamId);
      assert.equal(success(await sendGift(host.streamId, 2, giftKey)).transaction.id, debit.id, 'Retrying a real gift cannot change a frozen result.');
      await assert.rejects(app.query('UPDATE pk_battles SET final_host_score=999 WHERE id=$1', [final.id]), error => error.code === '42501');
      await assert.rejects(owner.query('DELETE FROM pk_battles WHERE id=$1', [final.id]), error => error.code === '23514' && error.message === 'PK_HISTORY_IMMUTABLE');
    });

    await check('elapsed server deadline chooses the actual scoring winner and a zero-score tie has no invented winner', async () => {
      const timed = await active();
      success(await sendGift(guest.streamId), 'gift during new PK');
      await expire(timed.id, 'ACTIVE');
      const complete = await snapshot();
      assert.equal(complete.id, timed.id); assert.equal(complete.status, 'FINISHED'); assert.equal(complete.finishReason, 'COMPLETED');
      assert.equal(complete.hostScore, '0'); assert.equal(complete.guestScore, String(price)); assert.equal(complete.winnerStreamId, guest.streamId);
      success(await sendGift(host.streamId), 'post-deadline gift');
      assert.equal((await snapshot()).hostScore, '0', 'Gifts after the deadline cannot backfill the final score.');
      const tie = await active();
      await expire(tie.id, 'ACTIVE');
      const tied = await snapshot();
      assert.equal(tied.id, tie.id); assert.equal(tied.status, 'FINISHED'); assert.equal(tied.finishReason, 'COMPLETED');
      assert.equal(tied.hostScore, '0'); assert.equal(tied.guestScore, '0'); assert.equal(tied.winnerStreamId, null);
    });

    await check('blocks and ended streams refuse new likes without changing retained counts', async () => {
      await owner.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)', [host.user.id, outsider.user.id]);
      try { denial(await like(outsider, host.streamId, 1), 403, 'LIKES_BLOCKED'); }
      finally { await owner.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [host.user.id, outsider.user.id]); }
      await owner.query("UPDATE live_streams SET status='ENDED',ended_at=clock_timestamp() WHERE id=$1 AND creator_id=$2", [outsider.streamId, outsider.user.id]);
      denial(await like(guest, outsider.streamId, 1), 404, 'LIKES_STREAM_UNAVAILABLE');
      assert.equal(success(await call(`/streams/${host.streamId}/likes`)).total, '121');
      await assert.rejects(app.query('DELETE FROM stream_likes WHERE stream_id=$1', [host.streamId]), error => error.code === '42501');
    });
    report.passed = report.checks.every(result => result.passed);
    console.log(JSON.stringify({ localOnly: true, passed: report.passed, checks: report.checks.length }));
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    const failures = [];
    // End only this test's arranged streams; immutable PK/DU/likes audit stays.
    for (const user of accounts) {
      try {
        if (user.streamId) {
          await owner.query("UPDATE live_streams SET status='ENDED',ended_at=coalesce(ended_at,clock_timestamp()) WHERE id=$1 AND creator_id=$2", [user.streamId, user.user.id]);
          await app.query('SELECT public.pk_settle_stream($1::uuid)', [user.streamId]);
        }
      } catch (error) { failures.push(error); }
    }
    for (const user of accounts) {
      try {
        assert.equal((await call('/users/me', { method: 'DELETE', token: user.accessToken, body: { password: user.identity.password } })).status, 202);
        denial(await call('/auth/me', { token: user.accessToken }), 401);
      } catch (error) { failures.push(error); }
    }
    try {
      if (battles.length) assert.equal((await owner.query('SELECT count(*)::int AS n FROM pk_battles WHERE id=ANY($1::uuid[])', [battles])).rows[0].n, battles.length, 'Immutable PK audit must remain after soft deletion.');
    } catch (error) { failures.push(error); }
    await Promise.all([owner.end(), app.end()]).catch(error => failures.push(error));
    report.cleanup = { passed: failures.length === 0, accounts: accounts.length, retainedBattles: battles.length, errors: failures.map(error => error.message) };
    report.passed = report.passed && report.cleanup.passed;
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(artifact, 'pk-integration-result.json'), JSON.stringify(report, null, 2) + '\n');
    if (failures.length) throw new AggregateError(failures, 'PK integration fixture cleanup failed.');
  }
});
