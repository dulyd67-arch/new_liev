import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';

describe('password hashing', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('uses salted memory-hard scrypt and checks both correct and incorrect credentials', async () => {
    const first = await hashPassword('a-strong-passphrase-123');
    const second = await hashPassword('a-strong-passphrase-123');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(await verifyPassword('a-strong-passphrase-123', first)).toBe(true);
    expect(await verifyPassword('different-passphrase-456', first)).toBe(false);
    expect(await verifyPassword('a-strong-passphrase-123', null)).toBe(false);
  });

  it('bounds memory-heavy hashing to one operation when the free deployment limit is enabled', async () => {
    vi.stubEnv('AUTH_HASH_CONCURRENCY', '1');
    const first = hashPassword('a-strong-passphrase-123');
    await expect(hashPassword('another-strong-passphrase-456')).rejects.toThrow('Authentication is busy');
    const saved = await first;
    expect(await verifyPassword('a-strong-passphrase-123', saved)).toBe(true);
  });
});
