import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@livestar/database';
import { DatabaseService } from '../database.service';

@Injectable()
export class SocialService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async requirePair(tx: Prisma.TransactionClient, userId: string, targetId: string): Promise<void> {
    if (userId === targetId) throw new ForbiddenException('Choose another account.');
    // Match account deletion's user-first lock order, and lock pairs in UUID order.
    await tx.$queryRaw`SELECT id FROM public.users WHERE id IN (${userId}::uuid, ${targetId}::uuid) ORDER BY id FOR UPDATE`;
    const users = await tx.user.findMany({
      where: { id: { in: [userId, targetId] }, status: 'ACTIVE', deletedAt: null }, select: { id: true },
    });
    if (!users.some(user => user.id === userId)) throw new ForbiddenException('Account is unavailable.');
    if (!users.some(user => user.id === targetId)) throw new NotFoundException('Account not found.');
    const blocked = await tx.userBlock.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: targetId }, { blockerId: targetId, blockedId: userId }] },
      select: { blockerId: true },
    });
    if (blocked) throw new ForbiddenException('This interaction is unavailable.');
  }

  async status(userId: string, targetId: string): Promise<{ following: boolean }> {
    targetId = targetId.toLowerCase();
    return this.database.$transaction(async tx => {
      await this.requirePair(tx, userId, targetId);
      const follow = await tx.follow.findUnique({ where: { followerId_followedId: { followerId: userId, followedId: targetId } }, select: { followedId: true } });
      return { following: !!follow };
    });
  }

  async follow(userId: string, targetId: string, following: boolean): Promise<{ following: boolean }> {
    targetId = targetId.toLowerCase();
    return this.database.$transaction(async tx => {
      await this.requirePair(tx, userId, targetId);
      if (following) {
        await tx.follow.createMany({
          data: [{ followerId: userId, followedId: targetId }], skipDuplicates: true,
        });
      } else {
        await tx.follow.deleteMany({ where: { followerId: userId, followedId: targetId } });
      }
      return { following };
    });
  }

  async report(userId: string, streamId: string, reason: string): Promise<{ id: string; status: 'OPEN' }> {
    return this.database.$transaction(async tx => {
      const stream = await tx.liveStream.findUnique({ where: { id: streamId }, select: { id: true, creatorId: true } });
      if (!stream) throw new NotFoundException('Stream not found.');
      await this.requirePair(tx, userId, stream.creatorId);
      const report = await tx.report.create({
        data: { reporterId: userId, targetUserId: stream.creatorId, streamId, reasonCode: 'STREAM_REPORT', details: reason },
        select: { id: true },
      });
      return { id: report.id, status: 'OPEN' };
    });
  }
}
