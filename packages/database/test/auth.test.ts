import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Pool, type PoolClient } from 'pg';

// Synthetic database fixtures only. No real account, token or payment is made.
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) throw new Error('DATABASE_MIGRATION_URL is required for auth integration tests.');
if (!/test/i.test(decodeURIComponent(new URL(ownerUrl).pathname.slice(1))) && process.env.LIVESTAR_ALLOW_TEST_DB !== 'true') {
  throw new Error('Authentication integration tests require a dedicated test database.');
}
const pool = new Pool({ connectionString: ownerUrl, max: 8, statement_timeout: 10_000 });
const fixtureHash = `scrypt$131072$8$1$${Buffer.alloc(16, 1).toString('base64url')}$${Buffer.alloc(64, 2).toString('base64url')}`;
const tokenHash = () => createHash('sha256').update(randomBytes(32)).digest('hex');

before(async () => {
  const result = await pool.query("SELECT to_regprocedure('public.register_user(uuid,text,text,text,text,date,text,text,text)') IS NOT NULL AS installed");
  assert.equal(result.rows[0].installed, true, 'Apply the authentication migration and configuration seed.');
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
  } finally {
    client.release();
  }
}

async function rejectsSql(operation: () => Promise<unknown>, codes: string[]): Promise<void> {
  await assert.rejects(operation, (error: Error & { code?: string }) => {
    assert.ok(error.code && codes.includes(error.code), `Expected ${codes.join('/')} but got ${error.code}: ${error.message}`);
    return true;
  });
}

function registration(overrides: Partial<{ id: string; email: string; hash: string; username: string; displayName: string; birthDate: string; terms: string; privacy: string; locale: string }> = {}) {
  const tag = randomUUID().replaceAll('-', '');
  return {
    id: randomUUID(), email: `fixture-${tag}@integration.invalid`, hash: fixtureHash,
    username: `u_${tag.slice(0, 24)}`, displayName: 'Integration fixture',
    birthDate: '1990-01-01', terms: 'fixture-terms-v1', privacy: 'fixture-privacy-v1', locale: 'ar',
    ...overrides,
  };
}

async function register(data = registration()): Promise<string> {
  const result = await asApp((client) => client.query(
    'SELECT public.register_user($1,$2,$3,$4,$5,$6::date,$7,$8,$9) AS id',
    [data.id, data.email, data.hash, data.username, data.displayName, data.birthDate, data.terms, data.privacy, data.locale],
  ));
  assert.equal(result.rows[0].id, data.id);
  return data.id;
}

test('runtime registration normalizes identity, records attestation and consent, assigns USER only and creates no money', async () => {
  const data = registration();
  data.email = `  ${data.email.toUpperCase()}  `;
  data.username = `  ${data.username.toUpperCase()}  `;
  data.displayName = '  Integration fixture  ';
  const user = await register(data);
  const result = await pool.query(`SELECT u.*,p.username,p.display_name,
    ARRAY(SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) AS roles
    FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE u.id=$1`, [user]);
  const row = result.rows[0];
  assert.equal(row.email, data.email.trim().toLowerCase());
  assert.equal(row.username, data.username.trim().toLowerCase());
  assert.equal(row.display_name, data.displayName.trim());
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.age_verified_at, null, 'Self-attestation cannot establish external age verification.');
  assert.equal(row.email_verified_at, null);
  assert.ok(row.age_attested_at && row.terms_accepted_at && row.privacy_accepted_at);
  assert.equal(row.terms_version, data.terms);
  assert.equal(row.privacy_version, data.privacy);
  assert.deepEqual(row.roles, ['USER']);
  const wallets = await pool.query('SELECT count(*)::int AS n FROM coin_wallets WHERE user_id=$1', [user]);
  assert.equal(wallets.rows[0].n, 0);
});

