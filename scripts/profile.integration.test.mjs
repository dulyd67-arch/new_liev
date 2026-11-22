import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import pg from 'pg';

// These ordinary identity and completed-session fixtures are loopback-only.
// They never create a cloud account, media room, financial balance or recording.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function localUrl(raw, protocols, label) {
  let value;
  try { value = new URL(raw); } catch { throw new Error(`${label} must be a valid local test URL.`); }
  assert.ok(protocols.includes(value.protocol) && loopback.has(value.hostname.toLowerCase()), `${label} must use loopback.`);
  assert.ok(!value.hash, `${label} must not contain a fragment.`);
  return value;
}
const migration = localUrl(process.env.DATABASE_MIGRATION_URL, ['postgres:', 'postgresql:'], 'DATABASE_MIGRATION_URL');
const runtime = localUrl(process.env.DATABASE_URL, ['postgres:', 'postgresql:'], 'DATABASE_URL');
assert.match(decodeURIComponent(migration.pathname), /(?:^|[_-])test(?:$|[_-])/i, 'Use an isolated test database.');
assert.equal(runtime.pathname, migration.pathname); assert.equal(runtime.port, migration.port);
assert.equal(decodeURIComponent(runtime.username), 'livestar_app', 'The API must use its restricted runtime role.');
const endpoint = localUrl(process.env.PROFILE_TEST_API_URL || 'http://127.0.0.1:4001/api/v1', ['http:', 'https:'], 'PROFILE_TEST_API_URL');
assert.equal(endpoint.pathname.replace(/\/$/, ''), '/api/v1');
assert.ok(!endpoint.username && !endpoint.password && !endpoint.search);
const base = endpoint.origin + '/api/v1';
const owner = new pg.Pool({ connectionString: migration.href, max: 2 });
const app = new pg.Pool({ connectionString: runtime.href, max: 2 });

