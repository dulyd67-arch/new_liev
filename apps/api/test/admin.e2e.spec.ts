import 'reflect-metadata';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from '../src/admin/admin.controller';
import { AdminGuard } from '../src/admin/admin.guard';
import { AdminService } from '../src/admin/admin.service';
import { configureApplication } from '../src/application';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { APP_CONFIG, parseEnvironment } from '../src/config';

const actorId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const idempotencyKey = '33333333-3333-4333-8333-333333333333';
const bearer = 'Bearer access.token.value';
const reason = { reason: 'Review confirmed', idempotencyKey };
const readRoutes = ['overview', 'users', 'streams', 'reports', 'audit'] as const;
const pageRoutes = ['users', 'streams', 'reports', 'audit'] as const;
const mutationRoutes = [
  { name: 'suspend', method: 'post', path: 'users', suffix: '/suspend' },
  { name: 'restore', method: 'post', path: 'users', suffix: '/restore' },
  { name: 'terminate', method: 'post', path: 'streams', suffix: '/terminate' },
  { name: 'review', method: 'patch', path: 'reports', suffix: '' },
] as const;
type MutationRoute = typeof mutationRoutes[number];

function mutationBody(route: MutationRoute, overrides: Record<string, unknown> = {}) {
  return { ...reason, ...(route.name === 'review' ? { status: 'RESOLVED' } : {}), ...overrides };
}

