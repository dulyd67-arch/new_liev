import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/application';
import { APP_CONFIG, parseEnvironment } from '../src/config';
import { DatabaseService } from '../src/database.service';
import { RedisService } from '../src/redis.service';
import { DEPENDENCY_PROBE, DependencyStatus } from '../src/health/health.service';

describe('HTTP foundation and API documentation', () => {
  let app: INestApplication;
  const check = vi.fn<() => Promise<DependencyStatus>>();

  beforeEach(async () => {
    check.mockResolvedValue({ postgres: 'up', redis: 'up' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(parseEnvironment({
        DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
        REDIS_URL: 'redis://localhost:6379/0',
        NODE_ENV: 'test',
      }))
      .overrideProvider(DatabaseService).useValue({ probe: vi.fn() })
      .overrideProvider(RedisService).useValue({ probe: vi.fn() })
      .overrideProvider(DEPENDENCY_PROBE).useValue({ check })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApplication(app);
    await app.init();
  });

  afterEach(async () => { await app?.close(); });

  it('serves liveness with security headers independently of dependencies', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    expect(response.body).toEqual({ status: 'ok', service: 'livestar-api' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('returns 503 for a failed dependency with no credentials or internal errors', async () => {
    check.mockResolvedValue({ postgres: 'down', redis: 'up' });
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
    expect(response.body).toEqual({ status: 'not_ready', dependencies: { postgres: 'down', redis: 'up' } });
    expect(JSON.stringify(response.body)).not.toContain('postgresql:');
  });

  it('returns readiness only when both dependencies respond', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(response.body).toEqual({ status: 'ready', dependencies: { postgres: 'up', redis: 'up' } });
  });

  it('advertises the simple live-only product and exposes no payment routes', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/platform').expect(200);
    expect(response.body).toMatchObject({ mode: 'live-only', streamingEnabled: expect.any(Boolean) });
    expect(response.body.purchasesEnabled).toBeUndefined();
    expect(response.body.payoutsEnabled).toBeUndefined();
    await request(app.getHttpServer()).post('/api/v1/payments').send({ amount: 1 }).expect(404);
  });

  it('exposes OpenAPI descriptions for implemented endpoints only', async () => {
    const response = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
    expect(Object.keys(response.body.paths)).toEqual(expect.arrayContaining([
      '/api/v1/health/live', '/api/v1/health/ready', '/api/v1/platform', '/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/users/me',
    ]));
    expect(Object.keys(response.body.paths).some(path => /payments|payouts/.test(path))).toBe(false);
    await request(app.getHttpServer()).get('/api/docs').expect(200);
  });

  it('allows only the configured browser origin', async () => {
    const allowed = await request(app.getHttpServer()).get('/api/v1/platform').set('Origin', 'http://localhost:3000').expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const other = await request(app.getHttpServer()).get('/api/v1/platform').set('Origin', 'https://untrusted.example').expect(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