test('invalid registration or normalized duplicate identity leaves no partial users or role assignments', async () => {
  const cases = [
    { birthDate: new Date().toISOString().slice(0, 10) },
    { birthDate: '1800-01-01' }, { locale: 'xx' }, { terms: '' }, { privacy: '' },
    { hash: 'not-a-password-hash' }, { username: 'deleted_reserved' },
    { email: 'reserved@deleted.invalid' }, { displayName: '   ' },
  ];
  for (const override of cases) {
    const data = registration(override);
    await rejectsSql(() => register(data), ['23514']);
    const count = await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [data.id]);
    assert.equal(count.rows[0].n, 0);
  }
  const original = registration();
  await register(original);
  const duplicate = registration({ email: original.email.toUpperCase() });
  await rejectsSql(() => register(duplicate), ['23505']);
  const count = await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [duplicate.id]);
  assert.equal(count.rows[0].n, 0);
});

test('auth runtime privileges exclude role changes, status and verification escalation, identity reassignment and finance', async () => {
  const user = await register();
  const denied = [
    (client: PoolClient) => client.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [user]),
    (client: PoolClient) => client.query('UPDATE users SET age_verified_at=now() WHERE id=$1', [user]),
    (client: PoolClient) => client.query('UPDATE users SET birth_date=\'1995-01-01\' WHERE id=$1', [user]),
    (client: PoolClient) => client.query('UPDATE user_profiles SET username=\'forbidden_change\' WHERE user_id=$1', [user]),
    (client: PoolClient) => client.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE name='ADMIN'", [user]),
    (client: PoolClient) => client.query("UPDATE roles SET permissions=ARRAY['*'] WHERE name='USER'"),
    (client: PoolClient) => client.query("UPDATE platform_settings SET value='true'::jsonb WHERE key='payments.enabled'"),
    (client: PoolClient) => client.query("INSERT INTO users(id,email,updated_at) VALUES ($1,'forbidden@integration.invalid',now())", [randomUUID()]),
  ];
  for (const operation of denied) await rejectsSql(() => asApp(operation), ['42501']);
  await asApp((client) => client.query("UPDATE user_profiles SET display_name='Changed fixture',bio='Updated fixture',locale='en',timezone='UTC' WHERE user_id=$1", [user]));
  const profile = await pool.query('SELECT display_name FROM user_profiles WHERE user_id=$1', [user]);
  assert.equal(profile.rows[0].display_name, 'Changed fixture');
});

test('refresh rotation keeps user, family and client channel fixed and cannot restore a revoked session', async () => {
  const user = await register();
  const other = await register();
  const family = randomUUID();
  const session = randomUUID();
  const successor = randomUUID();
  const wrongClient = randomUUID();
  const wrongOwner = randomUUID();
  const insert = (id: string, owner: string, client: 'WEB' | 'MOBILE') => asApp((connection) => connection.query(
    'INSERT INTO sessions(id,user_id,refresh_token_hash,family_id,client_type,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval\'1 day\')',
    [id, owner, tokenHash(), family, client],
  ));
  await insert(session, user, 'WEB');
  await insert(successor, user, 'WEB');
  await insert(wrongClient, user, 'MOBILE');
  await insert(wrongOwner, other, 'WEB');
  for (const invalid of [wrongClient, wrongOwner]) {
    await rejectsSql(() => asApp((client) => client.query('UPDATE sessions SET revoked_at=now(),replaced_by_id=$2 WHERE id=$1', [session, invalid])), ['23514']);
  }
  await rejectsSql(() => asApp((client) => client.query('UPDATE sessions SET replaced_by_id=$2 WHERE id=$1', [session, successor])), ['23514']);
  await asApp((client) => client.query('UPDATE sessions SET revoked_at=now(),replaced_by_id=$2 WHERE id=$1', [session, successor]));
  await rejectsSql(() => asApp((client) => client.query('UPDATE sessions SET revoked_at=NULL WHERE id=$1', [session])), ['23514']);
  await rejectsSql(() => asApp((client) => client.query('UPDATE sessions SET refresh_token_hash=$2 WHERE id=$1', [session, tokenHash()])), ['42501']);
});

