import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/application';
import { APP_CONFIG, parseEnvironment } from '../src/config';
import { AuthService } from '../src/auth/auth.service';
import { DatabaseService } from '../src/database.service';
import { RedisService } from '../src/redis.service';
import { LiveKitService } from '../src/streams/livekit.service';

describe('explicit free-beta HTTP capabilities', () => {
  let app: INestApplication;
  const auth = { requestChallenge: vi.fn(), consumeChallenge: vi.fn() };
  beforeEach(async () => {
    auth.requestChallenge.mockReset();
    auth.consumeChallenge.mockReset().mockResolvedValue(undefined);
    const config = parseEnvironment({
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://app:fixture@postgres/livestar_test',
      REDIS_OPTIONAL: 'true', EMAIL_ENABLED: 'false', AUTH_HASH_CONCURRENCY: '1',
      JWT_SECRET: 'a12edc55a45fc37f12e04e0a814f26a391fa6013d0c82211d142a4d8c2be239f',
      WEB_ORIGIN: 'https://livestar.onrender.com', APP_PUBLIC_URL: 'https://livestar.onrender.com',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(config)
      .overrideProvider(DatabaseService).useValue({ probe: async () => undefined })
      .overrideProvider(RedisService).useValue({ isEnabled: () => false, probe: vi.fn() })
      .overrideProvider(LiveKitService).useValue({ configured: () => true })
      .overrideProvider(AuthService).useValue(auth)
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApplication(app);
    await app.init();
  });
  afterEach(async () => { await app?.close(); });

  it('declares unavailable email and disabled Redis accurately while retaining database readiness', async () => {
    const platform = await request(app.getHttpServer()).get('/api/v1/platform').expect(200);
    expect(platform.body.emailEnabled).toBe(false);
    const ready = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(ready.body).toEqual({ status: 'ready', dependencies: { postgres: 'up', redis: 'disabled' } });
    await request(app.getHttpServer()).get('/api/docs').expect(404);
  });

  it('rejects new recovery and verification mail requests instead of pretending to send them', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ email: 'fixture@integration.invalid' }).expect(503);
    await request(app.getHttpServer()).post('/api/v1/auth/email/resend').send({ email: 'fixture@integration.invalid' }).expect(503);
    expect(auth.requestChallenge).not.toHaveBeenCalled();
  });

  it('still consumes valid previously issued reset and verification tokens without sending new email', async () => {
    const token = 'r'.repeat(43);
    await request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({ token, password: 'a-strong-passphrase-123' }).expect(200);
    await request(app.getHttpServer()).post('/api/v1/auth/email/verify').send({ token }).expect(200);
    expect(auth.consumeChallenge).toHaveBeenCalledWith(token, 'PASSWORD_RESET', 'a-strong-passphrase-123');
    expect(auth.consumeChallenge).toHaveBeenCalledWith(token, 'EMAIL_VERIFY');
    expect(auth.requestChallenge).not.toHaveBeenCalled();
  });
});
