import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

// Every mutation is confined to locally registered, disposable accounts. SQL is
// used only to arrange stream/block states which have no public fixture API.
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
assert.equal(runtime.pathname, migration.pathname, 'The runtime and fixture connections must select the same test database.');
assert.equal(runtime.port, migration.port);
assert.equal(decodeURIComponent(runtime.username), 'livestar_app', 'The actual API must use its restricted application role.');
const endpoint = localUrl(process.env.DU_TEST_API_URL || process.env.LIVE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', ['http:', 'https:'], 'DU_TEST_API_URL');
assert.equal(endpoint.pathname.replace(/\/$/, ''), '/api/v1');
assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
const base = endpoint.origin + '/api/v1';
const pool = new pg.Pool({ connectionString: migration.href, max: 2 });

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}
function success(result, action) {
  assert.equal(result.status, 200, `${action} must succeed (received HTTP ${result.status}).`);
  return result.data;
}
function denial(result, status, code) {
  assert.equal(result.status, status);
  if (code) assert.equal(result.data?.code, code);
}
async function account(label, fixtures) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
  const identity = { email: `du-${label}-${suffix}@integration.invalid`, username: `du_${suffix}`, password: `DuFixture_${suffix}!` };
  const registered = await call('/auth/mobile/register', { method: 'POST', body: {
    ...identity, displayName: `DU ${label}`, birthDate: '1990-01-01', locale: 'en',
    termsVersion: '2026-11-07', privacyVersion: '2026-11-07', acceptTerms: true, acceptPrivacy: true,
  } });
  assert.equal(registered.status, 201, 'Normal registration must create each fixture through the actual API.');
  const fixture = { ...registered.data, identity };
  fixtures.push(fixture);
  const record = await pool.query('SELECT u.status,r.name FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.id=$1', [registered.data.user.id]);
  assert.deepEqual(record.rows, [{ status: 'ACTIVE', name: 'USER' }], 'Fixture sessions must belong to active, ordinary members.');
  return fixture;
}

