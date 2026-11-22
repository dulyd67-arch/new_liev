import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Pool, type PoolClient } from 'pg';

const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) throw new Error('DATABASE_MIGRATION_URL is required for profile avatar database tests.');
const databaseUrl = new URL(ownerUrl);
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(databaseUrl.hostname) || !/test/i.test(decodeURIComponent(databaseUrl.pathname))) {
  throw new Error('Profile avatar database tests require a dedicated local test database.');
}
const pool = new Pool({ connectionString: ownerUrl, max: 5, statement_timeout: 10_000 });

before(async () => {
  const result = await pool.query(`SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='user_profiles_avatar_key_size' AND conrelid='public.user_profiles'::regclass
  ) AS installed`);
  assert.equal(result.rows[0].installed, true, 'Apply the profile avatars migration before testing.');
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

async function fixture(): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO public.users(id,email,updated_at) VALUES($1,$2,now())', [id, `profile-avatar-${id}@integration.invalid`]);
  await pool.query('INSERT INTO public.user_profiles(user_id,username,display_name) VALUES($1,$2,$3)', [id, `avatar_${id.replaceAll('-', '').slice(0, 24)}`, 'Avatar database fixture']);
  return id;
}

async function avatar(id: string): Promise<string | null> {
  return (await pool.query('SELECT avatar_key FROM public.user_profiles WHERE user_id=$1', [id])).rows[0].avatar_key;
}

async function rejectsSql(operation: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
  await assert.rejects(operation, (error: Error & { code?: string; constraint?: string }) => {
    assert.equal(error.code, code, error.message);
    if (constraint) assert.equal(error.constraint, constraint);
    return true;
  });
}

test('avatar grant is scoped to the existing application role and does not broaden profile identity privileges', async () => {
  const result = await pool.query(`SELECT
    has_column_privilege('livestar_app','public.user_profiles','avatar_key','UPDATE') AS avatar,
    has_column_privilege('livestar_app','public.user_profiles','display_name','UPDATE') AS display_name,
    has_column_privilege('livestar_app','public.user_profiles','username','UPDATE') AS username,
    has_column_privilege('livestar_app','public.user_profiles','user_id','UPDATE') AS user_id,
    has_column_privilege('livestar_app','public.user_profiles','country_code','UPDATE') AS country_code,
    has_table_privilege('livestar_app','public.user_profiles','UPDATE') AS table_update,
    has_table_privilege('livestar_app','public.user_roles','INSERT') AS role_insert,
    has_table_privilege('livestar_app','public.wallet_ledger','INSERT') AS finance_insert`);
  assert.deepEqual(result.rows[0], { avatar: true, display_name: true, username: false, user_id: false, country_code: false, table_update: false, role_insert: false, finance_insert: false });
});

test('runtime can set and clear bounded avatar values without changing the profile owner', async () => {
  const id = await fixture();
  const photo = `data:image/webp;base64,${Buffer.alloc(48 * 1024, 1).toString('base64')}`;
  assert.equal(Buffer.byteLength(photo), 65559);
  await asApp(client => client.query('UPDATE public.user_profiles SET avatar_key=$2 WHERE user_id=$1', [id, photo]));
  assert.equal(await avatar(id), photo);
  // Existing object keys remain valid; image parsing belongs to the HTTP API.
  await asApp(client => client.query('UPDATE public.user_profiles SET avatar_key=$2 WHERE user_id=$1', [id, 'avatars/fixture/profile.webp']));
  assert.equal(await avatar(id), 'avatars/fixture/profile.webp');
  await asApp(client => client.query('UPDATE public.user_profiles SET avatar_key=NULL WHERE user_id=$1', [id]));
  assert.equal(await avatar(id), null);
});

test('database byte cap rejects oversized ASCII and multibyte writes atomically', async () => {
  const id = await fixture();
  const boundary = 'a'.repeat(65560);
  await asApp(client => client.query('UPDATE public.user_profiles SET avatar_key=$2 WHERE user_id=$1', [id, boundary]));
  for (const oversized of ['a'.repeat(65561), 'ع'.repeat(32781)]) {
    assert.ok(Buffer.byteLength(oversized) > 65560);
    await rejectsSql(() => asApp(client => client.query('UPDATE public.user_profiles SET avatar_key=$2 WHERE user_id=$1', [id, oversized])), '23514', 'user_profiles_avatar_key_size');
    assert.equal(await avatar(id), boundary);
  }
});

test('avatar access does not permit username, owner, country or role reassignment and financial writes', async () => {
  const id = await fixture();
  const another = await fixture();
  for (const operation of [
    (client: PoolClient) => client.query('UPDATE public.user_profiles SET username=$2 WHERE user_id=$1', [id, `forbidden_${randomUUID().slice(0, 8)}`]),
    (client: PoolClient) => client.query('UPDATE public.user_profiles SET user_id=$2 WHERE user_id=$1', [id, another]),
    (client: PoolClient) => client.query("UPDATE public.user_profiles SET country_code='US' WHERE user_id=$1", [id]),
    (client: PoolClient) => client.query("INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name='ADMIN'", [id]),
    (client: PoolClient) => client.query("UPDATE public.platform_settings SET value='true'::jsonb WHERE key='payments.enabled'"),
  ]) await rejectsSql(() => asApp(operation), '42501');
  assert.equal(await avatar(id), null);
});

test('account deletion clears the stored avatar while retaining the stable account identity', async () => {
  const id = await fixture();
  await asApp(client => client.query("UPDATE public.user_profiles SET avatar_key='avatars/fixture/delete-me.webp' WHERE user_id=$1", [id]));
  await asApp(client => client.query('SELECT public.request_account_deletion($1)', [id]));
  const result = await pool.query('SELECT u.id,u.status,u.deleted_at,p.avatar_key,p.display_name FROM public.users u JOIN public.user_profiles p ON p.user_id=u.id WHERE u.id=$1', [id]);
  assert.equal(result.rows[0].id, id);
  assert.equal(result.rows[0].status, 'DELETION_PENDING');
  assert.ok(result.rows[0].deleted_at);
  assert.equal(result.rows[0].avatar_key, null);
  assert.equal(result.rows[0].display_name, 'Deleted user');
});
