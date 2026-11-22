import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { UpdateProfileDto } from './users.dto';
import { parseProfileAvatar, publicAvatarUrl, storedProfileAvatar } from './avatar';

const activeUser = { status: 'ACTIVE', deletedAt: null } as const;
const countedStreamStatuses: Array<'LIVE' | 'ENDED'> = ['LIVE', 'ENDED'];

// Explicit selections are the privacy boundary: no password, refresh hash,
// verification token, private profile fields or payment details in public APIs.
const publicSelect = {
  username: true, displayName: true, bio: true, avatarKey: true, locale: true,
  user: { select: { id: true, _count: { select: {
    followers: { where: { follower: { ...activeUser, profile: { isNot: null } } } },
    following: { where: { followed: { ...activeUser, profile: { isNot: null } } } },
    streams: { where: { status: { in: countedStreamStatuses }, startedAt: { not: null } } },
  } } } },
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
  user: { id: string; _count: { followers: number; following: number; streams: number } };
};

function publicView(profile: PublicRecord) {
  return {
    id: profile.user.id, username: profile.username, displayName: profile.displayName,
    bio: profile.bio, avatarKey: null, avatarUrl: publicAvatarUrl(profile.username, profile.avatarKey), locale: profile.locale,
    followerCount: profile.user._count.followers, followingCount: profile.user._count.following,
    broadcastCount: profile.user._count.streams,
  };
}

const connectionSelect = {
  id: true,
  profile: { select: { username: true, displayName: true, bio: true, avatarKey: true } },
} as const;
type ConnectionRecord = { id: string; profile: { username: string; displayName: string; bio: string | null; avatarKey: string | null } | null };

function connectionView(user: ConnectionRecord) {
  if (!user.profile) return null;
  return {
    id: user.id, username: user.profile.username, displayName: user.profile.displayName,
    bio: user.profile.bio, avatarUrl: publicAvatarUrl(user.profile.username, user.profile.avatarKey),
  };
}

function normalizedUsername(username: string): string {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9_][a-z0-9_.-]{1,31}$/.test(normalized)) throw new NotFoundException('Profile not found.');
  return normalized;
}

@Injectable()
export class UsersService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async me(userId: string) {
    const user = await this.database.user.findFirst({ where: { id: userId, ...activeUser }, select: ownSelect });
    if (!user) throw new UnauthorizedException('Account is unavailable.');
    return user;
  }

  async updateProfile(userId: string, input: UpdateProfileDto) {
    const data = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.avatarDataUrl !== undefined ? { avatarKey: input.avatarDataUrl === null ? null : parseProfileAvatar(input.avatarDataUrl).dataUrl } : {}),
    };
    if (!Object.keys(data).length) throw new BadRequestException('Supply at least one profile field.');
    return this.database.$transaction(async (tx) => {
      // Same user-first lock order as reset/deletion prevents a concurrent
      // profile edit from restoring personal data after deletion was requested.
      await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findFirst({ where: { id: userId, ...activeUser }, select: { id: true } });
      if (!user) throw new UnauthorizedException('Account is unavailable.');
      await tx.userProfile.update({ where: { userId }, data });
      await tx.adminAuditLog.create({ data: {
        actorId: userId, action: 'PROFILE_UPDATED', entityType: 'USER', entityId: userId,
        requestId: randomUUID(), after: { changedFields: Object.keys(data) },
      } });
      return tx.user.findFirst({ where: { id: userId, ...activeUser }, select: ownSelect });
    });
  }

  async exportIdentity(userId: string) {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
      const account = await tx.user.findFirst({ where: { id: userId, ...activeUser }, select: ownSelect });
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
    const normalized = normalizedUsername(username);
    const profile = await this.database.userProfile.findFirst({
      where: { username: { equals: normalized, mode: 'insensitive' }, user: activeUser }, select: publicSelect,
    });
    if (!profile) throw new NotFoundException('Profile not found.');
    return publicView(profile);
  }

  private async profileIdentity(username: string): Promise<{ userId: string }> {
    const profile = await this.database.userProfile.findFirst({
      where: { username: { equals: normalizedUsername(username), mode: 'insensitive' }, user: activeUser },
      select: { userId: true },
    });
    if (!profile) throw new NotFoundException('Profile not found.');
    return profile;
  }

  async avatar(username: string) {
    const profile = await this.database.userProfile.findFirst({
      where: { username: { equals: normalizedUsername(username), mode: 'insensitive' }, user: activeUser },
      select: { avatarKey: true },
    });
    const avatar = storedProfileAvatar(profile?.avatarKey ?? null);
    if (!avatar) throw new NotFoundException('Profile photo not found.');
    return avatar;
  }

  async connections(username: string, direction: 'followers' | 'following', cursor?: string, limit = 20) {
    const { userId } = await this.profileIdentity(username);
    if (direction === 'followers') {
      const rows = await this.database.follow.findMany({
        where: { followedId: userId, followed: activeUser, ...(cursor ? { followerId: { gt: cursor } } : {}), follower: { ...activeUser, profile: { isNot: null } } },
        select: { followerId: true, follower: { select: connectionSelect } },
        orderBy: { followerId: 'asc' }, take: limit + 1,
      });
      const visible = rows.slice(0, limit);
      return { items: visible.flatMap(row => { const profile = connectionView(row.follower); return profile ? [profile] : []; }), nextCursor: rows.length > limit ? visible.at(-1)!.followerId : null };
    }
    const rows = await this.database.follow.findMany({
      where: { followerId: userId, follower: activeUser, ...(cursor ? { followedId: { gt: cursor } } : {}), followed: { ...activeUser, profile: { isNot: null } } },
      select: { followedId: true, followed: { select: connectionSelect } },
      orderBy: { followedId: 'asc' }, take: limit + 1,
    });
    const visible = rows.slice(0, limit);
    return { items: visible.flatMap(row => { const profile = connectionView(row.followed); return profile ? [profile] : []; }), nextCursor: rows.length > limit ? visible.at(-1)!.followedId : null };
  }

  async broadcasts(username: string, cursor?: string, limit = 20) {
    const { userId } = await this.profileIdentity(username);
    const rows = await this.database.liveStream.findMany({
      where: { creatorId: userId, creator: activeUser, status: 'ENDED', startedAt: { not: null }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, title: true, category: true, status: true, startedAt: true, endedAt: true },
      orderBy: { id: 'asc' }, take: limit + 1,
    });
    const visible = rows.slice(0, limit);
    return {
      // Explicit projection remains a privacy boundary if the database adapter
      // changes. These are session metadata, never playback recordings.
      items: visible.map(row => ({ id: row.id, title: row.title, category: row.category, status: row.status, startedAt: row.startedAt, endedAt: row.endedAt })),
      nextCursor: rows.length > limit ? visible.at(-1)!.id : null,
    };
  }

  async search(query: string, limit = 20) {
    const profiles = await this.database.userProfile.findMany({
      where: { user: activeUser, OR: [
        { username: { contains: query.trim(), mode: 'insensitive' } },
        { displayName: { contains: query.trim(), mode: 'insensitive' } },
      ] },
      orderBy: { username: 'asc' }, take: limit + 1, select: publicSelect,
    });
    return { items: profiles.slice(0, limit).map(publicView), hasMore: profiles.length > limit };
  }
}
