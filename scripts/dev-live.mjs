import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  console.error('Copy .env.example to .env and start the Docker services first.');
  process.exit(1);
}

const apiPort = process.env.PORT || '4001';
const environment = {
  ...process.env,
  PORT: apiPort,
  API_INTERNAL_URL: process.env.API_INTERNAL_URL || `http://127.0.0.1:${apiPort}/api/v1`,
};
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = ['dev:api', 'dev:web'].map(script => spawn(command, ['run', script], {
  cwd: root, env: environment, stdio: 'inherit', detached: process.platform !== 'win32',
}));
let stopping = false;
function signal(child, name) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
    else child.kill(name);
  } catch { /* A child may exit between inspection and signaling. */ }
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) signal(child, 'SIGTERM');
  const timer = setTimeout(() => {
    for (const child of children) signal(child, 'SIGKILL');
    process.exit(code);
  }, 4000);
  timer.unref();
  process.exitCode = code;
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
console.log('Starting LiveStar. Open http://localhost:3000 when Next.js reports Ready.');
