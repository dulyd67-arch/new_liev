import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database.service';
import { ProfilePageQueryDto, SearchUsersDto, UpdateProfileDto } from '../src/users/users.dto';
import { UsersService } from '../src/users/users.service';
import { MAX_AVATAR_BYTES, parseProfileAvatar } from '../src/users/avatar';

const actor = '00000000-0000-4000-8000-000000000123';
const privateAccount = { id: actor, email: 'owner@example.invalid', profile: { username: 'star' }, roles: [] };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC2cAAAAASUVORK5CYII=';
const webp = 'data:image/webp;base64,UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoCAAMAAUAmJaACdLoAA5gA/u3O3/4hzoc6HMxndcY7MAAA';
const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEooor3TsP/9k=';

function fixture() {
  const database = {
    user: { findFirst: vi.fn().mockResolvedValue(privateAccount) },
    userProfile: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    follow: { findMany: vi.fn().mockResolvedValue([]) },
    liveStream: { findMany: vi.fn().mockResolvedValue([]) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: actor }]),
    $transaction: vi.fn(),
  };
  database.$transaction.mockImplementation(async (operation: (tx: typeof database) => Promise<unknown>) => operation(database));
  return { database, service: new UsersService(database as unknown as DatabaseService) };
}

describe('private and public user data boundaries', () => {
  it('selects only the authenticated active account and excludes credential columns', async () => {
    const { database, service } = fixture();
    await service.me(actor);
    const query = database.user.findFirst.mock.calls[0]?.[0];
    expect(query.where).toEqual({ id: actor, status: 'ACTIVE', deletedAt: null });
    expect(query.select.passwordHash).toBeUndefined();
    expect(query.select.sessions).toBeUndefined();
    expect(query.select.authChallenges).toBeUndefined();
    expect(query.select.email).toBe(true);
  });

  it('returns a safe public projection even when the database fixture has extra private fields', async () => {
    const { database, service } = fixture();
    database.userProfile.findFirst.mockResolvedValue({
      username: 'star', displayName: 'Star', bio: null, avatarKey: null, locale: 'ar',
      countryCode: 'SA', timezone: 'Asia/Riyadh',
      user: { id: actor, email: 'private@example.invalid', passwordHash: 'private-hash', _count: { followers: 3, following: 4, streams: 7 } },
    });
    const result = await service.publicProfile('STAR');
    expect(result).toEqual({ id: actor, username: 'star', displayName: 'Star', bio: null, avatarKey: null, avatarUrl: null, locale: 'ar', followerCount: 3, followingCount: 4, broadcastCount: 7 });
    const query = database.userProfile.findFirst.mock.calls[0]?.[0];
    expect(query.where.user).toEqual({ status: 'ACTIVE', deletedAt: null });
    expect(query.select.user.select._count.select.followers.where.follower).toMatchObject({ status: 'ACTIVE', deletedAt: null });
    expect(query.select.user.select._count.select.following.where.followed).toMatchObject({ status: 'ACTIVE', deletedAt: null });
    expect(query.select.user.select._count.select.streams.where).toEqual({ status: { in: ['LIVE', 'ENDED'] }, startedAt: { not: null } });
  });

  it('rejects inactive or missing accounts without exporting their data', async () => {
    const { database, service } = fixture();
    database.user.findFirst.mockResolvedValue(null);
    await expect(service.me(actor)).rejects.toMatchObject({ status: 401 });
    await expect(service.exportIdentity(actor)).rejects.toMatchObject({ status: 401 });
    expect(database.follow.findMany).not.toHaveBeenCalled();
  });

  it('binds profile writes to the actor and records changed field names without their private values', async () => {
    const { database, service } = fixture();
    await service.updateProfile(actor, Object.assign(new UpdateProfileDto(), { displayName: 'My new name', role: 'SUPER_ADMIN', userId: 'other-user' }));
    expect(database.$queryRaw).toHaveBeenCalled();
    expect(database.userProfile.update).toHaveBeenCalledWith({ where: { userId: actor }, data: { displayName: 'My new name' } });
    const audit = database.adminAuditLog.create.mock.calls[0]?.[0].data;
    expect(audit.actorId).toBe(actor);
    expect(audit.after).toEqual({ changedFields: ['displayName'] });
    expect(JSON.stringify(audit)).not.toContain('My new name');
  });

  it('rejects an empty profile update', async () => {
    const { database, service } = fixture();
    await expect(service.updateProfile(actor, {})).rejects.toMatchObject({ status: 400 });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('exports only the actor identity scope and binds both follow directions to that actor', async () => {
    const { database, service } = fixture();
    const result = await service.exportIdentity(actor);
    expect(result.scope).toBe('identity-profile-and-follows');
    expect(result.account.id).toBe(actor);
    expect(database.follow.findMany.mock.calls.map(([query]) => query.where)).toEqual([
      { followerId: actor }, { followedId: actor },
    ]);
    for (const [query] of database.follow.findMany.mock.calls) {
      expect(query.select.user).toBeUndefined();
      expect(query.select.email).toBeUndefined();
    }
  });

  it('caps search results and queries active public profiles only', async () => {
    const { database, service } = fixture();
    const profile = { username: 'star', displayName: 'Star', bio: null, avatarKey: null, locale: 'ar', user: { id: actor, _count: { followers: 0, following: 0, streams: 0 } } };
    database.userProfile.findMany.mockResolvedValue([profile, profile, profile]);
    const result = await service.search('star', 2);
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    const query = database.userProfile.findMany.mock.calls[0]?.[0];
    expect(query.take).toBe(3);
    expect(query.where.user).toEqual({ status: 'ACTIVE', deletedAt: null });
  });

  it('returns a versioned public photo URL without copying stored image data into profile JSON', async () => {
    const { database, service } = fixture();
    database.userProfile.findFirst.mockResolvedValue({
      username: 'star', displayName: 'Star', bio: null, avatarKey: png, locale: 'ar',
      user: { id: actor, _count: { followers: 0, following: 0, streams: 0 } },
    });
    const result = await service.publicProfile('star');
    expect(result.avatarKey).toBeNull();
    expect(result.avatarUrl).toMatch(/^\/api\/v1\/users\/star\/avatar\?v=[a-f0-9]{16}$/);
    expect(JSON.stringify(result)).not.toContain('base64');
  });

  it('binds photo updates and removals to the authenticated account while auditing only field names', async () => {
    const { database, service } = fixture();
    await service.updateProfile(actor, { avatarDataUrl: png });
    expect(database.userProfile.update).toHaveBeenLastCalledWith({ where: { userId: actor }, data: { avatarKey: png } });
    const audit = database.adminAuditLog.create.mock.calls[0]![0].data;
    expect(audit.after).toEqual({ changedFields: ['avatarKey'] });
    expect(JSON.stringify(audit)).not.toContain('base64');
    await service.updateProfile(actor, { avatarDataUrl: null });
    expect(database.userProfile.update).toHaveBeenLastCalledWith({ where: { userId: actor }, data: { avatarKey: null } });
  });

  it('rejects invalid photo input before opening a profile write transaction', async () => {
    const { database, service } = fixture();
    await expect(service.updateProfile(actor, { avatarDataUrl: 'https://example.invalid/photo.svg' })).rejects.toMatchObject({ status: 400 });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('does not return inactive, missing, or invalid stored profile photos', async () => {
    const { database, service } = fixture();
    database.userProfile.findFirst.mockResolvedValue(null);
    await expect(service.avatar('star')).rejects.toMatchObject({ status: 404 });
    database.userProfile.findFirst.mockResolvedValue({ avatarKey: 'untrusted-object-key' });
    await expect(service.avatar('star')).rejects.toMatchObject({ status: 404 });
    database.userProfile.findFirst.mockResolvedValue({ avatarKey: png });
    const avatar = await service.avatar('STAR');
    expect(avatar.contentType).toBe('image/png');
    expect(Buffer.isBuffer(avatar.bytes)).toBe(true);
    expect(database.userProfile.findFirst.mock.calls.at(-1)![0].where.user).toEqual({ status: 'ACTIVE', deletedAt: null });
  });
});

describe('public connection and broadcast pagination', () => {
  it.each(['followers', 'following'] as const)('pages %s with an active owner, stable IDs and an explicit public projection', async direction => {
    const { database, service } = fixture();
    database.userProfile.findFirst.mockResolvedValue({ userId: actor });
    const ids = ['00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000203'];
    const field = direction === 'followers' ? 'follower' : 'followed';
    database.follow.findMany.mockResolvedValue(ids.map((id, index) => ({
      [`${field}Id`]: id,
      [field]: { id, email: 'private@example.invalid', passwordHash: 'credential', profile: { username: `star${index}`, displayName: 'Star', bio: null, avatarKey: png, timezone: 'private-location' } },
    })));
    const result = await service.connections('star', direction, actor, 2);
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe(ids[1]);
    expect(result.items[0]).toEqual({ id: ids[0], username: 'star0', displayName: 'Star', bio: null, avatarUrl: expect.stringMatching(/\/avatar\?v=/) });
    const serialized = JSON.stringify(result);
    for (const privateValue of ['private@example.invalid', 'credential', 'private-location', 'base64']) expect(serialized).not.toContain(privateValue);
    const query = database.follow.findMany.mock.calls[0]![0];
    expect(query.take).toBe(3);
    expect(query.where[`${field}Id`]).toEqual({ gt: actor });
    expect(query.where[field]).toMatchObject({ status: 'ACTIVE', deletedAt: null, profile: { isNot: null } });
    expect(query.orderBy).toEqual({ [`${field}Id`]: 'asc' });
  });

  it('refuses nonexistent or inactive profile lists before querying relationships or broadcasts', async () => {
    const { database, service } = fixture();
    database.userProfile.findFirst.mockResolvedValue(null);
    await expect(service.connections('star', 'followers')).rejects.toMatchObject({ status: 404 });
    await expect(service.broadcasts('star')).rejects.toMatchObject({ status: 404 });
    expect(database.follow.findMany).not.toHaveBeenCalled();
    expect(database.liveStream.findMany).not.toHaveBeenCalled();
  });

  it('returns completed started session metadata without room keys, moderation content or recordings', async () => {
    const { database, service } = fixture();
    database.userProfile.findFirst.mockResolvedValue({ userId: actor });
    const id = '00000000-0000-4000-8000-000000000201';
    database.liveStream.findMany.mockResolvedValue([{ id, title: 'A completed session', category: 'chat', status: 'ENDED', startedAt: new Date('2026-11-22T00:00:00Z'), endedAt: new Date('2026-11-22T00:01:00Z'), livekitRoom: 'private-room-key', recordingUrl: 'not-a-real-recording' }]);
    const result = await service.broadcasts('star', actor, 2);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-room-key');
    expect(JSON.stringify(result)).not.toContain('recording');
    const query = database.liveStream.findMany.mock.calls[0]![0];
    expect(query.where).toEqual({ creatorId: actor, creator: { status: 'ACTIVE', deletedAt: null }, status: 'ENDED', startedAt: { not: null }, id: { gt: actor } });
    expect(query.take).toBe(3);
    expect(query.orderBy).toEqual({ id: 'asc' });
  });
});

describe('user profile input validation', () => {
  const errors = (input: unknown) => validate(plainToInstance(UpdateProfileDto, input), { whitelist: true, forbidNonWhitelisted: true });

  it('accepts Arabic display names, empty bio, supported locale and IANA time zones', async () => {
    expect(await errors({ displayName: '  نجمة  ', bio: null, locale: 'ar', timezone: 'Asia/Riyadh' })).toHaveLength(0);
  });

  it('accepts a bounded image or explicit photo removal, and rejects unknown photo fields', async () => {
    expect(await errors({ avatarDataUrl: png })).toHaveLength(0);
    expect(await errors({ avatarDataUrl: null })).toHaveLength(0);
    for (const value of ['', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=', 12, 'https://example.invalid/image.png']) expect((await errors({ avatarDataUrl: value })).length).toBeGreaterThan(0);
    expect((await errors({ avatarKey: png })).length).toBeGreaterThan(0);
  });

  it('rejects privilege fields, null non-nullable fields, unsupported locales and invalid time zones', async () => {
    for (const input of [{ role: 'ADMIN' }, { displayName: null }, { locale: null }, { timezone: null }, { locale: 'fr' }, { timezone: 'not-a-zone' }, { displayName: '   ' }]) {
      expect((await errors(input)).length).toBeGreaterThan(0);
    }
  });

  it('requires a search query and bounds result limits to 1 through 20', async () => {
    for (const input of [{}, { query: 's' }, { query: 'star', limit: '21' }, { query: 'star', limit: '0' }, { query: 'star', limit: '1e1' }]) {
      expect((await validate(plainToInstance(SearchUsersDto, input))).length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(SearchUsersDto, { query: 'star', limit: '20' }))).toHaveLength(0);
  });

  it('validates bounded public pagination and rejects malformed cursors or numeric coercion tricks', async () => {
    for (const input of [{ cursor: 'not-a-uuid' }, { limit: '21' }, { limit: '0' }, { limit: '1e1' }]) expect((await validate(plainToInstance(ProfilePageQueryDto, input))).length).toBeGreaterThan(0);
    expect(await validate(plainToInstance(ProfilePageQueryDto, { cursor: actor, limit: '20' }))).toHaveLength(0);
  });
});

describe('bounded raster profile photo parsing', () => {
  it('accepts an actual PNG and produces a stable content version', () => {
    const photo = parseProfileAvatar(png);
    expect(photo.contentType).toBe('image/png');
    expect(photo.version).toMatch(/^[a-f0-9]{16}$/);
    expect(parseProfileAvatar(png).version).toBe(photo.version);
  });

  it.each([{ value: jpeg, contentType: 'image/jpeg' }, { value: webp, contentType: 'image/webp' }])('accepts a valid $contentType raster without platform-native decoder dependencies', ({ value, contentType }) => {
    expect(parseProfileAvatar(value).contentType).toBe(contentType);
  });

  it('rejects format spoofing, noncanonical base64, incomplete images and large pixel dimensions', () => {
    const bytes = Buffer.from(png.split(',')[1]!, 'base64');
    const tooWide = Buffer.from(bytes); tooWide.writeUInt32BE(513, 16);
    const tooTall = Buffer.from(bytes); tooTall.writeUInt32BE(513, 20);
    const badEnd = Buffer.from(bytes); badEnd[badEnd.length - 1] = 0;
    for (const value of [
      png.replace('image/png', 'image/jpeg'), png.replace(/=$/, ''), 'data:image/png;base64,AAAA',
      `data:image/png;base64,${tooWide.toString('base64')}`, `data:image/png;base64,${tooTall.toString('base64')}`, `data:image/png;base64,${badEnd.toString('base64')}`,
    ]) expect(() => parseProfileAvatar(value)).toThrow();
  });

  it('bounds decoded and encoded sizes before an image can be stored', () => {
    const bytes = Buffer.alloc(MAX_AVATAR_BYTES + 1);
    expect(() => parseProfileAvatar(`data:image/png;base64,${bytes.toString('base64')}`)).toThrow();
    expect(() => parseProfileAvatar('a'.repeat(65560))).toThrow();
  });
});