async function request(path, { method = 'GET', token, body, binary = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let data = null;
  if (!binary) { try { data = JSON.parse(bytes.toString()); } catch { /* Report only status for non-JSON errors. */ } }
  return { status: response.status, headers: response.headers, data, bytes };
}
function ok(result, label = 'request') {
  assert.equal(result.status, 200, `${label} failed with HTTP ${result.status}.`);
  return result.data;
}
function safePublic(profile) {
  for (const key of ['email', 'birthDate', 'timezone', 'countryCode', 'passwordHash', 'roles', 'sessions', 'refreshToken', 'tokenHash']) {
    assert.equal(profile[key], undefined, `Public projection must not expose ${key}.`);
  }
  assert.ok(profile.avatarKey === null || profile.avatarKey === undefined, 'Public JSON must not duplicate stored avatar bytes.');
}
function png(width = 16, height = 16) {
  function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    scanlines[offset] = 126; scanlines[offset + 1] = 74; scanlines[offset + 2] = 181; scanlines[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

test('Profiles: private writes, bounded photos, genuine social lists, safe completed history and deletion', { timeout: 120_000 }, async t => {
  const artifact = resolve(process.cwd(), 'artifacts'); mkdirSync(artifact, { recursive: true });
  const report = { localOnly: true, passed: false, checks: [], cleanup: {}, startedAt: new Date().toISOString() };
  const accounts = [], streamIds = [];
  async function register(label) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const identity = { email: `profile-${label}-${suffix}@integration.invalid`, username: `pr_${suffix}`, password: `ProfileFixture_${suffix}!` };
    const response = await request('/auth/mobile/register', { method: 'POST', body: {
      ...identity, displayName: `Profile ${label}`, birthDate: '1990-01-01', locale: 'en',
      termsVersion: '2026-11-07', privacyVersion: '2026-11-07', acceptTerms: true, acceptPrivacy: true,
    } });
    assert.equal(response.status, 201, 'Register an ordinary disposable member through the real API.');
    const account = { ...response.data, identity, deleted: false }; accounts.push(account);
    assert.deepEqual((await owner.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [account.user.id])).rows, [{ name: 'USER' }]);
    return account;
  }
  const check = (name, action) => t.test(name, async () => {
    try { await action(); report.checks.push({ name, passed: true }); }
    catch (error) { report.checks.push({ name, passed: false, message: error.message }); throw error; }
  });
  try {
    assert.equal((await app.query('SELECT current_user AS role')).rows[0].role, 'livestar_app');
    assert.equal((await owner.query('SELECT current_database() AS name')).rows[0].name, decodeURIComponent(migration.pathname.slice(1)));
    const author = await register('owner'), first = await register('first'), second = await register('second');
    const profilePath = `/users/${author.identity.username}`;
    const original = ok(await request(profilePath), 'public profile');

    await check('ordinary public profiles contain real zero counts and exclude private identity fields', async () => {
      safePublic(original);
      assert.equal(original.id, author.user.id);
      assert.equal(original.followerCount, 0); assert.equal(original.followingCount, 0); assert.equal(original.broadcastCount, 0);
      assert.equal(original.avatarUrl, null);
      assert.equal((await request(profilePath + '/avatar', { binary: true })).status, 404);
      assert.equal((await request('/users/me', { method: 'PATCH', body: { bio: 'unauthenticated' } })).status, 401);
    });

    await check('only the authenticated owner can edit fields; identity and privilege injection are rejected', async () => {
      for (const body of [{ userId: author.user.id, displayName: 'forged' }, { roles: ['ADMIN'] }, { username: 'replacement' }, { avatarKey: 'unsafe' }]) {
        assert.equal((await request('/users/me', { method: 'PATCH', token: first.accessToken, body })).status, 400);
      }
      assert.equal(ok(await request(profilePath)).displayName, original.displayName);
      const displayName = '<img src=x onerror=alert(1)> نجمة';
      const updated = ok(await request('/users/me', { method: 'PATCH', token: author.accessToken, body: { displayName, bio: 'نبذة محفوظة عبر الواجهة الحقيقية.' } }), 'owned profile edit');
      assert.equal(updated.id, author.user.id);
      const publicAfter = ok(await request(profilePath));
      assert.equal(publicAfter.displayName, displayName); assert.equal(publicAfter.bio, 'نبذة محفوظة عبر الواجهة الحقيقية.'); safePublic(publicAfter);
      assert.equal(ok(await request(`/users/${first.identity.username}`)).displayName, 'Profile first');
    });

    let photoUrl;
    await check('a validated photo persists through restricted-role SQL and serves only safe image bytes', async () => {
      const bytes = png();
      const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
      ok(await request('/users/me', { method: 'PATCH', token: author.accessToken, body: { avatarDataUrl: dataUrl } }), 'real photo edit');
      const profile = ok(await request(profilePath)); safePublic(profile);
      assert.match(profile.avatarUrl, new RegExp(`^/api/v1/users/${author.identity.username}/avatar\\?v=`));
      photoUrl = profile.avatarUrl;
      const image = await request(profile.avatarUrl.replace('/api/v1', ''), { binary: true });
      assert.equal(image.status, 200); assert.deepEqual(image.bytes, bytes);
      assert.match(image.headers.get('content-type'), /^image\/png/);
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
      assert.match(image.headers.get('cache-control'), /no-store/);
      assert.match(image.headers.get('content-security-policy'), /sandbox/);
      const audit = await owner.query("SELECT after FROM admin_audit_logs WHERE actor_id=$1 AND action='PROFILE_UPDATED' ORDER BY created_at DESC LIMIT 1", [author.user.id]);
      assert.ok(audit.rows[0].after.changedFields.includes('avatarKey'));
      assert.ok(!JSON.stringify(audit.rows[0]).includes('base64,'), 'Audit stores changed field names, never image contents.');
    });

    await check('unsupported, forged, malformed, oversized and oversized-dimension photos leave the original unchanged', async () => {
      for (const avatarDataUrl of [
        'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
        'data:image/png;base64,' + Buffer.from('<html>not an image</html>').toString('base64'),
        'data:image/png;base64,%%%invalid%%%',
        'data:image/png;base64,' + Buffer.alloc(49153).toString('base64'),
        'data:image/png;base64,' + png(513, 1).toString('base64'),
      ]) {
        assert.equal((await request('/users/me', { method: 'PATCH', token: author.accessToken, body: { avatarDataUrl } })).status, 400);
      }
      assert.equal(ok(await request(profilePath)).avatarUrl, photoUrl);
      ok(await request('/users/me', { method: 'PATCH', token: author.accessToken, body: { avatarDataUrl: null } }), 'remove photo');
      assert.equal(ok(await request(profilePath)).avatarUrl, null);
      assert.equal((await request(profilePath + '/avatar', { binary: true })).status, 404);
    });

    await check('follow and unfollow requests are idempotent and public member lists page actual active accounts', async () => {
      for (const member of [first, second]) {
        for (let replay = 0; replay < 2; replay++) assert.equal(ok(await request(`/social/${author.user.id}/follow`, { method: 'POST', token: member.accessToken, body: {} })).following, true);
      }
      assert.equal(ok(await request(profilePath)).followerCount, 2);
      assert.equal((await request(`/social/${author.user.id}/follow`, { method: 'POST', token: author.accessToken, body: {} })).status, 403);
      const pageOne = ok(await request(profilePath + '/followers?limit=1'));
      assert.equal(pageOne.items.length, 1); assert.ok(pageOne.nextCursor); safePublic(pageOne.items[0]);
      const pageTwo = ok(await request(profilePath + `/followers?limit=1&cursor=${pageOne.nextCursor}`));
      assert.equal(pageTwo.items.length, 1); assert.equal(pageTwo.nextCursor, null); safePublic(pageTwo.items[0]);
      assert.deepEqual(new Set([...pageOne.items, ...pageTwo.items].map(user => user.id)), new Set([first.user.id, second.user.id]));
      const following = ok(await request(`/users/${first.identity.username}/following`));
      assert.deepEqual(following.items.map(user => user.id), [author.user.id]); safePublic(following.items[0]);
      for (const path of ['/followers', '/following', '/streams']) {
        assert.equal((await request(profilePath + path + '?cursor=not-a-uuid')).status, 400);
        assert.equal((await request(profilePath + path + '?limit=21')).status, 400);
      }
      for (let replay = 0; replay < 2; replay++) assert.equal(ok(await request(`/social/${author.user.id}/follow`, { method: 'DELETE', token: first.accessToken })).following, false);
      assert.equal(ok(await request(profilePath)).followerCount, 1);
      ok(await request(`/social/${author.user.id}/follow`, { method: 'POST', token: first.accessToken, body: {} }));
    });

    await check('completed history contains real owned session metadata and excludes scheduled, terminated and other creators', async () => {
      const histories = [];
      for (const [creator, status, started] of [[author, 'ENDED', true], [author, 'ENDED', true], [author, 'TERMINATED', true], [author, 'SCHEDULED', false], [first, 'ENDED', true]]) {
        const id = randomUUID(); streamIds.push(id);
        await owner.query("INSERT INTO live_streams(id,creator_id,title,status,livekit_room,started_at,ended_at) VALUES($1,$2,$3,$4::\"StreamStatus\",$5,$6,$7)", [
          id, creator.user.id, 'Owned local completed-session metadata fixture', status, `profile-test-${id}`,
          started ? new Date(Date.now() - 120_000) : null, status === 'ENDED' || status === 'TERMINATED' ? new Date(Date.now() - 60_000) : null,
        ]);
        if (creator === author && status === 'ENDED') histories.push(id);
      }
      const one = ok(await request(profilePath + '/streams?limit=1'));
      assert.equal(one.items.length, 1); assert.ok(one.nextCursor);
      const two = ok(await request(profilePath + `/streams?limit=1&cursor=${one.nextCursor}`));
      assert.equal(two.items.length, 1); assert.equal(two.nextCursor, null);
      assert.deepEqual(new Set([...one.items, ...two.items].map(stream => stream.id)), new Set(histories));
      for (const stream of [...one.items, ...two.items]) {
        assert.equal(stream.status, 'ENDED'); assert.ok(stream.startedAt && stream.endedAt);
        for (const field of ['livekitRoom', 'recordingUrl', 'playbackUrl', 'creatorId']) assert.equal(stream[field], undefined);
      }
      assert.equal(ok(await request(profilePath)).broadcastCount, 2);
      assert.equal((await request('/streams?creatorId=not-a-uuid')).status, 400);
      const actual = ok(await request(`/streams?creatorId=${author.user.id}`));
      assert.deepEqual(actual.items, [], 'Completed fixtures must never appear as live broadcasts.');
    });

    await check('account deletion hides public photos, profiles and follower membership without rewriting session audit', async () => {
      const dataUrl = `data:image/png;base64,${png().toString('base64')}`;
      ok(await request('/users/me', { method: 'PATCH', token: second.accessToken, body: { avatarDataUrl: dataUrl } }));
      assert.ok(ok(await request(`/users/${second.identity.username}`)).avatarUrl);
      assert.equal((await request('/users/me', { method: 'DELETE', token: second.accessToken, body: { password: second.identity.password } })).status, 202);
      second.deleted = true;
      assert.equal((await request(`/users/${second.identity.username}`)).status, 404);
      assert.equal((await request(`/users/${second.identity.username}/avatar`, { binary: true })).status, 404);
      const members = ok(await request(profilePath + '/followers'));
      assert.deepEqual(members.items.map(member => member.id), [first.user.id]);
      assert.equal(ok(await request(profilePath)).followerCount, 1);
      const retained = await owner.query('SELECT status FROM live_streams WHERE id=ANY($1::uuid[])', [streamIds]);
      assert.equal(retained.rows.length, streamIds.length);
    });
    report.passed = report.checks.every(check => check.passed);
  } finally {
    const failures = [];
    // A scheduled metadata fixture is local and owned. End it before normal
    // account deletion so no active-stream slot remains attached to a fixture.
    for (const id of streamIds) {
      try { await owner.query("UPDATE live_streams SET status='ENDED',ended_at=coalesce(ended_at,clock_timestamp()) WHERE id=$1 AND creator_id=ANY($2::uuid[]) AND status='SCHEDULED'", [id, accounts.map(account => account.user.id)]); }
      catch (error) { failures.push(error.message); }
    }
    for (const account of accounts) {
      if (account.deleted) continue;
      try {
        assert.equal((await request('/users/me', { method: 'DELETE', token: account.accessToken, body: { password: account.identity.password } })).status, 202);
        account.deleted = true;
        assert.equal((await request('/auth/me', { token: account.accessToken })).status, 401);
      } catch (error) { failures.push(error.message); }
    }
    report.cleanup = { passed: failures.length === 0, accounts: accounts.length, retainedSessionRecords: streamIds.length, errors: failures };
    report.passed = report.passed && report.cleanup.passed;
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(artifact, 'profile-integration-result.json'), JSON.stringify(report, null, 2) + '\n');
    await Promise.all([owner.end(), app.end()]);
    if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), 'Profile integration fixture cleanup failed.');
  }
});
