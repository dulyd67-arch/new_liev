import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { RoomServiceClient } from 'livekit-server-sdk';

// These fixtures are ordinary disposable local members. The only owner SQL
// writes grant roles to their exact, newly registered IDs. No cloud or money.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function localUrl(raw, protocols, label) {
  let value;
  try { value = new URL(raw); } catch { throw new Error(`${label} must be a local test URL.`); }
  assert.ok(protocols.includes(value.protocol) && loopback.has(value.hostname.toLowerCase()), `${label} must use loopback.`);
  assert.ok(!value.hash, `${label} must not contain a fragment.`);
  return value;
}
const migration = localUrl(process.env.DATABASE_MIGRATION_URL, ['postgres:', 'postgresql:'], 'DATABASE_MIGRATION_URL');
const runtime = localUrl(process.env.DATABASE_URL, ['postgres:', 'postgresql:'], 'DATABASE_URL');
assert.match(decodeURIComponent(migration.pathname), /(?:^|[_-])test(?:$|[_-])/i, 'Use an isolated test database.');
assert.equal(runtime.pathname, migration.pathname); assert.equal(runtime.port, migration.port);
assert.equal(decodeURIComponent(runtime.username), 'livestar_app');
const endpoint = localUrl(process.env.ADMIN_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', ['http:', 'https:'], 'ADMIN_TEST_API_URL');
assert.equal(endpoint.pathname.replace(/\/$/, ''), '/api/v1');
assert.ok(!endpoint.username && !endpoint.password && !endpoint.search);
const media = localUrl(process.env.LIVEKIT_API_URL, ['http:', 'https:'], 'LIVEKIT_API_URL');
assert.ok(!media.username && !media.password && !media.search);
localUrl(process.env.LIVEKIT_URL, ['ws:', 'wss:'], 'LIVEKIT_URL');
assert.ok(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
const provider = new RoomServiceClient(media.origin, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const owner = new pg.Pool({ connectionString: migration.href, max: 2 });
const app = new pg.Pool({ connectionString: runtime.href, max: 2 });
const base = endpoint.origin + '/api/v1';
async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(25_000),
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) };
}
function success(response, label = 'request') {
  assert.ok([200, 201].includes(response.status), `${label}: HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  return response.data;
}
const command = (reason, idempotencyKey = randomUUID()) => ({ reason, idempotencyKey });
function safeIdentity(value) {
  for (const key of ['passwordHash', 'birthDate', 'timezone', 'countryCode', 'refreshToken', 'tokenHash', 'sessions', 'avatarKey']) assert.equal(value[key], undefined, `Admin projection leaked ${key}.`);
}

test('Admin HTTP: restricted-role RBAC, real room stops, session revocation, idempotency and immutable report decisions', { timeout: 180_000 }, async () => {
  const directory = resolve(process.cwd(), 'artifacts'); mkdirSync(directory, { recursive: true });
  const report = { localOnly: true, passed: false, checks: [], cleanup: {}, startedAt: new Date().toISOString() };
  const accounts = [], streams = [];
  let administrator, target;
  const check = async (name, run) => { try { await run(); report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })); } catch (error) { report.checks.push({ name, passed: false, message: error.message }); throw error; } };
  async function register(label) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const identity = { email: `admin-http-${label}-${suffix}@integration.invalid`, username: `ad_${suffix}`, password: `AdminFixture_${suffix}!` };
    const response = await request('/auth/mobile/register', { method: 'POST', body: { ...identity, displayName: `Admin QA ${label}`, birthDate: '1990-01-01', locale: 'en', termsVersion: '2026-11-07', privacyVersion: '2026-11-07', acceptTerms: true, acceptPrivacy: true } });
    assert.equal(response.status, 201, 'Register an ordinary fixture via HTTP.');
    const account = { ...response.data, identity }; accounts.push(account);
    assert.deepEqual((await owner.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [account.user.id])).rows, [{ name: 'USER' }]);
    return account;
  }
  async function grant(account, role) {
    assert.ok(accounts.includes(account));
    assert.equal((await owner.query('INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE name=$2 ON CONFLICT DO NOTHING RETURNING user_id', [account.user.id, role])).rowCount, 1);
  }
  async function login(account) { const result = success(await request('/auth/mobile/login', { method: 'POST', body: { email: account.identity.email, password: account.identity.password } }), 'fresh mobile sign-in'); account.accessToken = result.accessToken; return result; }
  async function create(account, title) {
    const result = success(await request('/streams', { method: 'POST', token: account.accessToken, body: { title, category: 'chat' } }), 'create empty local room');
    assert.equal(result.stream.status, 'SCHEDULED');
    const row = (await owner.query('SELECT id,creator_id,livekit_room FROM live_streams WHERE id=$1', [result.stream.id])).rows[0];
    assert.equal(row.creator_id, account.user.id); streams.push({ ...row, account });
    assert.equal((await provider.listRooms([row.livekit_room])).length, 1, 'The real media provider contains the room.');
    return row;
  }
  const mutate = (path, input, method = 'POST', actor = administrator) => request(path, { method, token: actor.accessToken, body: input });
  async function findPaged(path, match) {
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = success(await request(`${path}${path.includes('?') ? '&' : '?'}limit=20${cursor ? `&cursor=${cursor}` : ''}`, { token: administrator.accessToken }));
      const found = result.items.find(match); if (found) return found;
      if (!result.nextCursor) return null; cursor = result.nextCursor;
    }
    throw new Error('Local fixture was not found within the bounded page traversal.');
  }
  try {
    assert.equal((await app.query('SELECT current_user AS role')).rows[0].role, 'livestar_app');
    const superuser = await register('owner'), staff = await register('staff'), moderator = await register('moderator');
    target = await register('target'); const reporter = await register('reporter');
    await grant(superuser, 'SUPER_ADMIN'); await grant(staff, 'ADMIN'); await grant(moderator, 'MODERATOR'); administrator = staff;
    await check('anonymous, ordinary and moderator requests cannot enter administration; fresh DB roles authorize staff', async () => {
      for (const path of ['/admin/overview', '/admin/users', '/admin/streams', '/admin/reports', '/admin/audit']) {
        assert.equal((await request(path)).status, 401);
        for (const account of [target, moderator]) assert.equal((await request(path, { token: account.accessToken })).status, 403);
      }
      const response = await request('/admin/overview', { token: superuser.accessToken });
      assert.match(response.headers.get('cache-control'), /no-store/); success(response, 'super admin read');
      const overview = success(await request('/admin/overview', { token: staff.accessToken }));
      assert.equal(overview.dailyRegistrations.length, 7);
      for (const value of [overview.gifts.spentDu, overview.gifts.claimedDu]) assert.match(value, /^\d+$/);
      assert.equal(overview.users.total, overview.users.active + overview.users.suspended);
      const actual = (await owner.query("SELECT COUNT(*)::int AS count FROM users WHERE deleted_at IS NULL AND status IN ('ACTIVE','SUSPENDED')")).rows[0].count;
      assert.equal(overview.users.total, actual, 'Overview uses real records.');
    });
    await check('member search and UUID pagination use a bounded safe projection and validate filters', async () => {
      const result = success(await request(`/admin/users?query=${target.identity.username}&limit=1`, { token: staff.accessToken }));
      assert.equal(result.items.length, 1); assert.equal(result.items[0].id, target.user.id); safeIdentity(result.items[0]);
      assert.equal(result.items[0].email, target.identity.email);
      const first = success(await request('/admin/users?limit=1', { token: staff.accessToken }));
      assert.ok(first.nextCursor); const second = success(await request(`/admin/users?limit=1&cursor=${first.nextCursor}`, { token: staff.accessToken }));
      assert.notEqual(first.items[0].id, second.items[0].id);
      for (const path of ['/admin/users?limit=21', '/admin/users?cursor=no', '/admin/streams?status=FAKE', '/admin/reports?status=FAKE']) assert.equal((await request(path, { token: staff.accessToken })).status, 400);
      for (const body of [{ ...command('Unauthorized actor injection'), actorId: superuser.user.id }, { ...command('Unauthorized role injection'), roles: ['SUPER_ADMIN'] }]) assert.equal((await mutate(`/admin/users/${target.user.id}/suspend`, body)).status, 400);
      for (const protectedAccount of [superuser, staff, moderator]) assert.equal((await mutate(`/admin/users/${protectedAccount.user.id}/suspend`, command('Protected staff account check'))).status, 403);
      assert.equal((await mutate(`/admin/users/${reporter.user.id}/suspend`, command('Ordinary user privilege attempt'), 'POST', target)).status, 403);
    });
    const suspendedStream = await create(target, 'Admin local suspension media fixture');
    const reportReceipt = success(await request(`/streams/${suspendedStream.id}/report`, { method: 'POST', token: reporter.accessToken, body: { reason: '<img src=x onerror=window.__adminXss=1> reported text' } }));
    const suspend = command('Local integration: suspension requires a real room stop');
    const originalToken = target.accessToken;
    await check('suspension revokes all sessions and stops the actual provider room before returning complete', async () => {
      const result = success(await mutate(`/admin/users/${target.user.id}/suspend`, suspend));
      assert.equal(result.user.status, 'SUSPENDED'); assert.deepEqual(result.mediaCleanup, { complete: true, pendingStreamIds: [] });
      assert.equal((await provider.listRooms([suspendedStream.livekit_room])).length, 0);
      assert.equal((await owner.query('SELECT status FROM live_streams WHERE id=$1', [suspendedStream.id])).rows[0].status, 'TERMINATED');
      assert.equal((await request('/auth/me', { token: originalToken })).status, 401);
      assert.ok([401, 403].includes((await request('/auth/mobile/login', { method: 'POST', body: { email: target.identity.email, password: target.identity.password } })).status));
      success(await mutate(`/admin/users/${target.user.id}/suspend`, suspend), 'exact replay');
      assert.equal((await mutate(`/admin/users/${target.user.id}/suspend`, { ...suspend, reason: 'Changed command must conflict' })).status, 409);
      assert.equal((await owner.query("SELECT COUNT(*)::int AS count FROM admin_audit_logs WHERE actor_id=$1 AND request_id=$2 AND action='ADMIN_USER_SUSPENDED'", [staff.user.id, suspend.idempotencyKey])).rows[0].count, 1);
    });
    await check('restoration permits a fresh sign-in while old sessions and terminated history stay revoked', async () => {
      const result = success(await mutate(`/admin/users/${target.user.id}/restore`, command('Local integration: restore member access')));
      assert.equal(result.user.status, 'ACTIVE'); assert.equal((await request('/auth/me', { token: originalToken })).status, 401);
      await login(target);
      const ended = success(await request(`/streams/${suspendedStream.id}/end`, { method: 'POST', token: target.accessToken, body: {} }));
      assert.equal(ended.status, 'TERMINATED', 'Owner cleanup cannot downgrade moderation history.');
    });
    const fresh = await create(target, 'Admin local fresh broadcast after restoration');
    const other = await create(reporter, 'Admin local concurrent idempotency conflict fixture');
    await check('stale suspension replay cannot stop a new authorized broadcast or change its restored owner', async () => {
      const result = success(await mutate(`/admin/users/${target.user.id}/suspend`, suspend));
      assert.equal(result.user.status, 'ACTIVE'); assert.equal((await provider.listRooms([fresh.livekit_room])).length, 1);
      success(await request('/auth/me', { token: target.accessToken }));
    });
    await check('concurrent reused termination keys bind one target before provider I/O and preserve the other room', async () => {
      const stop = command('Local integration: one key must identify one media target');
      const results = await Promise.all([fresh, other].map(stream => mutate(`/admin/streams/${stream.id}/terminate`, stop)));
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      const winner = results[0].status === 200 ? fresh : other, survivor = winner.id === fresh.id ? other : fresh;
      assert.equal(results.find(result => result.status === 200).data.stream.status, 'TERMINATED');
      assert.equal((await provider.listRooms([winner.livekit_room])).length, 0);
      assert.equal((await provider.listRooms([survivor.livekit_room])).length, 1);
      success(await mutate(`/admin/streams/${winner.id}/terminate`, stop), 'completed media replay');
      success(await request(`/streams/${survivor.id}/end`, { method: 'POST', token: survivor.creator_id === target.user.id ? target.accessToken : reporter.accessToken, body: {} }));
      assert.equal((await mutate(`/admin/streams/${survivor.id}/terminate`, command('Completed sessions cannot be rewritten'))).status, 409);
      assert.equal((await owner.query('SELECT status FROM live_streams WHERE id=$1', [survivor.id])).rows[0].status, 'ENDED');
    });
    await check('real reports retain reporter ownership, bounded review decisions and immutable terminal results', async () => {
      const stored = await findPaged('/admin/reports?status=OPEN', item => item.id === reportReceipt.id); assert.ok(stored); assert.equal(stored.reporter.id, reporter.user.id); safeIdentity(stored.reporter);
      assert.equal(stored.target.id, target.user.id); assert.match(stored.details, /<img/);
      const reviewing = command('Local integration: review reported content');
      assert.equal(success(await mutate(`/admin/reports/${stored.id}`, { ...reviewing, status: 'REVIEWING' }, 'PATCH')).report.status, 'REVIEWING');
      const resolveInput = { ...command('Local integration: content review completed'), status: 'RESOLVED' };
      const resolved = success(await mutate(`/admin/reports/${stored.id}`, resolveInput, 'PATCH')).report;
      assert.equal(resolved.status, 'RESOLVED'); assert.ok(resolved.resolvedAt);
      assert.deepEqual(success(await mutate(`/admin/reports/${stored.id}`, resolveInput, 'PATCH')).report, resolved);
      assert.equal((await mutate(`/admin/reports/${stored.id}`, { ...resolveInput, status: 'DISMISSED' }, 'PATCH')).status, 409);
      assert.equal((await mutate(`/admin/reports/${stored.id}`, { ...command('Cannot rewrite a terminal decision'), status: 'DISMISSED' }, 'PATCH')).status, 409);
      const second = success(await request(`/streams/${fresh.id}/report`, { method: 'POST', token: reporter.accessToken, body: { reason: 'Independent second report for dismissal' } }));
      assert.equal(success(await mutate(`/admin/reports/${second.id}`, { ...command('Local integration: no violation found'), status: 'DISMISSED' }, 'PATCH')).report.status, 'DISMISSED');
      assert.equal((await mutate(`/admin/reports/${second.id}`, { ...command('Cannot reopen dismissed decision'), status: 'REVIEWING' }, 'PATCH')).status, 409);
      const audit = success(await request('/admin/audit?limit=20', { token: staff.accessToken }));
      assert.ok(await findPaged('/admin/audit', item => item.actor?.id === staff.user.id && item.entityId === stored.id));
      for (const item of audit.items) { assert.ok(item.action.startsWith('ADMIN_')); if (item.actor) safeIdentity(item.actor); }
      assert.ok(!JSON.stringify(audit).includes(target.identity.password));
      assert.equal((await request('/admin/audit', { method: 'POST', token: staff.accessToken, body: { actorId: staff.user.id } })).status, 404);
    });
    report.passed = true;
  } finally {
    for (const stream of streams) {
      try {
        const current = (await owner.query('SELECT status FROM live_streams WHERE id=$1', [stream.id])).rows[0]?.status;
        if (administrator && ['LIVE', 'SCHEDULED'].includes(current)) success(await mutate(`/admin/streams/${stream.id}/terminate`, command('Local fixture cleanup: stop only the owned test room')));
        if ((await provider.listRooms([stream.livekit_room])).length) await provider.deleteRoom(stream.livekit_room);
      } catch (error) { report.cleanup[`media:${stream.id}`] = error.message; report.passed = false; }
    }
    if (target && administrator) {
      try {
        const status = (await owner.query('SELECT status FROM users WHERE id=$1', [target.user.id])).rows[0]?.status;
        if (status === 'SUSPENDED') success(await mutate(`/admin/users/${target.user.id}/restore`, command('Local fixture cleanup: restore before normal account deletion')));
      } catch (error) { report.cleanup.restore = error.message; }
    }
    for (const account of [...accounts].reverse()) {
      try {
        await login(account);
        const result = await request('/users/me', { method: 'DELETE', token: account.accessToken, body: { password: account.identity.password } });
        assert.equal(result.status, 202); assert.equal((await request('/auth/me', { token: account.accessToken })).status, 401);
        report.cleanup[account.user.id] = 'deleted through authenticated account lifecycle';
      } catch (error) { report.cleanup[account.user.id] = error.message; report.passed = false; }
    }
    report.completedAt = new Date().toISOString(); writeFileSync(resolve(directory, 'admin-integration-result.json'), JSON.stringify(report, null, 2) + '\n');
    await Promise.all([owner.end(), app.end()]);
    assert.ok(report.passed, 'All integration checks and ordinary fixture cleanup must complete.');
  }
});
