import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

// These are isolated identity fixtures, never financial/provider transactions.
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
assert.ok(migrationUrl, 'Load .env.test.example before running authentication integration tests.');
assert.match(new URL(migrationUrl).pathname, /test/i, 'A dedicated test database is mandatory.');
assert.ok(process.env.DATABASE_URL, 'The restricted runtime database URL is required.');

const root = fileURLToPath(new URL('..', import.meta.url));
const port = process.env.AUTH_TEST_PORT || '4002';
const base = `http://127.0.0.1:${port}/api/v1`;
const origin = (process.env.WEB_ORIGIN || 'http://localhost:3000').split(',')[0];
const mailpit = process.env.MAILPIT_TEST_URL || 'http://127.0.0.1:8025';
const pool = new pg.Pool({ connectionString: migrationUrl, max: 2 });

async function request(path, { method = 'GET', body, token, cookie, web = true } = {}) {
  const headers = { ...(web ? { Origin: origin } : {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await response.json(); } catch { /* An empty 204 is allowed. */ }
  return { response, data };
}

function success(result, action) {
  assert.ok(result.response.ok, `${action}: expected success, received HTTP ${result.response.status}`);
  return result.data;
}

function sessionCookie(result) {
  const header = result.response.headers.getSetCookie().find(value => value.startsWith('livestar_refresh='));
  assert.ok(header, 'Web authentication must issue its refresh cookie.');
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Strict/i);
  return header.split(';')[0];
}

async function emailToken(recipient, subject) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listing = await fetch(`${mailpit}/api/v1/messages`).then(response => response.json());
    const message = listing.messages.find(item => item.Subject === subject
      && item.To.some(to => to.Address === recipient));
    if (message) {
      const content = await fetch(`${mailpit}/api/v1/message/${message.ID}`).then(response => response.json());
      const match = content.Text.match(/#token=([A-Za-z0-9_-]{43})/);
      assert.ok(match, 'A usable one-time token must arrive through SMTP.');
      return match[1];
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('The expected authentication email did not arrive through local SMTP.');
}

test('real restricted-role API: registration, SMTP verification, refresh reuse, reset, profile, export and deletion', { timeout: 90_000 }, async () => {
  let log = '';
  const server = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = chunk => { log = (log + chunk.toString()).slice(-4000); };
  server.stdout.on('data', collect);
  server.stderr.on('data', collect);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null) throw new Error('Authentication server exited before readiness.');
      try { ready = (await fetch(`${base}/health/ready`)).ok; } catch { /* Startup. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Authentication server must become ready against actual PostgreSQL and Redis.');
    assert.equal((await fetch(`${mailpit}/api/v1/messages`)).status, 200, 'Mailpit must be running.');

    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const email = `identity-fixture-${suffix}@integration.invalid`;
    const username = `fixture_${suffix}`;
    const password = `InitialPassword_${suffix}!`;
    const newPassword = `UpdatedPassword_${suffix}!`;
    const registerBody = {
      email, password, username, displayName: 'صاحب حساب اختبار', birthDate: '1990-06-15', locale: 'ar',
      termsVersion: '2026-11-07', privacyVersion: '2026-11-07', acceptTerms: true, acceptPrivacy: true,
    };

    assert.equal((await request('/auth/register', { method: 'POST', body: registerBody, web: false })).response.status, 403,
      'Web authentication requires a trusted Origin.');
    assert.equal((await request('/auth/register', { method: 'POST', body: { ...registerBody, roles: ['SUPER_ADMIN'] } })).response.status, 400,
      'Registration rejects role injection.');
    const registered = await request('/auth/register', { method: 'POST', body: registerBody });
    const account = success(registered, 'registration');
    const cookie = sessionCookie(registered);
    assert.equal(account.refreshToken, undefined, 'The web refresh secret must not appear in JSON.');
    assert.equal(account.emailDelivery, 'sent', 'Verification is actually delivered to SMTP.');
    const userId = account.user.id;
    const roles = await pool.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [userId]);
    assert.deepEqual(roles.rows.map(row => row.name), ['USER']);
    const age = await pool.query('SELECT age_attested_at,age_verified_at,password_hash FROM users WHERE id=$1', [userId]);
    assert.ok(age.rows[0].age_attested_at);
    assert.equal(age.rows[0].age_verified_at, null, 'Self-attestation cannot become external age verification.');
    assert.match(age.rows[0].password_hash, /^scrypt\$/);
    assert.ok(!age.rows[0].password_hash.includes(password));

    success(await request('/auth/me', { token: account.accessToken }), 'current user');
    const verifyToken = await emailToken(email, 'Verify your LiveStar email');
    success(await request('/auth/email/verify', { method: 'POST', body: { token: verifyToken } }), 'email verification');
    assert.equal((await request('/auth/email/verify', { method: 'POST', body: { token: verifyToken } })).response.status, 400,
      'Verification tokens are single-use.');

    const mobile = success(await request('/auth/mobile/login', { method: 'POST', body: { email, password }, web: false }), 'mobile login');
    assert.match(mobile.refreshToken, /^[A-Za-z0-9_-]{43}$/);
    const rotated = success(await request('/auth/mobile/refresh', { method: 'POST', body: { refreshToken: mobile.refreshToken }, web: false }), 'mobile rotation');
    assert.notEqual(rotated.refreshToken, mobile.refreshToken);
    assert.equal((await request('/auth/mobile/refresh', { method: 'POST', body: { refreshToken: mobile.refreshToken }, web: false })).response.status, 401,
      'A replayed predecessor must fail.');
    assert.equal((await request('/auth/me', { token: rotated.accessToken })).response.status, 401,
      'Family revocation must commit before returning the replay rejection.');

    const refreshedWeb = await request('/auth/refresh', { method: 'POST', cookie });
    const webAccount = success(refreshedWeb, 'web refresh');
    sessionCookie(refreshedWeb);
    success(await request('/users/me', {
      method: 'PATCH', token: webAccount.accessToken,
      body: { displayName: 'ملف شخصي محدث', bio: 'Integration fixture', locale: 'en', timezone: 'UTC' },
    }), 'profile update');
    const publicProfile = success(await request(`/users/${username}`), 'public profile');
    assert.equal(publicProfile.displayName, 'ملف شخصي محدث');
    assert.equal(publicProfile.email, undefined);
    const exported = success(await request('/users/me/export', { token: webAccount.accessToken }), 'identity export');
    assert.equal(exported.account.id, userId);
    assert.doesNotMatch(JSON.stringify(exported), /"(?:passwordHash|refreshTokenHash|tokenHash)"\s*:/);

    const forgotten = await request('/auth/password/forgot', { method: 'POST', body: { email } });
    success(forgotten, 'password recovery request');
    assert.equal(forgotten.data?.token, undefined, 'Recovery secrets are delivered by email only.');
    const resetToken = await emailToken(email, 'LiveStar password reset');
    success(await request('/auth/password/reset', { method: 'POST', body: { token: resetToken, password: newPassword } }), 'password reset');
    assert.equal((await request('/auth/me', { token: webAccount.accessToken })).response.status, 401,
      'Reset revokes pre-existing sessions.');
    assert.equal((await request('/auth/password/reset', { method: 'POST', body: { token: resetToken, password: newPassword } })).response.status, 400);
    assert.equal((await request('/auth/login', { method: 'POST', body: { email, password } })).response.status, 401);
    const relogged = success(await request('/auth/login', { method: 'POST', body: { email, password: newPassword } }), 'new password login');
    assert.equal((await request('/users/me', { method: 'DELETE', token: relogged.accessToken, body: { password } })).response.status, 401);
    const deleted = await request('/users/me', { method: 'DELETE', token: relogged.accessToken, body: { password: newPassword } });
    assert.equal(deleted.response.status, 202);
    assert.equal((await request('/auth/me', { token: relogged.accessToken })).response.status, 401);
    const retained = await pool.query('SELECT status,password_hash,birth_date,email FROM users WHERE id=$1', [userId]);
    assert.equal(retained.rows[0].status, 'DELETION_PENDING');
    assert.equal(retained.rows[0].password_hash, null);
    assert.equal(retained.rows[0].birth_date, null);
    assert.match(retained.rows[0].email, /@deleted\.invalid$/);
    assert.equal((await request(`/users/${username}`)).response.status, 404);
    console.log('Verified real SMTP delivery and the complete identity lifecycle; no external mail or money was sent.');
  } finally {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
    await pool.end();
  }
});
