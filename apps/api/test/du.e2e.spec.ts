import 'reflect-metadata';
import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/application';
import { AuthService } from '../src/auth/auth.service';
import { APP_CONFIG, parseEnvironment } from '../src/config';
import { DatabaseService } from '../src/database.service';
import { DuService } from '../src/du/du.service';
import { RedisService } from '../src/redis.service';

const actorId = '11111111-1111-4111-8111-111111111111';
const streamId = '22222222-2222-4222-8222-222222222222';
const giftId = '33333333-3333-4333-8333-333333333333';
const idempotencyKey = '44444444-4444-4444-8444-444444444444';
const bearer = 'Bearer access.token.value';
const wallet = { currency: 'DU', balance: '9007199254740993', claimAvailable: true, receivedCoins: '0', receivedGifts: '0', promotional: true, purchasingEnabled: false };

describe('DU HTTP authentication, input and documentation boundaries', () => {
  let app: INestApplication;
  const du = { wallet: vi.fn(), history: vi.fn(), claim: vi.fn(), catalog: vi.fn(), send: vi.fn(), feed: vi.fn() };
  const auth = { authenticate: vi.fn() };

  beforeEach(async () => {
    for (const method of Object.values(du)) method.mockReset();
    auth.authenticate.mockReset().mockResolvedValue({ userId: actorId, permissions: [] });
    du.wallet.mockResolvedValue(wallet);
    du.catalog.mockResolvedValue({ currency: 'DU', promotional: true, items: [] });
    du.history.mockResolvedValue({ items: [], nextCursor: null });
    du.feed.mockResolvedValue({ items: [], nextCursor: '9007199254740993', totalCoins: '0', totalGifts: '0' });
    du.claim.mockResolvedValue({ transaction: {}, wallet });
    du.send.mockResolvedValue({ transaction: {}, wallet });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(parseEnvironment({ DATABASE_URL: 'postgresql://test:test@localhost/test', REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'test' }))
      .overrideProvider(DatabaseService).useValue({})
      .overrideProvider(RedisService).useValue({})
      .overrideProvider(AuthService).useValue(auth)
      .overrideProvider(DuService).useValue(du)
      .compile();
    app = module.createNestApplication({ logger: false }); configureApplication(app); await app.init();
  });
  afterEach(async () => { await app?.close(); });

  it('requires authentication for every wallet operation and gift spend', async () => {
    await request(app.getHttpServer()).get('/api/v1/wallet').expect(401);
    await request(app.getHttpServer()).get('/api/v1/wallet/history').expect(401);
    await request(app.getHttpServer()).post('/api/v1/wallet/claim').send({ idempotencyKey }).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/gifts`).send({ giftId, quantity: 1, idempotencyKey }).expect(401);
    expect(du.wallet).not.toHaveBeenCalled(); expect(du.claim).not.toHaveBeenCalled(); expect(du.send).not.toHaveBeenCalled();
  });

  it('binds balances, history and mutations to the authenticated actor only', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/wallet').set('Authorization', bearer).expect(200);
    expect(response.body).toEqual(wallet); expect(response.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).get('/api/v1/wallet/history?cursor=9007199254740993').set('Authorization', bearer).expect(200);
    await request(app.getHttpServer()).post('/api/v1/wallet/claim').set('Authorization', bearer).send({ idempotencyKey }).expect(200);
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/gifts`).set('Authorization', bearer).send({ giftId, quantity: 99, idempotencyKey }).expect(200);
    expect(du.wallet).toHaveBeenCalledWith(actorId);
    expect(du.history).toHaveBeenCalledWith(actorId, '9007199254740993');
    expect(du.claim).toHaveBeenCalledWith(actorId, idempotencyKey);
    expect(du.send).toHaveBeenCalledWith(actorId, streamId, { giftId, quantity: 99, idempotencyKey });
  });

  it('rejects sender, price, amount and privilege injection before any mutation', async () => {
    for (const extra of [{ senderId: giftId }, { userId: giftId }, { price: '0' }, { amount: '1000' }, { purchasingEnabled: true }]) {
      await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/gifts`).set('Authorization', bearer).send({ giftId, quantity: 1, idempotencyKey, ...extra }).expect(400);
    }
    await request(app.getHttpServer()).post('/api/v1/wallet/claim').set('Authorization', bearer).send({ idempotencyKey, amount: 999 }).expect(400);
    expect(du.send).not.toHaveBeenCalled(); expect(du.claim).not.toHaveBeenCalled();
  });

  it('requires UUID request keys and an integer quantity between 1 and 99', async () => {
    for (const quantity of [0, -1, 100, 1.1, '1', null]) {
      await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/gifts`).set('Authorization', bearer).send({ giftId, quantity, idempotencyKey }).expect(400);
    }
    await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/gifts`).set('Authorization', bearer).send({ giftId, quantity: 1, idempotencyKey: 'not-a-uuid' }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/wallet/claim').set('Authorization', bearer).send({}).expect(400);
    expect(du.send).not.toHaveBeenCalled(); expect(du.claim).not.toHaveBeenCalled();
  });

  it('validates exact BIGINT sequence cursors without coercing them into numbers', async () => {
    for (const after of ['-1', '1.5', '01', '1e3', '9223372036854775808', '0;SELECT 1']) {
      await request(app.getHttpServer()).get(`/api/v1/streams/${streamId}/gifts`).query({ after }).expect(400);
    }
    await request(app.getHttpServer()).get('/api/v1/wallet/history?cursor=9223372036854775808').set('Authorization', bearer).expect(400);
    expect(du.feed).not.toHaveBeenCalled(); expect(du.history).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get(`/api/v1/streams/${streamId}/gifts?after=9223372036854775807`).expect(200);
    expect(du.feed).toHaveBeenCalledWith(streamId, '9223372036854775807');
  });

  it('allows a public catalog and initializes public event polling without replay', async () => {
    await request(app.getHttpServer()).get('/api/v1/gifts').expect(200, { currency: 'DU', promotional: true, items: [] });
    await request(app.getHttpServer()).get(`/api/v1/streams/${streamId}/gifts`).expect(200, { items: [], nextCursor: '9007199254740993', totalCoins: '0', totalGifts: '0' });
    expect(du.feed).toHaveBeenCalledWith(streamId, undefined);
    await request(app.getHttpServer()).get('/api/v1/streams/invalid/gifts').expect(400);
  });

  it('returns actionable domain conflict errors without exposing SQL', async () => {
    du.send.mockRejectedValueOnce(new ConflictException({ code: 'DU_INSUFFICIENT_BALANCE', message: 'You do not have enough promotional DU for this gift.' }));
    const response = await request(app.getHttpServer()).post(`/api/v1/streams/${streamId}/gifts`).set('Authorization', bearer).send({ giftId, quantity: 1, idempotencyKey }).expect(409);
    expect(response.body.code).toBe('DU_INSUFFICIENT_BALANCE');
    expect(JSON.stringify(response.body)).not.toMatch(/SELECT|du_send_gift|postgres/i);
  });

  it('documents promotional gift routes without exposing a payment or cashout route', async () => {
    const response = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
    expect(Object.keys(response.body.paths)).toEqual(expect.arrayContaining([
      '/api/v1/wallet', '/api/v1/wallet/history', '/api/v1/wallet/claim', '/api/v1/gifts', '/api/v1/streams/{id}/gifts',
    ]));
    expect(response.body.components.schemas.DuWalletDto.properties.balance.type).toBe('string');
    expect(response.body.components.schemas.DuTransactionDto.properties.sequence.type).toBe('string');
    expect(response.body.paths['/api/v1/wallet/claim'].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/ClaimDuDto');
    expect(response.body.paths['/api/v1/streams/{id}/gifts'].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/SendDuGiftDto');
    expect(response.body.components.schemas.SendDuGiftDto.properties.quantity).toMatchObject({ type: 'number', minimum: 1, maximum: 99 });
    expect(Object.keys(response.body.paths).some(path => /payments|cashouts|payouts/.test(path))).toBe(false);
  });
});
