import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { parseEnvironment } from '../src/config';
import { MailService } from '../src/auth/mail.service';
import { RedisService } from '../src/redis.service';

const valid = { DATABASE_URL: 'postgresql://app:fixture@localhost/livestar_test', REDIS_URL: 'redis://localhost:6379' };

describe('optional free-beta services', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates no SMTP transport and returns an honest unavailable result when email is explicitly disabled', async () => {
    const create = vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => { throw new Error('SMTP must not be constructed'); });
    const service = new MailService(parseEnvironment({ ...valid, EMAIL_ENABLED: 'false' }));
    expect(await service.challenge('fixture@integration.invalid', 'PASSWORD_RESET', 'r'.repeat(43))).toBe(false);
    service.onModuleDestroy();
    expect(create).not.toHaveBeenCalled();
  });

  it('retains actual transport delivery and link fragments when local email is enabled', async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ['fixture@integration.invalid'] });
    const close = vi.fn();
    const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close } as never);
    const service = new MailService(parseEnvironment(valid));
    expect(await service.challenge('fixture@integration.invalid', 'PASSWORD_RESET', 'r'.repeat(43))).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'fixture@integration.invalid',
      subject: 'LiveStar password reset',
      text: expect.stringContaining(`/reset-password#token=${'r'.repeat(43)}`),
    }));
    service.onModuleDestroy();
    expect(close).toHaveBeenCalledOnce();
  });

  it('creates no Redis connection when its explicit optional mode omits the URL', async () => {
    const service = new RedisService(parseEnvironment({ DATABASE_URL: valid.DATABASE_URL, REDIS_OPTIONAL: 'true' }));
    expect(service.isEnabled()).toBe(false);
    await service.probe();
    await service.onModuleDestroy();
  });
});
