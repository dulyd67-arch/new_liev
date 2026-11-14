import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const privatePort = 4001;
const internalUrl = `http://127.0.0.1:${privatePort}/api/v1`;
const backendSecretKeys = [
  'DATABASE_URL', 'DATABASE_MIGRATION_URL', 'REDIS_URL', 'JWT_SECRET',
  'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'SMTP_USER', 'SMTP_PASSWORD',
];

/** Resolve a deployment origin from trusted configuration, never request headers. */
export function prepareFreeEnvironment(input) {
  const rawOrigin = input.APP_PUBLIC_URL || input.RENDER_EXTERNAL_URL;
  if (!rawOrigin) throw new Error('APP_PUBLIC_URL or RENDER_EXTERNAL_URL is required.');
  let publicOrigin;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
    publicOrigin = parsed.origin;
  } catch { throw new Error('The public application URL must be an HTTPS origin.'); }

  const rawPort = input.PORT || '10000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1024 || port > 65535 || port === privatePort) {
    throw new Error('PORT must be an unprivileged public port distinct from the private API port.');
  }
  let runtime;
  let migration;
  try {
    runtime = new URL(input.DATABASE_URL);
    migration = new URL(input.DATABASE_MIGRATION_URL);
    if (![runtime, migration].every(url => ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.pathname.length > 1)) throw new Error();
  } catch { throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must be valid PostgreSQL connection URLs.'); }
  if (decodeURIComponent(runtime.username) !== 'livestar_app' || decodeURIComponent(migration.username) === 'livestar_app') {
    throw new Error('DATABASE_URL must use livestar_app; DATABASE_MIGRATION_URL must use the separate schema owner.');
  }
  if (runtime.pathname !== migration.pathname) throw new Error('Runtime and migration URLs must select the same database.');
  const endpoint = url => {
    const host = url.hostname.toLowerCase();
    const normalized = host.endsWith('.neon.tech') ? host.replace(/-pooler(?=\.)/, '') : host;
    return `${normalized}:${url.port || '5432'}`;
  };
  if (endpoint(runtime) !== endpoint(migration)) {
    throw new Error('Runtime and migration URLs must target the same database endpoint; Neon direct/pooler names are supported.');
  }

  return {
    ...input,
    NODE_ENV: 'production',
    PORT: String(port),
    APP_PUBLIC_URL: publicOrigin,
    WEB_ORIGIN: input.WEB_ORIGIN || publicOrigin,
    API_INTERNAL_URL: internalUrl,
    REDIS_OPTIONAL: input.REDIS_OPTIONAL ?? 'true',
    EMAIL_ENABLED: input.EMAIL_ENABLED ?? 'false',
    AUTH_HASH_CONCURRENCY: input.AUTH_HASH_CONCURRENCY ?? '1',
    API_DOCS_ENABLED: input.API_DOCS_ENABLED ?? 'false',
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

export function applicationEnvironments(environment) {
  const api = { ...environment, PORT: String(privatePort), API_HOST: '127.0.0.1' };
  delete api.DATABASE_MIGRATION_URL;
  // Native scrypt/Prisma memory is outside the V8 limit; this is a bound, not a
  // guarantee that every traffic pattern will fit a free 512 MB service.
  api.NODE_OPTIONS = environment.API_NODE_OPTIONS || '--max-old-space-size=128';
  const web = { ...environment };
  for (const key of backendSecretKeys) delete web[key];
  web.NODE_OPTIONS = environment.WEB_NODE_OPTIONS || '--max-old-space-size=128';
  return { api, web };
}

function delay(milliseconds) { return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)); }

