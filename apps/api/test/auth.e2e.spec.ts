import 'reflect-metadata';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/application';
import { APP_CONFIG, parseEnvironment } from '../src/config';
import { DatabaseService } from '../src/database.service';
import { RedisService } from '../src/redis.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';

const origin = 'http://localhost:3000';
const token = 'r'.repeat(43);
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'member@example.com', username: 'member', displayName: 'Member', locale: 'en', emailVerified: false };
const actor = { userId: user.id, sessionId: '22222222-2222-4222-8222-222222222222', familyId: '33333333-3333-4333-8333-333333333333', roles: ['USER'], permissions: ['profile:own'] };
const login = { email: user.email, password: 'test-passphrase-123' };
const registration = { ...login, username: 'member', displayName: 'Member', birthDate: '1995-06-15', locale: 'en', termsVersion: '2026-11-07', privacyVersion: '2026-11-07', acceptTerms: true, acceptPrivacy: true };

describe('authentication transport and input boundaries', () => {
  let app: INestApplication;
  const result = { accessToken: 'access.token.value', expiresIn: 900, refreshToken: token, user };
  const auth = {
    register: vi.fn(), login: vi.fn(), refresh: vi.fn(), authenticate: vi.fn(),
    logout: vi.fn(), requestChallenge: vi.fn(), consumeChallenge: vi.fn(), deleteAccount: vi.fn(),
  };
  const users = { me: vi.fn(), updateProfile: vi.fn(), exportIdentity: vi.fn(), search: vi.fn(), publicProfile: vi.fn() };

  beforeEach(async () => {
    for (const method of Object.values(auth)) method.mockReset();
    for (const method of Object.values(users)) method.mockReset();
    auth.register.mockResolvedValue({ ...result, emailDelivery: 'sent' });
    auth.login.mockResolvedValue(result); auth.refresh.mockResolvedValue(result);
    auth.authenticate.mockResolvedValue(actor); users.me.mockResolvedValue(user);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(parseEnvironment({ DATABASE_URL: 'postgresql://test:test@localhost/test', REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'test' }))
      .overrideProvider(DatabaseService).useValue({})
      .overrideProvider(RedisService).useValue({})
      .overrideProvider(AuthService).useValue(auth)
      .overrideProvider(UsersService).useValue(users)
      .compile();
    app = module.createNestApplication({ logger: false }); configureApplication(app); await app.init();
  });
  afterEach(async () => { await app?.close(); });

  it('requires an exact Origin for web login and registration before issuing sessions', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(login).expect(403);
    await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'https://untrusted.example').send(login).expect(403);
    await request(app.getHttpServer()).post('/api/v1/auth/register').send(registration).expect(403);
    expect(auth.login).not.toHaveBeenCalled(); expect(auth.register).not.toHaveBeenCalled();
  });

  it('returns web access tokens while keeping refresh tokens in HttpOnly Strict cookies', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send(login).expect(200);
    expect(response.body.refreshToken).toBeUndefined();
    expect(response.body.accessToken).toBe(result.accessToken);
    expect(response.headers['cache-control']).toBe('no-store');
    const cookie = response.headers['set-cookie']![0]!;
    expect(cookie).toContain(`livestar_refresh=${token}`); expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Path=/api/v1/auth');
    expect(auth.login).toHaveBeenCalledWith(login.email, login.password, 'WEB');
  });

  it('uses explicit mobile transport without ambient refresh cookies', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/mobile/login').send(login).expect(200);
    expect(response.body.refreshToken).toBe(token); expect(response.headers['set-cookie']).toBeUndefined();
    expect(auth.login).toHaveBeenCalledWith(login.email, login.password, 'MOBILE');
    await request(app.getHttpServer()).post('/api/v1/auth/mobile/refresh').send({ refreshToken: token }).expect(200);
    expect(auth.refresh).toHaveBeenCalledWith(token, 'MOBILE');
  });

  it('requires both trusted Origin and one valid cookie for web refresh', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', `livestar_refresh=${token}`).expect(403);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', origin).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', origin).set('Cookie', `livestar_refresh=${token}; livestar_refresh=${token}`).expect(401);
    expect(auth.refresh).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', origin).set('Cookie', `livestar_refresh=${token}`).expect(200);
    expect(auth.refresh).toHaveBeenCalledWith(token, 'WEB');
  });

  it('rejects privilege injection, missing consent, malformed tokens and short passwords', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/register').set('Origin', origin).send({ ...registration, roles: ['SUPER_ADMIN'] }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/register').set('Origin', origin).send({ ...registration, acceptTerms: false }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ ...login, password: 'short' }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/mobile/refresh').send({ refreshToken: 'invalid' }).expect(400);
    expect(auth.register).not.toHaveBeenCalled(); expect(auth.login).not.toHaveBeenCalled(); expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('binds private profile operations to the authenticated actor and rejects privilege edits', async () => {
    await request(app.getHttpServer()).get('/api/v1/users/me').expect(401);
    await request(app.getHttpServer()).get('/api/v1/users/me').set('Authorization', 'Bearer access.token.value').expect(200);
    expect(users.me).toHaveBeenCalledWith(actor.userId);
    await request(app.getHttpServer()).patch('/api/v1/users/me').set('Authorization', 'Bearer access.token.value').send({ displayName: 'Changed', userId: 'other-user', roles: ['ADMIN'] }).expect(400);
    expect(users.updateProfile).not.toHaveBeenCalled();
  });

  it('clears rejected refresh cookies and reports generic recovery outcomes', async () => {
    auth.refresh.mockRejectedValue(new UnauthorizedException('Invalid refresh token.'));
    const rejected = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', origin).set('Cookie', `livestar_refresh=${token}`).expect(401);
    expect(rejected.headers['set-cookie']![0]!).toContain('livestar_refresh=;');
    const recovery = await request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    expect(recovery.body).toEqual({ message: 'If an eligible account exists, an email will be sent.' });
    expect(JSON.stringify(recovery.body)).not.toContain(token);
  });
});
