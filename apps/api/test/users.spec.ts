import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database.service';
import { SearchUsersDto, UpdateProfileDto } from '../src/users/users.dto';
import { UsersService } from '../src/users/users.service';

const actor = '00000000-0000-4000-8000-000000000123';
const privateAccount = { id: actor, email: 'owner@example.invalid', profile: { username: 'star' }, roles: [] };

function fixture() {
  const database = {
    user: { findFirst: vi.fn().mockResolvedValue(privateAccount) },
    userProfile: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    follow: { findMany: vi.fn().mockResolvedValue([]) },
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
    expect(query.where).toEqual({ id: actor, status: 'ACTIVE' });
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
      user: { id: actor, email: 'private@example.invalid', passwordHash: 'private-hash', _count: { followers: 3, following: 4 } },
    });
    const result = await service.publicProfile('STAR');
    expect(result).toEqual({ id: actor, username: 'star', displayName: 'Star', bio: null, avatarKey: null, locale: 'ar', followerCount: 3, followingCount: 4 });
    expect(database.userProfile.findFirst.mock.calls[0]?.[0].where.user).toEqual({ status: 'ACTIVE' });
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
    const profile = { username: 'star', displayName: 'Star', bio: null, avatarKey: null, locale: 'ar', user: { id: actor, _count: { followers: 0, following: 0 } } };
    database.userProfile.findMany.mockResolvedValue([profile, profile, profile]);
    const result = await service.search('star', 2);
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    const query = database.userProfile.findMany.mock.calls[0]?.[0];
    expect(query.take).toBe(3);
    expect(query.where.user).toEqual({ status: 'ACTIVE' });
  });
});

describe('user profile input validation', () => {
  const errors = (input: unknown) => validate(plainToInstance(UpdateProfileDto, input), { whitelist: true, forbidNonWhitelisted: true });

  it('accepts Arabic display names, empty bio, supported locale and IANA time zones', async () => {
    expect(await errors({ displayName: '  نجمة  ', bio: null, locale: 'ar', timezone: 'Asia/Riyadh' })).toHaveLength(0);
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
});
