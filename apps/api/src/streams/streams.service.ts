import {
  BadGatewayException, BadRequestException, ConflictException, ForbiddenException,
  Inject, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@livestar/database';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { LiveKitService } from './livekit.service';
import { CreateStreamDto, StreamQueryDto } from './streams.dto';

const streamInclude = {
  creator: { select: { id: true, status: true, profile: { select: { username: true, displayName: true } } } },
} as const;
type StreamRecord = Prisma.LiveStreamGetPayload<{ include: typeof streamInclude }>;

export interface StreamView {
  id: string; title: string; category: string | null; status: string;
  createdAt: Date; startedAt: Date | null; endedAt: Date | null;
  creator: { id: string; username: string | null; displayName: string };
  viewerCount: number | null; mediaAvailable: boolean; publisherConnected: boolean;
}

@Injectable()
export class StreamsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LiveKitService) private readonly livekit: LiveKitService,
  ) {}

  private requireConfigured(): void {
    if (!this.livekit.configured()) throw new ServiceUnavailableException('Live streaming is not configured.');
  }

  private async record(id: string): Promise<StreamRecord> {
    const stream = await this.database.liveStream.findFirst({
      where: { id }, include: streamInclude,
    });
    if (!stream) throw new NotFoundException('Stream not found.');
    if (stream.creator.status !== 'ACTIVE') {
      await this.stopInactiveCreator(stream);
      throw new NotFoundException('Stream not found.');
    }
    return stream;
  }

  private async stopInactiveCreator(stream: StreamRecord): Promise<void> {
    if (!['LIVE', 'SCHEDULED'].includes(stream.status)) return;
    try {
      await this.livekit.deleteRoom(stream.livekitRoom);
      await this.settleBattle(stream.id);
      await this.database.liveStream.update({ where: { id: stream.id }, data: { status: 'ENDED', endedAt: new Date() } });
    } catch { /* Refuse new viewers and retry stopping on the next lookup. */ }
  }

  private assertOwner(stream: StreamRecord, userId: string): void {
    if (stream.creatorId !== userId) throw new ForbiddenException('Only the broadcaster can manage this stream.');
  }

  private baseView(stream: StreamRecord): StreamView {
    return {
      id: stream.id, title: stream.title, category: stream.category, status: stream.status,
      createdAt: stream.createdAt, startedAt: stream.startedAt, endedAt: stream.endedAt,
      creator: {
        id: stream.creator.id, username: stream.creator.profile?.username ?? null,
        displayName: stream.creator.profile?.displayName ?? 'LiveStar creator',
      },
      viewerCount: stream.status === 'ENDED' || stream.status === 'TERMINATED' ? 0 : null,
      mediaAvailable: false, publisherConnected: false,
    };
  }

  private async view(stream: StreamRecord): Promise<StreamView> {
    const result = this.baseView(stream);
    if (!['LIVE', 'SCHEDULED'].includes(stream.status)) return result;
    try {
      const rooms = await this.livekit.rooms([stream.livekitRoom]);
      if (!rooms.has(stream.livekitRoom)) {
        if (stream.status === 'SCHEDULED' && Date.now() - stream.createdAt.getTime() < 180_000) return result;
        await this.settleBattle(stream.id);
        const ended = await this.database.liveStream.update({
          where: { id: stream.id }, data: { status: 'ENDED', endedAt: new Date() }, include: streamInclude,
        });
        return this.baseView(ended);
      }
      const presence = await this.livekit.presence(stream.livekitRoom, stream.creatorId);
      return { ...result, viewerCount: presence.viewerCount, mediaAvailable: true, publisherConnected: presence.publisherHasTracks };
    } catch { return result; }
  }

  async list(query: StreamQueryDto) {
    const records = await this.database.liveStream.findMany({
      where: {
        status: 'LIVE',
        ...(query.creatorId ? { creatorId: query.creatorId } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.query?.trim() ? { OR: [
          { title: { contains: query.query.trim(), mode: 'insensitive' as const } },
          { creator: { profile: { displayName: { contains: query.query.trim(), mode: 'insensitive' as const } } } },
          { creator: { profile: { username: { contains: query.query.trim(), mode: 'insensitive' as const } } } },
        ] } : {}),
      },
      orderBy: { startedAt: 'desc' }, take: 24, include: streamInclude,
    });
    const views = await Promise.all(records.map(async stream => {
      if (stream.creator.status !== 'ACTIVE') { await this.stopInactiveCreator(stream); return null; }
      return this.view(stream);
    }));
    const items = views.filter((stream): stream is StreamView => !!stream && stream.status === 'LIVE' && stream.mediaAvailable && stream.publisherConnected);
    return { items, streamingEnabled: this.livekit.configured() };
  }

  async get(id: string): Promise<StreamView> { return this.view(await this.record(id)); }

  async mine(userId: string): Promise<{ stream: StreamView | null }> {
    const stream = await this.database.liveStream.findFirst({
      where: { creatorId: userId, status: { in: ['SCHEDULED', 'LIVE'] } },
      orderBy: { createdAt: 'desc' }, include: streamInclude,
    });
    if (!stream) return { stream: null };
    const view = await this.view(stream);
    return { stream: ['SCHEDULED', 'LIVE'].includes(view.status) ? view : null };
  }

  async create(userId: string, input: CreateStreamDto) {
    this.requireConfigured();
    const title = input.title.trim();
    if (!title) throw new BadRequestException('A stream title is required.');
    const id = randomUUID();
    let stream: StreamRecord;
    try {
      stream = await this.database.$transaction(async tx => {
        // The same user-first lock order as authentication/deletion.
        await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
        const user = await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } });
        if (!user) throw new ForbiddenException('Account is unavailable.');
        if (await tx.liveStream.findFirst({ where: { creatorId: userId, status: { in: ['SCHEDULED', 'LIVE'] } }, select: { id: true } })) {
          throw new ConflictException('Finish your current stream before starting another.');
        }
        return tx.liveStream.create({
          data: { id, creatorId: userId, title, category: input.category ?? 'chat', livekitRoom: `livestar-${id}`, status: 'SCHEDULED' },
          include: streamInclude,
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('You already have an active stream.');
      throw error;
    }
    try {
      await this.livekit.createRoom(stream.livekitRoom);
      const connection = await this.livekit.token(stream.livekitRoom, userId, stream.creator.profile?.displayName ?? 'Broadcaster', true);
      return { stream: { ...this.baseView(stream), viewerCount: 0, mediaAvailable: true }, ...connection };
    } catch {
      try { await this.livekit.deleteRoom(stream.livekitRoom); } catch { /* Empty rooms expire automatically. */ }
      await this.database.liveStream.update({ where: { id: stream.id }, data: { status: 'ENDED', endedAt: new Date() } });
      throw new ServiceUnavailableException('The media server could not start this stream.');
    }
  }

  async hostToken(id: string, userId: string) {
    this.requireConfigured();
    const stream = await this.record(id); this.assertOwner(stream, userId);
    if (!['SCHEDULED', 'LIVE'].includes(stream.status)) throw new ConflictException('This stream has ended.');
    try {
      const rooms = await this.livekit.rooms([stream.livekitRoom]);
      if (!rooms.has(stream.livekitRoom)) throw new ConflictException('This stream has ended.');
      return await this.livekit.token(stream.livekitRoom, userId, stream.creator.profile?.displayName ?? 'Broadcaster', true);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('The media server is unavailable.');
    }
  }

  async viewerToken(id: string) {
    this.requireConfigured();
    const stream = await this.record(id);
    if (stream.status !== 'LIVE') throw new ConflictException('This stream is not live.');
    try {
      const rooms = await this.livekit.rooms([stream.livekitRoom]);
      if (!rooms.has(stream.livekitRoom)) throw new ConflictException('This stream has ended.');
      return await this.livekit.token(stream.livekitRoom, `viewer-${randomUUID()}`, 'Viewer', false);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('The media server is unavailable.');
    }
  }

  async activate(id: string, userId: string): Promise<StreamView> {
    const stream = await this.record(id); this.assertOwner(stream, userId);
    if (!['SCHEDULED', 'LIVE'].includes(stream.status)) throw new ConflictException('This stream has ended.');
    let published = false;
    try { published = (await this.livekit.presence(stream.livekitRoom, userId)).publisherHasTracks; }
    catch { throw new ServiceUnavailableException('The media server is unavailable.'); }
    if (!published) throw new ConflictException('Connect your camera or microphone before going live.');
    const updated = await this.database.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } });
      if (!user) throw new ForbiddenException('Account is unavailable.');
      const result = await tx.liveStream.updateMany({
        where: { id, creatorId: userId, status: { in: ['SCHEDULED', 'LIVE'] } },
        data: { status: 'LIVE', startedAt: stream.startedAt ?? new Date() },
      });
      if (!result.count) throw new ConflictException('This stream has ended.');
      return tx.liveStream.findUniqueOrThrow({ where: { id }, include: streamInclude });
    });
    return this.view(updated);
  }

  private async settleBattle(streamId: string): Promise<void> {
    // Run independently of user/stream row transactions, matching PK's lock
    // order. The media room has already stopped before an end is committed.
    await this.database.$queryRaw`SELECT public.pk_settle_stream(${streamId}::uuid)::text`;
  }

  async end(id: string, userId: string): Promise<StreamView> {
    const stream = await this.record(id); this.assertOwner(stream, userId);
    if (['ENDED', 'TERMINATED'].includes(stream.status)) { await this.settleBattle(id); return this.baseView(stream); }
    try { await this.livekit.deleteRoom(stream.livekitRoom); }
    catch { throw new BadGatewayException('The media server could not stop this stream. Try again.'); }
    await this.settleBattle(id);
    const ended = await this.database.liveStream.update({ where: { id }, data: { status: 'ENDED', endedAt: new Date() }, include: streamInclude });
    return this.baseView(ended);
  }

  async messages(id: string, after?: string) {
    await this.record(id);
    const afterDate = after ? new Date(after) : null;
    if (afterDate && !Number.isFinite(afterDate.getTime())) throw new BadRequestException('Invalid message cursor.');
    const items = await this.database.liveMessage.findMany({
      where: { streamId: id, removedAt: null, ...(afterDate ? { createdAt: { gt: afterDate } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
      select: { id: true, body: true, createdAt: true, sender: { select: { id: true, profile: { select: { username: true, displayName: true } } } } },
    });
    return { items: items.reverse().map(item => ({
      id: item.id, body: item.body, createdAt: item.createdAt,
      sender: { id: item.sender.id, username: item.sender.profile?.username ?? null, displayName: item.sender.profile?.displayName ?? 'User' },
    })) };
  }

  async sendMessage(id: string, userId: string, rawBody: string) {
    const body = rawBody.trim();
    if (!body || body.length > 500) throw new BadRequestException('Messages must contain 1 to 500 characters.');
    const message = await this.database.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } });
      if (!user) throw new ForbiddenException('Account is unavailable.');
      const stream = await tx.liveStream.findUnique({ where: { id }, select: { creatorId: true, status: true, creator: { select: { status: true } } } });
      if (!stream) throw new NotFoundException('Stream not found.');
      if (stream.status !== 'LIVE' || stream.creator.status !== 'ACTIVE') throw new ConflictException('Messages can only be sent during a live stream.');
      const muted = await tx.streamMute.findFirst({ where: { streamId: id, userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
      if (muted) throw new ForbiddenException('You are muted in this stream.');
      return tx.liveMessage.create({ data: { streamId: id, senderId: userId, body }, include: { sender: { select: { id: true, profile: { select: { username: true, displayName: true } } } } } });
    });
    return {
      id: message.id, body: message.body, createdAt: message.createdAt,
      sender: { id: message.sender.id, username: message.sender.profile?.username ?? null, displayName: message.sender.profile?.displayName ?? 'User' },
    };
  }
}