describe('administration HTTP authorization and validation', () => {
  let app: INestApplication;
  const admin = {
    overview: vi.fn(), users: vi.fn(), streams: vi.fn(), reports: vi.fn(), audit: vi.fn(),
    setUserStatus: vi.fn(), terminateStream: vi.fn(), reviewReport: vi.fn(),
  };
  const auth = { authenticate: vi.fn() };
  const actor = (roles: string[]) => ({ userId: actorId, sessionId: 'session-id', familyId: 'family-id', permissions: [], roles });
  const mutate = (route: MutationRoute, id: string = targetId) =>
    request(app.getHttpServer())[route.method](`/api/v1/admin/${route.path}/${id}${route.suffix}`);
  const expectNoServiceCall = () => {
    for (const method of Object.values(admin)) expect(method).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    for (const method of Object.values(admin)) method.mockReset().mockResolvedValue({ ok: true });
    auth.authenticate.mockReset().mockResolvedValue(actor(['ADMIN']));
    const module = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        AuthGuard, AdminGuard,
        { provide: AuthService, useValue: auth },
        { provide: AdminService, useValue: admin },
        { provide: APP_CONFIG, useValue: parseEnvironment({ DATABASE_URL: 'postgresql://test:test@localhost/test', REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'test' }) },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    configureApplication(app);
    await app.init();
  });

  afterEach(async () => { await app?.close(); });

  it('requires authentication on every administration route before invoking the service', async () => {
    for (const route of readRoutes) await request(app.getHttpServer()).get(`/api/v1/admin/${route}`).expect(401);
    for (const route of mutationRoutes) await mutate(route).send(mutationBody(route)).expect(401);
    expect(auth.authenticate).not.toHaveBeenCalled();
    expectNoServiceCall();
  });

  it('rejects malformed authorization headers before authentication', async () => {
    for (const header of ['Basic credentials', 'Bearer invalid+token', 'Bearer a/b', 'Bearer two tokens']) {
      await request(app.getHttpServer()).get('/api/v1/admin/overview').set('Authorization', header).expect(401);
    }
    expect(auth.authenticate).not.toHaveBeenCalled();
    expectNoServiceCall();
  });

  it('rejects an invalid, expired or revoked bearer token through AuthService', async () => {
    auth.authenticate.mockRejectedValue(new UnauthorizedException('Session is no longer active.'));
    await request(app.getHttpServer()).get('/api/v1/admin/overview').set('Authorization', bearer).expect(401);
    expect(auth.authenticate).toHaveBeenCalledWith('access.token.value');
    expectNoServiceCall();
  });

  it.each(['USER', 'MODERATOR'])('denies the %s role on every route, regardless of client role claims', async role => {
    auth.authenticate.mockResolvedValue(actor([role]));
    for (const route of readRoutes) {
      const response = await request(app.getHttpServer()).get(`/api/v1/admin/${route}`)
        .set('Authorization', bearer).set('X-Role', 'SUPER_ADMIN').expect(403);
      expect(response.body.code).toBe('ADMIN_FORBIDDEN');
    }
    for (const route of mutationRoutes) {
      await mutate(route).set('Authorization', bearer)
        .send(mutationBody(route, { actorId: targetId, roles: ['SUPER_ADMIN'] })).expect(403);
    }
    expectNoServiceCall();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('allows the %s role to read each administration resource without caching', async role => {
    auth.authenticate.mockResolvedValue(actor([role]));
    for (const route of readRoutes) {
      const response = await request(app.getHttpServer()).get(`/api/v1/admin/${route}`).set('Authorization', bearer).expect(200, { ok: true });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(admin[route]).toHaveBeenCalledTimes(1);
    }
  });

  it('reauthenticates the same token so a removed role or revoked session takes effect immediately', async () => {
    auth.authenticate
      .mockResolvedValueOnce(actor(['ADMIN']))
      .mockResolvedValueOnce(actor(['USER']))
      .mockRejectedValueOnce(new UnauthorizedException('Session revoked.'));
    await request(app.getHttpServer()).get('/api/v1/admin/overview').set('Authorization', bearer).expect(200);
    await request(app.getHttpServer()).get('/api/v1/admin/overview').set('Authorization', bearer).expect(403);
    await request(app.getHttpServer()).get('/api/v1/admin/overview').set('Authorization', bearer).expect(401);
    expect(auth.authenticate).toHaveBeenCalledTimes(3);
    expect(admin.overview).toHaveBeenCalledTimes(1);
  });

  it('binds all mutations to the authenticated actor and passes a trimmed reason and key', async () => {
    for (const route of mutationRoutes) {
      const response = await mutate(route).set('Authorization', bearer)
        .set('X-Actor-Id', targetId).send(mutationBody(route, { reason: '  Review confirmed  ' })).expect(200, { ok: true });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(admin.setUserStatus.mock.calls).toEqual([
      [actorId, targetId, 'SUSPENDED', reason],
      [actorId, targetId, 'ACTIVE', reason],
    ]);
    expect(admin.terminateStream).toHaveBeenCalledExactlyOnceWith(actorId, targetId, reason);
    expect(admin.reviewReport).toHaveBeenCalledExactlyOnceWith(actorId, targetId, { ...reason, status: 'RESOLVED' });
  });

  it.each(mutationRoutes)('rejects forged actor, role and extra fields on $name', async route => {
    for (const injected of [{ actorId: targetId }, { userId: targetId }, { actor: { userId: targetId } }, { roles: ['SUPER_ADMIN'] }, { role: 'ADMIN' }]) {
      await mutate(route).set('Authorization', bearer).send(mutationBody(route, injected)).expect(400);
    }
    expectNoServiceCall();
  });

  it.each(mutationRoutes)('validates the target UUID before $name', async route => {
    await mutate(route, 'not-a-uuid').set('Authorization', bearer).send(mutationBody(route)).expect(400);
    expectNoServiceCall();
  });

  it.each(mutationRoutes)('requires a meaningful bounded reason for $name', async route => {
    for (const invalidReason of ['', '   ', 'ab', '  ab  ', 'a'.repeat(1001), 12, null]) {
      await mutate(route).set('Authorization', bearer).send(mutationBody(route, { reason: invalidReason })).expect(400);
    }
    const missingReason = mutationBody(route);
    delete (missingReason as Partial<typeof missingReason>).reason;
    await mutate(route).set('Authorization', bearer).send(missingReason).expect(400);
    expectNoServiceCall();
  });

  it.each(mutationRoutes)('requires a UUID idempotency key for $name', async route => {
    for (const invalidKey of ['', 'not-a-uuid', 123, null]) {
      await mutate(route).set('Authorization', bearer).send(mutationBody(route, { idempotencyKey: invalidKey })).expect(400);
    }
    const missingKey = mutationBody(route);
    delete (missingKey as Partial<typeof missingKey>).idempotencyKey;
    await mutate(route).set('Authorization', bearer).send(missingKey).expect(400);
    expectNoServiceCall();
  });

  it('only accepts the report decision states and requires an explicit decision', async () => {
    for (const status of ['OPEN', 'TERMINATED', 'resolved', '', null, 1]) {
      await request(app.getHttpServer()).patch(`/api/v1/admin/reports/${targetId}`)
        .set('Authorization', bearer).send({ ...reason, status }).expect(400);
    }
    await request(app.getHttpServer()).patch(`/api/v1/admin/reports/${targetId}`).set('Authorization', bearer).send(reason).expect(400);
    expectNoServiceCall();
    for (const status of ['REVIEWING', 'RESOLVED', 'DISMISSED']) {
      await request(app.getHttpServer()).patch(`/api/v1/admin/reports/${targetId}`)
        .set('Authorization', bearer).send({ ...reason, status }).expect(200);
      expect(admin.reviewReport).toHaveBeenLastCalledWith(actorId, targetId, { ...reason, status });
    }
    expect(admin.terminateStream).not.toHaveBeenCalled();
  });

  it.each(pageRoutes)('validates pagination and rejects unknown query fields for %s', async route => {
    for (const query of [{ limit: '0' }, { limit: '21' }, { limit: '1.5' }, { limit: '-1' }, { limit: 'NaN' }, { limit: '1e1' }, { cursor: 'not-a-uuid' }, { role: 'SUPER_ADMIN' }]) {
      await request(app.getHttpServer()).get(`/api/v1/admin/${route}`).set('Authorization', bearer).query(query).expect(400);
    }
    expectNoServiceCall();
    await request(app.getHttpServer()).get(`/api/v1/admin/${route}`).set('Authorization', bearer)
      .query({ limit: '20', cursor: targetId }).expect(200);
    expect(admin[route]).toHaveBeenCalledExactlyOnceWith({ limit: 20, cursor: targetId });
  });

  it('validates user search and account status, trimming the search before forwarding it', async () => {
    for (const query of [{ status: 'ADMIN' }, { status: 'active' }, { query: 'x'.repeat(81) }, { query: ['first', 'second'] }]) {
      await request(app.getHttpServer()).get('/api/v1/admin/users').set('Authorization', bearer).query(query).expect(400);
    }
    expectNoServiceCall();
    await request(app.getHttpServer()).get('/api/v1/admin/users').set('Authorization', bearer)
      .query({ query: '  creator  ', status: 'SUSPENDED', limit: '1' }).expect(200);
    expect(admin.users).toHaveBeenCalledExactlyOnceWith({ query: 'creator', status: 'SUSPENDED', limit: 1 });
  });

  it.each([
    { route: 'streams', valid: ['LIVE', 'SCHEDULED', 'TERMINATED', 'ENDED'], invalid: 'PUBLISHING' },
    { route: 'reports', valid: ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'], invalid: 'TERMINATED' },
  ] as const)('validates the status filter for $route', async ({ route, valid, invalid }) => {
    await request(app.getHttpServer()).get(`/api/v1/admin/${route}`).set('Authorization', bearer).query({ status: invalid }).expect(400);
    expectNoServiceCall();
    for (const status of valid) {
      await request(app.getHttpServer()).get(`/api/v1/admin/${route}`).set('Authorization', bearer).query({ status }).expect(200);
      expect(admin[route]).toHaveBeenLastCalledWith({ status });
    }
  });
});
