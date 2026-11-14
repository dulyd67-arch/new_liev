import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A dependency-free fallback for offline development, not a substitute for
// TypeScript compilation, Prisma validation, HTTP tests or PostgreSQL tests.
if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
  throw new Error('Offline checks require Node.js 22.13+; Node.js 24 is recommended.');
}

const repository = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'livestar-offline-'));

async function stripped(relativePath) {
  return nodeModule.stripTypeScriptTypes(await readFile(join(repository, relativePath), 'utf8'), { mode: 'strip' });
}

function runTest(file, label) {
  console.log(`\n${label}`);
  // Keep test execution in one process so restricted sandboxes still report
  // every suite, while using Node's genuine test runner and exit status.
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=spec', file], {
    stdio: 'inherit',
    cwd: repository,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? result.signal}).`);
}

try {
  await writeFile(join(scratch, 'money.mjs'), await stripped('packages/money/src/index.ts'));
  const originalMoneyTest = await stripped('packages/money/test/money.test.ts');
  const importPattern = /from\s+(['"])\.\.\/src\/index(?:\.ts)?\1/g;
  assert.equal([...originalMoneyTest.matchAll(importPattern)].length, 1, 'Offline runner expects one local money source import.');
  await writeFile(join(scratch, 'money.test.mjs'), originalMoneyTest.replace(importPattern, "from './money.mjs'"));
  runTest(join(scratch, 'money.test.mjs'), 'Money unit tests — original source and tests, TypeScript types stripped only');

  await writeFile(join(scratch, 'config.mjs'), await stripped('apps/api/src/config.ts'));
  await writeFile(join(scratch, 'config.test.mjs'), `
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnvironment, EnvironmentValidationError } from './config.mjs';
const valid = {
  DATABASE_URL: 'postgresql://offline:private@localhost:5432/livestar_test',
  REDIS_URL: 'redis://localhost:6379/0',
};
test('offline config smoke: rejects missing settings without exposing secret values', () => {
  assert.throws(() => parseEnvironment({}), /DATABASE_URL, REDIS_URL/);
  assert.throws(
    () => parseEnvironment({ ...valid, DATABASE_URL: 'https://private-password@localhost/' }),
    error => error instanceof EnvironmentValidationError && !error.message.includes('private-password'),
  );
});
test('offline config smoke: rejects non-origin and wildcard browser origins', () => {
  for (const WEB_ORIGIN of ['*', 'https://example.com/path', 'https://user:pass@example.com', '']) {
    assert.throws(() => parseEnvironment({ ...valid, WEB_ORIGIN }), /WEB_ORIGIN/);
  }
});
test('offline config smoke: rejects invalid listening ports', () => {
  for (const PORT of ['0', '65536', '40.5', '4e3', '']) {
    assert.throws(() => parseEnvironment({ ...valid, PORT }), /PORT/);
  }
});
test('offline config smoke: exact origins and defaults are immutable', () => {
  const config = parseEnvironment({ ...valid, WEB_ORIGIN: 'https://livestar.example,http://localhost:3000,https://livestar.example' });
  assert.deepEqual(config.webOrigins, ['https://livestar.example', 'http://localhost:3000']);
  assert.equal(config.port, 4000);
  assert.equal(config.environment, 'development');
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.webOrigins), true);
});
`);
  runTest(join(scratch, 'config.test.mjs'), 'API configuration smoke tests — standalone validation only');
  console.log('\nOffline checks passed. Full build, HTTP and database checks still require their declared dependencies.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
