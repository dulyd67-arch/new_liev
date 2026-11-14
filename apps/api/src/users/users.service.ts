import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { UpdateProfileDto } from './users.dto';

// Explicit selections are the privacy boundary: no password, refresh hash,
// verification token, private profile fields or payment details in public APIs.
const publicSelect = {
  username: true, displayName: true, bio: true, avatarKey: true, locale: true,
  user: { select: { id: true, _count: { select: { followers: true, following: true } } } },
} as const;

const ownSelect = {
  id: true, email: true, status: true, emailVerifiedAt: true, ageVerifiedAt: true,
  birthDate: true, ageAttestedAt: true, termsAcceptedAt: true, termsVersion: true,
  privacyAcceptedAt: true, privacyVersion: true, createdAt: true,
  profile: { select: {
    username: true, displayName: true, bio: true, avatarKey: true, locale: true,
    countryCode: true, timezone: true,
  } },
  roles: { select: { role: { select: { name: true, permissions: true } } } },
} as const;

type PublicRecord = {
  username: string; displayName: string; bio: string | null; avatarKey: string | null; locale: string;
  user: { id: string; _count: { followers: number; following: number } };
};

function publicView(profile: PublicRecord) {
  return {
    id: profile.user.id, username: profile.username, displayName: profile.displayName,
    bio: profile.bio, avatarKey: profile.avatarKey, locale: profile.locale,
    followerCount: profile.user._count.followers, followingCount: profile.user._count.following,
  };
}

@Injectable()
export class UsersService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async me(userId: string) {
    const user = await this.database.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: ownSelect });
    if (!user) throw new UnauthorizedException('Account is unavailable.');
    return user;
  }

  async updateProfile(userId: string, input: UpdateProfileDto) {
    const data = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    };
    if (!Object.keys(data).length) throw new BadRequestException('Supply at least one profile field.');
    return this.database.$transaction(async (tx) => {
      // Same user-first lock order as reset/deletion prevents a concurrent
      // profile edit from restoring personal data after deletion was requested.
      await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } });
      if (!user) throw new UnauthorizedException('Account is unavailable.');
      await tx.userProfile.update({ where: { userId }, data });
      await tx.adminAuditLog.create({ data: {
        actorId: userId, action: 'PROFILE_UPDATED', entityType: 'USER', entityId: userId,
        requestId: randomUUID(), after: { changedFields: Object.keys(data) },
      } });
      return tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: ownSelect });
    });
  }

  async exportIdentity(userId: string) {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
      const account = await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: ownSelect });
      if (!account) throw new UnauthorizedException('Account is unavailable.');
      const [following, followers] = await Promise.all([
        tx.follow.findMany({ where: { followerId: userId }, select: { followedId: true, createdAt: true }, orderBy: { followedId: 'asc' } }),
        tx.follow.findMany({ where: { followedId: userId }, select: { followerId: true, createdAt: true }, orderBy: { followerId: 'asc' } }),
      ]);
      await tx.adminAuditLog.create({ data: {
        actorId: userId, action: 'IDENTITY_EXPORT_REQUESTED', entityType: 'USER', entityId: userId,
        requestId: randomUUID(),
      } });
      return {
        formatVersion: 1, exportedAt: new Date().toISOString(), scope: 'identity-profile-and-follows',
        account, following, followers,
      };
    });
  }

  async publicProfile(username: string) {
    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9_][a-z0-9_.-]{1,31}$/.test(normalized)) throw new NotFoundException('Profile not found.');
    const profile = await this.database.userProfile.findFirst({
      where: { username: { equals: normalized, mode: 'insensitive' }, user: { status: 'ACTIVE' } }, select: publicSelect,
    });
    if (!profile) throw new NotFoundException('Profile not found.');
    return publicView(profile);
  }

  async search(query: string, limit = 20) {
    const profiles = await this.database.userProfile.findMany({
      where: { user: { status: 'ACTIVE' }, OR: [
        { username: { contains: query.trim(), mode: 'insensitive' } },
        { displayName: { contains: query.trim(), mode: 'insensitive' } },
      ] },
      orderBy: { username: 'asc' }, take: limit + 1, select: publicSelect,
    });
    return { items: profiles.slice(0, limit).map(publicView), hasMore: profiles.length > limit };
  }
}