test('DU: real restricted-role wallet, one-time grant, idempotent gifts, isolation and concurrent spending', { timeout: 90_000 }, async t => {
  const accounts = [];
  const streamId = randomUUID();
  let fixtureCreated = false;
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, decodeURIComponent(migration.pathname.slice(1)));
    for (const label of ['host', 'sender', 'other']) await account(label, accounts);
    const [host, sender, other] = accounts;
    const wallet = user => call('/wallet', { token: user.accessToken }).then(result => success(result, 'wallet read'));
    const send = (user, gift, quantity = 1, key = randomUUID()) => call(`/streams/${streamId}/gifts`, { method: 'POST', token: user.accessToken, body: { giftId: gift.id, quantity, idempotencyKey: key } });
    const catalog = success(await call('/gifts'), 'public gift catalog');
    assert.equal(catalog.currency, 'DU'); assert.equal(catalog.promotional, true);
    assert.ok(catalog.items.length >= 3, 'The catalog must contain multiple actual gifts.');
    for (const gift of catalog.items) {
      assert.match(gift.price, /^[1-9]\d*$/); assert.ok(gift.nameAr && gift.nameEn && gift.emoji && gift.effect);
    }
    const gift = [...catalog.items].sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)))[0];
    const price = BigInt(gift.price);
    assert.ok(price <= 10n, 'The promotional grant needs an affordable entry gift.');

    await t.test('authentication and empty wallet have no automatic credit', async () => {
      for (const path of ['/wallet', '/wallet/history']) denial(await call(path), 401);
      denial(await call('/wallet/claim', { method: 'POST', body: { idempotencyKey: randomUUID() } }), 401);
      denial(await call(`/streams/${streamId}/gifts`, { method: 'POST', body: { giftId: gift.id, quantity: 1, idempotencyKey: randomUUID() } }), 401);
      const initial = await wallet(sender);
      assert.equal(initial.currency, 'DU'); assert.equal(initial.balance, '0'); assert.equal(initial.claimAvailable, true);
      assert.equal(initial.promotional, true); assert.equal(initial.purchasingEnabled, false);
      assert.deepEqual(success(await call('/wallet/history', { token: sender.accessToken }), 'empty history').items, []);
    });

    await pool.query('INSERT INTO live_streams (id,creator_id,title,status,livekit_room,started_at) VALUES ($1,$2,$3,\'LIVE\',$4,now())',
      [streamId, host.user.id, 'Isolated DU business-rule fixture', `du-test-${streamId}`]);
    fixtureCreated = true;
    let originalSend, originalSendKey, claimKey, expectedReceived = 0n, expectedCount = 0n;
    await t.test('ordinary members can persist follow state and stream reports', async () => {
      const followPath = `/social/${host.user.id}/follow`;
      denial(await call(`/social/${host.user.id}`), 401);
      denial(await call(followPath, { method: 'POST' }), 401);
      denial(await call(`/streams/${streamId}/report`, { method: 'POST', body: { reason: 'Fixture report' } }), 401);
      denial(await call(`/social/${sender.user.id}/follow`, { method: 'POST', token: sender.accessToken }), 403);
      assert.equal(success(await call(`/social/${host.user.id}`, { token: sender.accessToken }), 'initial follow state').following, false);
      const following = await Promise.all([0, 1].map(() => call(followPath, { method: 'POST', token: sender.accessToken })));
      for (const result of following) assert.equal(success(result, 'idempotent follow').following, true);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM follows WHERE follower_id=$1 AND followed_id=$2', [sender.user.id, host.user.id])).rows[0].count, 1);
      assert.equal(success(await call(`/social/${host.user.id}`, { token: sender.accessToken }), 'persisted follow state').following, true);
      for (let attempt = 0; attempt < 2; attempt++) assert.equal(success(await call(followPath, { method: 'DELETE', token: sender.accessToken }), 'idempotent unfollow').following, false);
      const reason = `Local DU integration report ${streamId}`;
      const receipt = success(await call(`/streams/${streamId}/report`, { method: 'POST', token: sender.accessToken, body: { reason } }), 'persistent stream report');
      assert.equal(receipt.status, 'OPEN');
      const persisted = await pool.query('SELECT reporter_id,target_user_id,stream_id,reason_code,details FROM reports WHERE id=$1', [receipt.id]);
      assert.deepEqual(persisted.rows, [{ reporter_id: sender.user.id, target_user_id: host.user.id, stream_id: streamId, reason_code: 'STREAM_REPORT', details: reason }]);
    });
    await t.test('gift denials and malformed input preserve a zero balance', async () => {
      denial(await send(sender, gift), 409, 'DU_INSUFFICIENT_BALANCE');
      for (const body of [
        { giftId: 'invalid', quantity: 1, idempotencyKey: randomUUID() },
        ...[0, 1.5].map(quantity => ({ giftId: gift.id, quantity, idempotencyKey: randomUUID() })),
        { giftId: gift.id, quantity: 1, idempotencyKey: randomUUID(), price: '0' },
      ]) denial(await call(`/streams/${streamId}/gifts`, { method: 'POST', body, token: sender.accessToken }), 400);
      denial(await call('/wallet/claim', { method: 'POST', token: sender.accessToken, body: {} }), 400);
      denial(await call('/wallet/claim', { method: 'POST', token: sender.accessToken, body: { idempotencyKey: 'reused-arbitrary-key' } }), 400);
      denial(await call('/wallet/history?cursor=invalid', { token: sender.accessToken }), 400);
      denial(await call('/wallet/history?cursor=9223372036854775808', { token: sender.accessToken }), 400);
      denial(await call(`/streams/${streamId}/gifts?after=-1`), 400);
      denial(await call(`/streams/${streamId}/gifts?after=9223372036854775808`), 400);
      assert.equal((await wallet(sender)).balance, '0');
    });

    await t.test('concurrent same-key claims grant exactly 100 DU once', async () => {
      const idempotencyKey = randomUUID();
      claimKey = idempotencyKey;
      const claims = await Promise.all([idempotencyKey, idempotencyKey.toUpperCase()].map(key => call('/wallet/claim', { method: 'POST', token: sender.accessToken, body: { idempotencyKey: key } })));
      const first = success(claims[0], 'first claim'), replay = success(claims[1], 'concurrent claim replay');
      assert.equal(first.transaction.id, replay.transaction.id);
      assert.equal(first.transaction.type, 'CLAIM'); assert.equal(first.transaction.amount, '100');
      assert.equal((await wallet(sender)).balance, '100'); assert.equal((await wallet(sender)).claimAvailable, false);
      denial(await call('/wallet/claim', { method: 'POST', token: sender.accessToken, body: { idempotencyKey: randomUUID() } }), 409, 'DU_ALREADY_CLAIMED');
      const history = success(await call('/wallet/history', { token: sender.accessToken }), 'claim history');
      assert.equal(history.items.length, 1); assert.equal(history.items[0].id, first.transaction.id);
      success(await call('/wallet/claim', { method: 'POST', token: other.accessToken, body: { idempotencyKey } }), 'same key belonging to another member');
      assert.equal((await wallet(other)).balance, '100', 'Idempotency keys are scoped to their member.');
    });

    await t.test('self gifts and either direction of blocking are forbidden', async () => {
      denial(await send(host, gift), 403, 'DU_SELF_GIFT');
      for (const [blocker, blocked] of [[host, sender], [sender, host]]) {
        await pool.query('INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ($1,$2)', [blocker.user.id, blocked.user.id]);
        try { denial(await send(sender, gift), 403, 'DU_BLOCKED'); }
        finally { await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [blocker.user.id, blocked.user.id]); }
      }
      assert.equal((await wallet(sender)).balance, '100');
    });

    await t.test('same-key concurrent gifts debit once and produce one actual event', async () => {
      assert.deepEqual(success(await call(`/streams/${streamId}/gifts`), 'initial feed snapshot').items, []);
      denial(await send(sender, gift, 1, claimKey), 409, 'DU_IDEMPOTENCY_CONFLICT');
      const key = randomUUID();
      originalSendKey = key;
      const results = await Promise.all([send(sender, gift, 2, key), send(sender, gift, 2, key.toUpperCase())]);
      const first = success(results[0], 'gift send'), replay = success(results[1], 'gift replay');
      originalSend = first.transaction;
      assert.equal(replay.transaction.id, first.transaction.id); assert.equal(first.transaction.type, 'GIFT');
      assert.equal(first.transaction.amount, String(-price * 2n)); assert.equal(first.transaction.quantity, 2);
      assert.equal(first.wallet.balance, String(100n - price * 2n));
      denial(await send(sender, gift, 3, key), 409, 'DU_IDEMPOTENCY_CONFLICT');
      const feed = success(await call(`/streams/${streamId}/gifts?after=0`), 'actual gift events');
      assert.equal(feed.items.length, 1); assert.equal(feed.items[0].id, first.transaction.id);
      assert.equal(feed.items[0].sender.id, sender.user.id); assert.equal(feed.items[0].totalPrice, String(price * 2n));
      assert.equal(feed.totalCoins, String(price * 2n)); assert.equal(feed.totalGifts, '2');
      const next = success(await call(`/streams/${streamId}/gifts?after=${feed.nextCursor}`), 'feed cursor');
      assert.deepEqual(next.items, []);
      assert.deepEqual(success(await call(`/streams/${streamId}/gifts`), 'late subscriber snapshot').items, [], 'A late subscriber must not replay historical animations.');
      expectedReceived += price * 2n; expectedCount += 2n;
    });

    await t.test('history is private and cursor reads exclude the boundary', async () => {
      const mine = success(await call('/wallet/history', { token: sender.accessToken }), 'sender history');
      assert.equal(mine.items.length, 2); assert.equal(mine.items[0].id, originalSend.id);
      const before = success(await call(`/wallet/history?cursor=${originalSend.sequence}`, { token: sender.accessToken }), 'history cursor');
      assert.equal(before.items.length, 1); assert.equal(before.items[0].type, 'CLAIM');
      const others = success(await call('/wallet/history', { token: other.accessToken }), 'separate member history');
      assert.equal(others.items.length, 1); assert.equal(others.items[0].type, 'CLAIM');
      assert.ok(!others.items.some(item => mine.items.some(own => own.id === item.id)));
      assert.deepEqual(success(await call('/wallet/history', { token: host.accessToken }), 'host spend history').items, []);
    });

    await t.test('overspending and competing debits cannot create a negative balance', async () => {
      const available = BigInt((await wallet(sender)).balance);
      const oversized = Number(available / price + 1n);
      assert.ok(oversized <= 99);
      denial(await send(sender, gift, oversized), 409, 'DU_INSUFFICIENT_BALANCE');
      const quantity = Number(available / price / 2n + 1n);
      assert.ok(quantity >= 1 && quantity <= 99 && BigInt(quantity) * price <= available);
      const competing = await Promise.all([send(sender, gift, quantity), send(sender, gift, quantity)]);
      assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
      denial(competing.find(result => result.status === 409), 409, 'DU_INSUFFICIENT_BALANCE');
      expectedReceived += price * BigInt(quantity); expectedCount += BigInt(quantity);
      assert.equal((await wallet(sender)).balance, String(available - price * BigInt(quantity)));
      const hostWallet = await wallet(host);
      assert.equal(hostWallet.balance, '0', 'Promotional received gifts never become a spendable or cash balance.');
      assert.equal(hostWallet.receivedCoins, String(expectedReceived)); assert.equal(hostWallet.receivedGifts, String(expectedCount));
      const feed = success(await call(`/streams/${streamId}/gifts?after=0`), 'committed gift feed');
      assert.equal(feed.items.length, 2); assert.equal(feed.totalCoins, String(expectedReceived)); assert.equal(feed.totalGifts, String(expectedCount));
    });

    await t.test('scheduled and ended streams refuse gifts without debiting', async () => {
      const before = (await wallet(other)).balance;
      for (const status of ['SCHEDULED', 'ENDED']) {
        await pool.query('UPDATE live_streams SET status=$2::"StreamStatus" WHERE id=$1 AND creator_id=$3', [streamId, status, host.user.id]);
        denial(await send(other, gift), 404, 'DU_STREAM_UNAVAILABLE');
        assert.equal((await wallet(other)).balance, before);
      }
      const replay = success(await send(sender, gift, 2, originalSendKey), 'safe retry after the stream ended');
      assert.equal(replay.transaction.id, originalSend.id);
    });
  } finally {
    const failures = [];
    try {
      if (fixtureCreated) await pool.query('UPDATE live_streams SET status=\'ENDED\',ended_at=now() WHERE id=$1 AND creator_id=$2', [streamId, accounts[0].user.id]);
    } catch (error) { failures.push(error); }
    // Password verification intentionally has bounded concurrency in the API.
    // Delete fixtures sequentially, while still attempting every account.
    for (const user of accounts) {
      try {
        const result = await call('/users/me', { method: 'DELETE', token: user.accessToken, body: { password: user.identity.password } });
        assert.equal(result.status, 202, 'Fixture accounts must be soft-deleted through their normal authenticated API.');
        denial(await call('/auth/me', { token: user.accessToken }), 401);
      } catch (error) { failures.push(error); }
    }
    await pool.end().catch(error => { failures.push(error); });
    if (failures.length) throw new AggregateError(failures, 'DU fixture cleanup failed.');
  }
});