test('challenge hashes are unique and consumption is permanent', async () => {
  const user = await register();
  const id = randomUUID();
  const hash = tokenHash();
  const insert = (challengeId: string, challengeHash: string) => asApp((client) => client.query(
    "INSERT INTO auth_challenges(id,user_id,kind,token_hash,expires_at) VALUES($1,$2,'PASSWORD_RESET',$3,now()+interval'1 hour')", [challengeId, user, challengeHash],
  ));
  await rejectsSql(() => insert(randomUUID(), 'unhashed-token'), ['23514']);
  await insert(id, hash);
  await rejectsSql(() => insert(randomUUID(), hash), ['23505']);
  await asApp((client) => client.query('UPDATE auth_challenges SET consumed_at=now() WHERE id=$1', [id]));
  await rejectsSql(() => asApp((client) => client.query('UPDATE auth_challenges SET consumed_at=NULL WHERE id=$1', [id])), ['23514']);
  await rejectsSql(() => asApp((client) => client.query('UPDATE auth_challenges SET expires_at=now()+interval\'1 year\' WHERE id=$1', [id])), ['42501']);
});

test('account deletion pseudonymizes personal data, invalidates authentication and retains consent, finance and immutable audit references', async () => {
  const data = registration();
  const user = await register(data);
  const account = randomUUID();
  const wallet = randomUUID();
  const audit = randomUUID();
  await pool.query("INSERT INTO ledger_accounts(id,owner_id,code,unit,kind,enforce_non_negative) VALUES($1,$2,$3,'LIVECOIN','COIN_WALLET',true)", [account, user, `fixture:delete:${randomUUID()}`]);
  await pool.query('INSERT INTO coin_wallets(id,user_id,ledger_account_id) VALUES($1,$2,$3)', [wallet, user, account]);
  await asApp(async (client) => {
    await client.query('INSERT INTO sessions(id,user_id,refresh_token_hash,family_id,expires_at) VALUES($1,$2,$3,$4,now()+interval\'1 day\')', [randomUUID(), user, tokenHash(), randomUUID()]);
    await client.query("INSERT INTO auth_challenges(id,user_id,kind,token_hash,expires_at) VALUES($1,$2,'EMAIL_VERIFY',$3,now()+interval'1 day')", [randomUUID(), user, tokenHash()]);
    await client.query("INSERT INTO admin_audit_logs(id,actor_id,action,entity_type,entity_id,request_id) VALUES($1,$2,'INTEGRATION_FIXTURE','USER',$4,$3)", [audit, user, randomUUID(), user]);
  });
  await asApp(async (client) => {
    assert.equal((await client.query('SELECT public.request_account_deletion($1) AS deleted', [user])).rows[0].deleted, true);
  });
  const result = await pool.query('SELECT u.*,p.username,p.display_name,p.bio,p.avatar_key FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE u.id=$1', [user]);
  const row = result.rows[0];
  assert.equal(row.status, 'DELETION_PENDING');
  assert.equal(row.email, `deleted.${user}@deleted.invalid`);
  assert.ok(row.deleted_at);
  assert.equal(row.password_hash, null);
  assert.equal(row.birth_date, null);
  assert.equal(row.age_attested_at, null);
  assert.equal(row.display_name, 'Deleted user');
  assert.ok(row.username.startsWith('deleted_'));
  assert.equal(row.bio, null);
  assert.equal(row.avatar_key, null);
  assert.equal(row.terms_version, data.terms);
  assert.equal(row.privacy_version, data.privacy);
  const references = await pool.query(`SELECT
    (SELECT count(*)::int FROM sessions WHERE user_id=$1 AND revoked_at IS NULL) AS active_sessions,
    (SELECT count(*)::int FROM auth_challenges WHERE user_id=$1 AND consumed_at IS NULL) AS active_challenges,
    (SELECT count(*)::int FROM coin_wallets WHERE id=$2 AND user_id=$1) AS wallets,
    (SELECT count(*)::int FROM admin_audit_logs WHERE id=$3 AND actor_id=$1) AS audit`, [user, wallet, audit]);
  assert.deepEqual(references.rows[0], { active_sessions: 0, active_challenges: 0, wallets: 1, audit: 1 });
  await rejectsSql(() => pool.query('UPDATE coin_wallets SET user_id=$2 WHERE id=$1', [wallet, user]), ['23514']);
  await rejectsSql(() => pool.query('DELETE FROM coin_wallets WHERE id=$1', [wallet]), ['23514']);
  await asApp(async (client) => {
    assert.equal((await client.query('SELECT public.request_account_deletion($1) AS deleted', [user])).rows[0].deleted, true);
  });
});
