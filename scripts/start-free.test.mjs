import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareFreeEnvironment, applicationEnvironments } from './start-free.mjs';

const input = Object.freeze({
  RENDER_EXTERNAL_URL: 'https://livestar-fixture.onrender.com',
  DATABASE_URL: 'postgresql://livestar_app:fixture-app-password@database.internal/neondb?sslmode=require',
  DATABASE_MIGRATION_URL: 'postgresql://schema_owner:fixture-owner-password@database.internal/neondb?sslmode=require',
  JWT_SECRET: 'fixture-jwt-not-a-real-signing-secret',
  LIVEKIT_API_KEY: 'fixture-key', LIVEKIT_API_SECRET: 'fixture-media-secret',
  SMTP_USER: 'fixture-mail-user', SMTP_PASSWORD: 'fixture-mail-password',
});

test('free service derives its HTTPS origin from trusted platform configuration', () => {
  const prepared = prepareFreeEnvironment(input);
  assert.equal(prepared.APP_PUBLIC_URL, input.RENDER_EXTERNAL_URL);
  assert.equal(prepared.WEB_ORIGIN, input.RENDER_EXTERNAL_URL);
  assert.equal(prepared.PORT, '10000');
  assert.equal(prepared.API_INTERNAL_URL, 'http://127.0.0.1:4001/api/v1');
  assert.equal(prepared.REDIS_OPTIONAL, 'true');
  assert.equal(prepared.EMAIL_ENABLED, 'false');
  assert.equal(prepared.AUTH_HASH_CONCURRENCY, '1');
  assert.equal(prepared.API_DOCS_ENABLED, 'false');
  assert.equal(input.APP_PUBLIC_URL, undefined, 'Input settings must not be mutated.');
  assert.equal(prepareFreeEnvironment({ ...input, APP_PUBLIC_URL: 'https://another-fixture.onrender.com' }).APP_PUBLIC_URL,
    'https://another-fixture.onrender.com');
});

test('untrusted URL components and public/private port collisions are rejected', () => {
  for (const APP_PUBLIC_URL of ['http://site.onrender.com', 'https://user:fixture-secret@site.onrender.com',
    'https://site.onrender.com/path', 'https://site.onrender.com/?token=fixture-secret', 'https://site.onrender.com/#fragment']) {
    assert.throws(() => prepareFreeEnvironment({ ...input, APP_PUBLIC_URL }), error => {
      assert.ok(!error.message.includes('fixture-secret'));
      return /HTTPS origin/.test(error.message);
    });
  }
  for (const PORT of ['80', '4001', '65536', '10e3', '-1', '']) {
    if (PORT === '') continue; // Empty provider input intentionally selects 10000.
    assert.throws(() => prepareFreeEnvironment({ ...input, PORT }), /PORT/);
  }
  assert.throws(() => prepareFreeEnvironment({ ...input, RENDER_EXTERNAL_URL: undefined }), /APP_PUBLIC_URL/);
});

test('database owner and runtime identities remain separate and errors redact connection values', () => {
  const invalid = [
    { DATABASE_URL: 'postgresql://schema_owner:fixture-private-value@database.internal/neondb' },
    { DATABASE_MIGRATION_URL: 'postgresql://livestar_app:fixture-private-value@database.internal/neondb' },
    { DATABASE_URL: 'postgresql://livestar_app:fixture-private-value@database.internal/otherdb' },
    { DATABASE_URL: 'not-a-url-with-fixture-private-value' },
    { DATABASE_URL: 'postgresql://livestar_app:fixture-private-value@other-project.internal/neondb' },
  ];
  for (const overrides of invalid) assert.throws(() => prepareFreeEnvironment({ ...input, ...overrides }), error => {
    assert.ok(!error.message.includes('fixture-private-value'));
    assert.ok(!error.message.includes('postgresql://'));
    return true;
  });
  const paired = prepareFreeEnvironment({ ...input,
    DATABASE_URL: 'postgresql://livestar_app:fixture-password@ep-same-pooler.us-east-2.aws.neon.tech/neondb',
    DATABASE_MIGRATION_URL: 'postgresql://schema_owner:fixture-password@ep-same.us-east-2.aws.neon.tech/neondb',
  });
  assert.ok(paired.DATABASE_URL.includes('ep-same-pooler'));
  assert.throws(() => prepareFreeEnvironment({ ...input,
    DATABASE_URL: 'postgresql://livestar_app:fixture-password@ep-other-pooler.us-east-2.aws.neon.tech/neondb',
    DATABASE_MIGRATION_URL: 'postgresql://schema_owner:fixture-password@ep-same.us-east-2.aws.neon.tech/neondb',
  }), /same database endpoint/);
});

test('web child receives no backend credentials and API is bound only to its private port', () => {
  const { api, web } = applicationEnvironments(prepareFreeEnvironment(input));
  assert.equal(api.PORT, '4001');
  assert.equal(api.API_HOST, '127.0.0.1');
  assert.equal(api.DATABASE_URL, input.DATABASE_URL);
  assert.equal(api.DATABASE_MIGRATION_URL, undefined);
  assert.equal(web.PORT, '10000');
  for (const key of ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'REDIS_URL', 'JWT_SECRET', 'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET', 'SMTP_USER', 'SMTP_PASSWORD']) assert.equal(web[key], undefined, key);
  assert.equal(api.NODE_OPTIONS, '--max-old-space-size=128');
  assert.equal(web.NODE_OPTIONS, '--max-old-space-size=128');
});
