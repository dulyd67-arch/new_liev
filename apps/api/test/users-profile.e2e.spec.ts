import 'reflect-metadata';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { configureApplication } from '../src/application';
import { APP_CONFIG, parseEnvironment } from '../src/config';
import { DatabaseService } from '../src/database.service';
import { RedisService } from '../src/redis.service';
import { UsersModule } from '../src/users/users.module';
import { UsersService } from '../src/users/users.service';
import { parseProfileAvatar } from '../src/users/avatar';

const actorId = '11111111-1111-4111-8111-111111111111';
const cursor = '22222222-2222-4222-8222-222222222222';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC2cAAAAASUVORK5CYII=';

describe('public profile HTTP pagination and avatar boundaries', () => {
  let app: INestApplication;
  const users = { publicProfile: vi.fn(), connections: vi.fn(), broadcasts: vi.fn(), avatar: vi.fn(), updateProfile: vi.fn(), me: vi.fn() };
  const auth = { authenticate: vi.fn() };
  beforeEach(async () => {
    for (const method of Object.values(users)) method.mockReset();
    auth.authenticate.mockReset().mockResolvedValue({ userId: actorId, permissions: [] });
    users.connections.mockResolvedValue({ items: [], nextCursor: null });
    users.broadcasts.mockResolvedValue({ items: [], nextCursor: null });
    users.avatar.mockResolvedValue(parseProfileAvatar(png));
    users.updateProfile.mockResolvedValue({ id: actorId });
    users.publicProfile.mockResolvedValue({ username: 'star' });
    users.me.mockResolvedValue({ id: actorId });
    const module = await Test.createTestingModule({ imports: [UsersModule] })
      .overrideProvider(APP_CONFIG).useValue(parseEnvironment({ DATABASE_URL: 'postgresql://test:test@localhost/test', REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'test' }))
      .overrideProvider(DatabaseService).useValue({})
      .overrideProvider(RedisService).useValue({})
      .overrideProvider(AuthService).useValue(auth)
      .overrideProvider(UsersService).useValue(users)
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApplication(app);
    await app.init();
  });
  afterEach(async () => { await app?.close(); });

  it('routes public list endpoints with validated pagination rather than the username projection', async () => {
    for (const direction of ['followers', 'following']) {
      const result = await request(app.getHttpServer()).get(`/api/v1/users/star/${direction}?cursor=${cursor}&limit=2`).expect(200);
      expect(result.body).toEqual({ items: [], nextCursor: null });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(users.connections).toHaveBeenLastCalledWith('star', direction, cursor, 2);
    }
    await request(app.getHttpServer()).get(`/api/v1/users/star/streams?cursor=${cursor}&limit=2`).expect(200);
    expect(users.broadcasts).toHaveBeenCalledWith('star', cursor, 2);
    expect(users.publicProfile).not.toHaveBeenCalled();
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it('rejects invalid cursors, bounds, and unknown query fields before any public lookup', async () => {
    for (const suffix of ['?cursor=not-a-uuid', '?limit=0', '?limit=21', '?limit=1e1', '?role=ADMIN']) {
      for (const endpoint of ['followers', 'following', 'streams']) await request(app.getHttpServer()).get(`/api/v1/users/star/${endpoint}${suffix}`).expect(400);
    }
    expect(users.connections).not.toHaveBeenCalled();
    expect(users.broadcasts).not.toHaveBeenCalled();
  });

  it('serves exact raster bytes with a fixed image type, no sniffing and no stored-cache access', async () => {
    const result = await request(app.getHttpServer()).get('/api/v1/users/star/avatar?v=content-version').expect(200);
    expect(result.headers['content-type']).toBe('image/png');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(result.body).toEqual(parseProfileAvatar(png).bytes);
    users.avatar.mockRejectedValue(new NotFoundException('Profile photo not found.'));
    await request(app.getHttpServer()).get('/api/v1/users/deleted/avatar').expect(404);
  });

  it('requires authentication and binds image edits to the authenticated actor', async () => {
    await request(app.getHttpServer()).patch('/api/v1/users/me').send({ avatarDataUrl: png }).expect(401);
    expect(users.updateProfile).not.toHaveBeenCalled();
    await request(app.getHttpServer()).patch('/api/v1/users/me').set('Authorization', 'Bearer access.token.value').send({ avatarDataUrl: png, userId: cursor }).expect(400);
    await request(app.getHttpServer()).patch('/api/v1/users/me').set('Authorization', 'Bearer access.token.value').send({ avatarDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }).expect(400);
    expect(users.updateProfile).not.toHaveBeenCalled();
    await request(app.getHttpServer()).patch('/api/v1/users/me').set('Authorization', 'Bearer access.token.value').send({ avatarDataUrl: png }).expect(200);
    expect(users.updateProfile).toHaveBeenCalledWith(actorId, expect.objectContaining({ avatarDataUrl: png }));
    await request(app.getHttpServer()).patch('/api/v1/users/me').set('Authorization', 'Bearer access.token.value').send({ avatarDataUrl: null }).expect(200);
    expect(users.updateProfile).toHaveBeenLastCalledWith(actorId, expect.objectContaining({ avatarDataUrl: null }));
  });
});
