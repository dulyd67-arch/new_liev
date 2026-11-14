import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { parseAuthHashConcurrency } from '../config';

const parameters = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
let active = 0;

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound expensive work instead of allowing an unbounded queue of memory-heavy
  // hashes. Per-route throttles separately limit repeated login attempts.
  if (active >= parseAuthHashConcurrency(process.env.AUTH_HASH_CONCURRENCY)) throw new ServiceUnavailableException('Authentication is busy; retry shortly.');
  active += 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, parameters, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally { active -= 1; }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const match = stored?.match(/^scrypt\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/);
  // Always perform one bounded scrypt operation, including unknown accounts.
  const salt = match ? Buffer.from(match[1]!, 'base64url') : Buffer.alloc(16);
  const expected = match ? Buffer.from(match[2]!, 'base64url') : Buffer.alloc(64);
  const actual = await derive(password, salt);
  return !!match && timingSafeEqual(actual, expected);
}