export async function startFreeService(input = process.env) {
  const environment = prepareFreeEnvironment(input);
  const apiMain = join(root, 'apps/api/dist/main.js');
  const configFile = join(root, 'apps/api/dist/config.js');
  const mediaFile = join(root, 'apps/api/dist/streams/livekit.service.js');
  const nextCli = join(root, 'node_modules/next/dist/bin/next');
  if (![apiMain, configFile, mediaFile, nextCli, join(root, 'apps/web/.next/BUILD_ID')].every(existsSync)) {
    throw new Error('Compiled API and web output are missing. Build the production image first.');
  }

  const children = new Set();
  let stopping = false;
  let complete;
  const done = new Promise(resolveDone => { complete = resolveDone; });
  let stopPromise;

  function signal(child, name) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch { /* A child may have exited while the signal was being sent. */ }
  }

  function stop(code) {
    if (stopPromise) return stopPromise;
    stopping = true;
    process.exitCode = code;
    stopPromise = (async () => {
      for (const child of children) signal(child, 'SIGTERM');
      const limit = Date.now() + 5000;
      while (children.size && Date.now() < limit) await delay(50);
      for (const child of children) signal(child, 'SIGKILL');
      complete();
    })();
    return stopPromise;
  }

  function launch(name, executable, args, env, { setup = false, captureError = false } = {}) {
    const child = spawn(executable, args, {
      cwd: root, env, detached: process.platform !== 'win32',
      // Migrations may include database metadata in tool output. Keep their raw
      // output off public application logs; exit status is reported explicitly.
      stdio: setup ? ['ignore', 'ignore', captureError ? 'pipe' : 'ignore'] : 'inherit',
    });
    children.add(child);
    child.once('error', () => {
      children.delete(child);
      if (!setup && !stopping) { console.error(`${name} could not start.`); void stop(1); }
    });
    child.once('exit', code => {
      children.delete(child);
      if (!setup && !stopping) {
        console.error(`${name} exited unexpectedly (code ${code ?? 'signal'}).`);
        void stop(code && code > 0 ? code : 1);
      }
    });
    return child;
  }

  const onSignal = () => { void stop(0); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    // A short-lived process validates the compiled configuration before SQL is
    // applied. The supervisor does not retain Nest/SDK module caches in memory.
    const validationCode = `
      try {
        require(process.argv[1]).parseEnvironment(process.env);
        new (require(process.argv[2]).LiveKitService)().onModuleInit();
      } catch (error) {
        console.error(error && error.name === 'EnvironmentValidationError'
          ? error.message : 'Production configuration validation failed.');
        process.exitCode = 1;
      }
    `;
    const validation = launch('Configuration validation', process.execPath,
      ['--max-old-space-size=96', '--eval', validationCode, configFile, mediaFile],
      { ...environment, PORT: String(privatePort), API_HOST: '127.0.0.1', NODE_OPTIONS: '' },
      { setup: true, captureError: true });
    let validationError = '';
    validation.stderr.on('data', chunk => { validationError = (validationError + chunk.toString()).slice(-4000); });
    await new Promise((resolveValidation, rejectValidation) => {
      validation.once('error', () => rejectValidation(new Error('Configuration validation could not start.')));
      validation.once('exit', code => stopping || code === 0 ? resolveValidation()
        : rejectValidation(new Error(validationError.trim() || 'Production configuration validation failed.')));
    });
    if (stopping) { await done; return; }
    console.log('Applying database migrations and reference configuration.');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const migration = launch('Database deployment', npm, ['run', 'db:deploy'], environment, { setup: true });
    await new Promise((resolveMigration, rejectMigration) => {
      migration.once('error', () => rejectMigration(new Error('Database deployment could not start.')));
      migration.once('exit', code => stopping || code === 0 ? resolveMigration() : rejectMigration(new Error(`Database deployment failed (exit ${code ?? 'signal'}). Check database setup from a trusted console.`)));
    });
    if (stopping) { await done; return; }
    delete environment.DATABASE_MIGRATION_URL;
    delete process.env.DATABASE_MIGRATION_URL;
    const { api, web } = applicationEnvironments(environment);
    const backend = launch('API', process.execPath, [apiMain], api);
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (!stopping && backend.exitCode === null && Date.now() < deadline) {
      try {
        const response = await fetch(`${internalUrl}/health/ready`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) { ready = true; break; }
      } catch { /* A cold database or the API may still be starting. */ }
      await delay(250);
    }
    if (!ready) {
      if (!stopping) throw new Error('The API did not become ready within the startup deadline.');
      await done; return;
    }
    launch('Web', process.execPath, [nextCli, 'start', join(root, 'apps/web'), '--hostname', '0.0.0.0', '--port', environment.PORT], web);
    console.log('API is ready. Starting the public web listener.');
    await done;
  } catch (error) {
    await stop(1);
    throw error;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startFreeService().catch(error => {
    console.error(error instanceof Error ? error.message : 'LiveStar production startup failed.');
    process.exitCode = 1;
  });
}
