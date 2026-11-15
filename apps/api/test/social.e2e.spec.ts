import 'reflect-metadata';
import { ForbiddenException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { configureApplication } from '../src/application';
import { APP_CONFIG, parseEnvironment } from '../src/config';
import { DatabaseService } from '../src/database.service';
import { RedisService } from '../src/redis.service';
import { SocialModule } from '../src/social/social.module';
import { SocialService } from '../src/social/social.service';

const actorId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const streamId = '33333333-3333-4333-8333-333333333333';
const reportId = '44444444-4444-4444-8444-444444444444';
const bearer = 'Bearer access.token.value';

describe('social HTTP account boundaries', () => {
  let app: INestApplication;
  const social = { status: vi.fn(), follow: vi.fn(), report: vi.fn() };
  const auth = { authenticate: vi.fn() };

  beforeEach(async () => {
    for (const method of Object.values(social)) method.mockReset();
    auth.authenticate.mockReset().mockResolvedValue({ userId: actorId, permissions: [] });
    social.status.mockResolvedValue({ following: false });
    social.follow.mockImplementation(async (_userId: string, _targetId: string, following: boolean) => ({ following }));
    social.report.mockResolvedValue({ id: reportId, status: 'OPEN' });
    const module = await Test.createTestingModule({ imports: [SocialModule] })
      .overrideProvider(APP_CONFIG).useValue(parseEnvironment({ DATABASE_URL: 'postgresql://test:test@localhost/test', REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'test' }))
      .overrideProvider(DatabaseService).useValue({})
      .overrideProvider(RedisService).useValue({})
      .overrideProvider(AuthService).useValue(auth)
      .overrideProvider(SocialService).useValue(social)
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApplication(app);
    await app.init();
  });
  afterEach(async () => { await app?.close(); });

  it('requires authentication for follow state, follow changes, and reports', async () => {
    await request(app.getHttpServer()).get(`/api/v1/social/${targetId}`).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/social/${targetId}/follow`).expect(401);
    await request(app.getHttpServer()).delete(`/api/v1/social/${targetId}/follow`).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/report`).send({ reason: 'Abusive content' }).expect(401);
    expect(social.status).not.toHaveBeenCalled();
    expect(social.follow).not.toHaveBeenCalled();
    expect(social.report).not.toHaveBeenCalled();
  });

  it('binds follow state and mutations to the authenticated actor', async () => {
    const state = await request(app.getHttpServer()).get(`/api/v1/social/${targetId}`).set('Authorization', bearer).expect(200);
    expect(state.body).toEqual({ following: false });
    expect(state.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).post(`/api/v1/social/${targetId}/follow`).set('Authorization', bearer).expect(200, { following: true });
    await request(app.getHttpServer()).delete(`/api/v1/social/${targetId}/follow`).set('Authorization', bearer).expect(200, { following: false });
    expect(social.status).toHaveBeenCalledWith(actorId, targetId);
    expect(social.follow.mock.calls).toEqual([[actorId, targetId, true], [actorId, targetId, false]]);
  });

  it('validates target UUIDs and trimmed report text before persisting', async () => {
    await request(app.getHttpServer()).get('/api/v1/social/invalid').set('Authorization', bearer).expect(400);
    for (const reason of ['', '   ', 'a'.repeat(501), 12, null]) {
      await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/report`).set('Authorization', bearer).send({ reason }).expect(400);
    }
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/report`).set('Authorization', bearer).send({ reason: 'Review this', reporterId: targetId }).expect(400);
    expect(social.report).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/report`).set('Authorization', bearer).send({ reason: '  Abusive content  ' }).expect(200, { id: reportId, status: 'OPEN' });
    expect(social.report).toHaveBeenCalledWith(actorId, streamId, 'Abusive content');
  });
});

function serviceFixture() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findMany: vi.fn().mockResolvedValue([{ id: actorId }, { id: targetId }]) },
    userBlock: { findFirst: vi.fn().mockResolvedValue(null) },
    follow: { findUnique: vi.fn().mockResolvedValue(null), createMany: vi.fn().mockResolvedValue({ count: 1 }), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    liveStream: { findUnique: vi.fn().mockResolvedValue({ id: streamId, creatorId: targetId }) },
    report: { create: vi.fn().mockResolvedValue({ id: reportId }) },
  };
  const database = { $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)) };
  return { service: new SocialService(database as unknown as DatabaseService), tx };
}

describe('persistent social authorization', () => {
  it('locks accounts before checking state and performs idempotent follow writes', async () => {
    const { service, tx } = serviceFixture();
    expect(await service.follow(actorId, targetId, true)).toEqual({ following: true });
    expect(await service.follow(actorId, targetId, true)).toEqual({ following: true });
    expect(tx.follow.createMany).toHaveBeenCalledTimes(2);
    expect(tx.follow.createMany).toHaveBeenCalledWith({
      data: [{ followerId: actorId, followedId: targetId }], skipDuplicates: true,
    });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.user.findMany.mock.invocationCallOrder[0]!);
    expect(await service.follow(actorId, targetId, false)).toEqual({ following: false });
    expect(tx.follow.deleteMany).toHaveBeenCalledWith({ where: { followerId: actorId, followedId: targetId } });
  });

  it('rejects self, unavailable accounts, and either-way blocks before a write', async () => {
    const self = serviceFixture();
    await expect(self.service.follow(actorId, actorId, true)).rejects.toBeInstanceOf(ForbiddenException);
    expect(self.tx.follow.createMany).not.toHaveBeenCalled();

    const inactive = serviceFixture();
    inactive.tx.user.findMany.mockResolvedValue([{ id: actorId }]);
    await expect(inactive.service.follow(actorId, targetId, true)).rejects.toBeInstanceOf(NotFoundException);
    expect(inactive.tx.follow.createMany).not.toHaveBeenCalled();

    const blocked = serviceFixture();
    blocked.tx.userBlock.findFirst.mockResolvedValue({ blockerId: targetId });
    await expect(blocked.service.report(actorId, streamId, 'Review')).rejects.toBeInstanceOf(ForbiddenException);
    expect(blocked.tx.userBlock.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ blockerId: actorId, blockedId: targetId }, { blockerId: targetId, blockedId: actorId }] }, select: { blockerId: true },
    });
    expect(blocked.tx.report.create).not.toHaveBeenCalled();
  });

  it('persists reports against the stream creator with an open receipt', async () => {
    const { service, tx } = serviceFixture();
    expect(await service.report(actorId, streamId, 'Abusive content')).toEqual({ id: reportId, status: 'OPEN' });
    expect(tx.report.create).toHaveBeenCalledWith({
      data: { reporterId: actorId, targetUserId: targetId, streamId, reasonCode: 'STREAM_REPORT', details: 'Abusive content' }, select: { id: true },
    });
    tx.liveStream.findUnique.mockResolvedValue(null);
    await expect(service.report(actorId, streamId, 'Review')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.report.create).toHaveBeenCalledTimes(1);
  });
});
