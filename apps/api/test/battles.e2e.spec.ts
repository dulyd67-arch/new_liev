import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/application';
import { AuthService } from '../src/auth/auth.service';
import { BattlesService } from '../src/battles/battles.service';
import { APP_CONFIG, parseEnvironment } from '../src/config';
import { DatabaseService } from '../src/database.service';
import { RedisService } from '../src/redis.service';

const actorId = '11111111-1111-4111-8111-111111111111';
const streamId = '22222222-2222-4222-8222-222222222222';
const opponentStreamId = '33333333-3333-4333-8333-333333333333';
const battleId = '44444444-4444-4444-8444-444444444444';
const idempotencyKey = '55555555-5555-4555-8555-555555555555';
const bearer = 'Bearer access.token.value';
const serverNow = '2026-11-16T10:00:00.000Z';

describe('PK and live likes HTTP authentication, validation and documentation', () => {
  let app: INestApplication;
  const battles = { snapshot: vi.fn(), invite: vi.fn(), invitations: vi.fn(), candidates: vi.fn(), respond: vi.fn(), likes: vi.fn(), sendLikes: vi.fn() };
  const auth = { authenticate: vi.fn() };
  beforeEach(async () => {
    for (const method of Object.values(battles)) method.mockReset();
    auth.authenticate.mockReset().mockResolvedValue({ userId: actorId, permissions: [] });
    battles.snapshot.mockResolvedValue({ battle: null, serverNow });
    battles.invite.mockResolvedValue({ battle: { id: battleId }, serverNow });
    battles.invitations.mockResolvedValue({ items: [], serverNow });
    battles.candidates.mockResolvedValue({ items: [] });
    battles.respond.mockResolvedValue({ battle: { id: battleId }, serverNow });
    battles.likes.mockResolvedValue({ total: '9007199254740993', serverNow });
    battles.sendLikes.mockResolvedValue({ total: '9007199254741013', acceptedCount: 20, serverNow });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(parseEnvironment({ DATABASE_URL: 'postgresql://test:test@localhost/test', REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'test' }))
      .overrideProvider(DatabaseService).useValue({})
      .overrideProvider(RedisService).useValue({})
      .overrideProvider(AuthService).useValue(auth)
      .overrideProvider(BattlesService).useValue(battles)
      .compile();
    app = module.createNestApplication({ logger: false }); configureApplication(app); await app.init();
  });
  afterEach(async () => { await app?.close(); });

  it('allows public battle and real like totals but never anonymous mutations or private invitations', async () => {
    await request(app.getHttpServer()).get(`/api/v1/streams/${streamId}/battle`).expect(200, { battle: null, serverNow });
    await request(app.getHttpServer()).get(`/api/v1/streams/${streamId}/likes`).expect(200, { total: '9007199254740993', serverNow });
    await request(app.getHttpServer()).get('/api/v1/battles/invitations').expect(401);
    await request(app.getHttpServer()).get('/api/v1/battles/candidates').expect(401);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/battles`).send({ opponentStreamId, idempotencyKey }).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/likes`).send({ count: 20, idempotencyKey }).expect(401);
    for (const action of ['accept', 'decline', 'cancel', 'leave']) {
      await request(app.getHttpServer()).post(`/api/v1/battles/${battleId}/${action}`).send({}).expect(401);
    }
    expect(battles.invite).not.toHaveBeenCalled(); expect(battles.respond).not.toHaveBeenCalled(); expect(battles.sendLikes).not.toHaveBeenCalled();
  });

  it('binds every operation to the authenticated actor and returns mutations with status200', async () => {
    await request(app.getHttpServer()).get('/api/v1/battles/invitations').set('Authorization', bearer).expect(200);
    await request(app.getHttpServer()).get('/api/v1/battles/candidates').set('Authorization', bearer).expect(200);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/battles`).set('Authorization', bearer).send({ opponentStreamId, idempotencyKey }).expect(200);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/likes`).set('Authorization', bearer).send({ count: 20, idempotencyKey }).expect(200);
    for (const action of ['accept', 'decline', 'cancel', 'leave']) {
      await request(app.getHttpServer()).post(`/api/v1/battles/${battleId}/${action}`).set('Authorization', bearer).send({}).expect(200);
      expect(battles.respond).toHaveBeenCalledWith(actorId, battleId, action.toUpperCase());
    }
    expect(battles.invite).toHaveBeenCalledWith(actorId, streamId, { opponentStreamId, idempotencyKey });
    expect(battles.sendLikes).toHaveBeenCalledWith(actorId, streamId, { count: 20, idempotencyKey });
    expect(battles.invitations).toHaveBeenCalledWith(actorId); expect(battles.candidates).toHaveBeenCalledWith(actorId);
  });

  it('rejects injected actor, score, duration, winner and timestamps before changing a battle', async () => {
    for (const extra of [{ userId: opponentStreamId }, { hostScore: '999' }, { durationSeconds: 1 }, { winnerStreamId: streamId }, { startsAt: serverNow }]) {
      await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/battles`).set('Authorization', bearer).send({ opponentStreamId, idempotencyKey, ...extra }).expect(400);
    }
    await request(app.getHttpServer()).post(`/api/v1/battles/${battleId}/accept`).set('Authorization', bearer).send({ userId: opponentStreamId }).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/likes`).set('Authorization', bearer).send({ count: 1, idempotencyKey, total: '999' }).expect(400);
    expect(battles.invite).not.toHaveBeenCalled(); expect(battles.respond).not.toHaveBeenCalled(); expect(battles.sendLikes).not.toHaveBeenCalled();
  });

  it('requires strict UUIDs and integer like batches between1and20', async () => {
    for (const count of [0, -1, 21, 1.1, '1', null]) {
      await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/likes`).set('Authorization', bearer).send({ count, idempotencyKey }).expect(400);
    }
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/likes`).set('Authorization', bearer).send({ count: 1, idempotencyKey: 'bad' }).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/battles`).set('Authorization', bearer).send({ opponentStreamId: 'bad', idempotencyKey }).expect(400);
    await request(app.getHttpServer()).get('/api/v1/streams/bad/battle').expect(400);
    await request(app.getHttpServer()).post('/api/v1/battles/bad/leave').set('Authorization', bearer).send({}).expect(400);
    expect(battles.invite).not.toHaveBeenCalled(); expect(battles.sendLikes).not.toHaveBeenCalled(); expect(battles.respond).not.toHaveBeenCalled();
  });

  it('documents public views, protected actions, exact scores and bounded like batches', async () => {
    const response = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
    const paths = response.body.paths;
    expect(Object.keys(paths)).toEqual(expect.arrayContaining([
      '/api/v1/battles/invitations', '/api/v1/battles/candidates', '/api/v1/battles/{id}/accept', '/api/v1/battles/{id}/leave',
      '/api/v1/streams/{id}/battle', '/api/v1/streams/{id}/battles', '/api/v1/streams/{id}/likes',
    ]));
    expect(paths['/api/v1/streams/{id}/likes'].get.security).toBeUndefined();
    expect(paths['/api/v1/streams/{id}/likes'].post.security).toEqual([{ bearer: [] }]);
    expect(response.body.components.schemas.BattleViewDto.properties.hostScore.type).toBe('string');
    expect(response.body.components.schemas.BattleViewDto.properties.guestScore.type).toBe('string');
    expect(response.body.components.schemas.LikeTotalDto.properties.total.type).toBe('string');
    expect(response.body.components.schemas.SendLikesDto.properties.count).toMatchObject({ type: 'number', minimum: 1, maximum: 20 });
    expect(response.body.components.schemas.InviteBattleDto.properties.idempotencyKey.format).toBe('uuid');
  });
});
