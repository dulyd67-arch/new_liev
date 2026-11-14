import { JwtService } from '@nestjs/jwt';
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database.service';
import { LiveKitService } from '../src/streams/livekit.service';
import { StreamsService } from '../src/streams/streams.service';
import { EnvironmentValidationError } from '../src/config';

const ownerId = '10000000-0000-4000-8000-000000000001';
const streamId = '20000000-0000-4000-8000-000000000002';
const otherId = '30000000-0000-4000-8000-000000000003';
function record(status: 'LIVE' | 'SCHEDULED' | 'ENDED' = 'LIVE') {
  return {
    id: streamId, creatorId: ownerId, title: 'A real broadcast', category: 'chat', description: null, language: 'ar',
    status, livekitRoom: 'livestar-test-room', thumbnailKey: null, createdAt: new Date(),
    startedAt: status === 'SCHEDULED' ? null : new Date(), endedAt: status === 'ENDED' ? new Date() : null,
    creator: { id: ownerId, status: 'ACTIVE', profile: { username: 'host', displayName: 'Broadcaster' } },
  };
}
function fixture(current = record()) {
  const db = {
    liveStream: {
      findFirst: vi.fn().mockResolvedValue(current), findMany: vi.fn().mockResolvedValue([current]),
      create: vi.fn().mockResolvedValue(current), update: vi.fn().mockResolvedValue(record('ENDED')),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: vi.fn().mockResolvedValue(record('LIVE')),
    },
    user: { findFirst: vi.fn().mockResolvedValue({ id: ownerId }) },
    $queryRaw: vi.fn().mockResolvedValue([]), $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((operation: (tx: typeof db) => Promise<unknown>) => operation(db));
  const media = {
    configured: vi.fn().mockReturnValue(true), rooms: vi.fn().mockResolvedValue(new Set([current.livekitRoom])),
    presence: vi.fn().mockResolvedValue({ viewerCount: 3, publisherConnected: true, publisherHasTracks: true }),
    createRoom: vi.fn().mockResolvedValue(undefined), deleteRoom: vi.fn().mockResolvedValue(undefined),
    token: vi.fn().mockResolvedValue({ token: 'fixture-token', url: 'ws://localhost:7880' }),
  };
  return { db, media, service: new StreamsService(db as unknown as DatabaseService, media as unknown as LiveKitService) };
}

describe('LiveKit signed media grants', () => {
  const secret = 'test_livekit_secret_long_enough_for_signing_2026';
  beforeEach(() => {
    vi.stubEnv('LIVEKIT_URL', 'ws://localhost:7880'); vi.stubEnv('LIVEKIT_API_URL', 'http://localhost:7880');
    vi.stubEnv('LIVEKIT_API_KEY', 'unit-test-key'); vi.stubEnv('LIVEKIT_API_SECRET', secret);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('signs a viewer token that cannot publish, administer, create rooms or publish data', async () => {
    const connection = await new LiveKitService().token('scoped-room', 'viewer-random', 'Viewer', false);
    const claims = await new JwtService().verifyAsync<{ sub: string; iss: string; video: Record<string, unknown> }>(connection.token, { secret, algorithms: ['HS256'] });
    expect(connection.url).toBe('ws://localhost:7880'); expect(claims.sub).toBe('viewer-random');
    expect(claims.iss).toBe('unit-test-key');
    expect(claims.video).toMatchObject({ room: 'scoped-room', roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, canUpdateOwnMetadata: false });
    expect(claims.video.roomAdmin).not.toBe(true); expect(claims.video.roomCreate).not.toBe(true);
  });
  it('permits media publishing only on the explicit owner token', async () => {
    const result = await new LiveKitService().token('host-room', ownerId, 'Host', true);
    const claims = await new JwtService().verifyAsync<{ sub: string; video: Record<string, unknown> }>(result.token, { secret });
    expect(claims.sub).toBe(ownerId); expect(claims.video).toMatchObject({ room: 'host-room', canPublish: true, canPublishData: false });
  });
  it('does not issue a token without valid provider configuration', async () => {
    vi.stubEnv('LIVEKIT_API_SECRET', ''); const media = new LiveKitService();
    expect(media.configured()).toBe(false);
    await expect(media.token('room', 'viewer', 'Viewer', false)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('production media configuration', () => {
  const secret = '850abd131e2cfaab5c4a2d24c3e3d0515f713d8f19a98e549726ec016b23cc08';
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LIVEKIT_URL', 'wss://media.livestar.tv');
    vi.stubEnv('LIVEKIT_API_URL', 'http://livekit:7880');
    vi.stubEnv('LIVEKIT_API_KEY', 'LK_a654091921cd');
    vi.stubEnv('LIVEKIT_API_SECRET', secret);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('accepts public WSS with a private management endpoint and preserves subscribe-only signing', async () => {
    const service = new LiveKitService();
    expect(() => service.onModuleInit()).not.toThrow();
    const result = await service.token('scoped-production-room', 'viewer-fixture', 'Viewer', false);
    expect(result.url).toBe('wss://media.livestar.tv');
    const claims = await new JwtService().verifyAsync<{ video: Record<string, unknown> }>(result.token, { secret });
    expect(claims.video).toMatchObject({ room: 'scoped-production-room', canPublish: false, canPublishData: false });
  });

  it('fails at startup for missing, insecure or loopback browser media URLs', () => {
    for (const value of ['', 'ws://media.livestar.tv', 'wss://localhost:7880', 'wss://127.0.0.1:7880', 'wss://media.example.com']) {
      vi.stubEnv('LIVEKIT_URL', value);
      const service = new LiveKitService();
      expect(service.configured()).toBe(false);
      expect(() => service.onModuleInit()).toThrow('LIVEKIT_URL');
    }
  });

  it('rejects development media credentials without leaking their values', () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'devkey');
    vi.stubEnv('LIVEKIT_API_SECRET', 'livestar_local_dev_secret_change_me_32plus');
    try {
      new LiveKitService().onModuleInit();
      throw new Error('expected invalid production credentials');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).toContain('LIVEKIT_API_KEY');
      expect((error as Error).message).toContain('LIVEKIT_API_SECRET');
      expect((error as Error).message).not.toContain('devkey');
      expect((error as Error).message).not.toContain('livestar_local_dev_secret_change_me_32plus');
    }
  });

  it('keeps malformed management URLs out of startup errors and refuses embedded credentials', () => {
    vi.stubEnv('LIVEKIT_API_URL', 'https://hidden-password@media.livestar.tv');
    expect(() => new LiveKitService().onModuleInit()).toThrow('LIVEKIT_API_URL');
    try { new LiveKitService().onModuleInit(); }
    catch (error) { expect((error as Error).message).not.toContain('hidden-password'); }
    vi.stubEnv('LIVEKIT_API_URL', 'http://media.livestar.tv');
    expect(() => new LiveKitService().onModuleInit()).toThrow('LIVEKIT_API_URL');
  });
});

describe('livestream authorization and genuine media state', () => {
  it('rejects another account obtaining a host token or ending a room', async () => {
    const { service, media, db } = fixture();
    await expect(service.hostToken(streamId, otherId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.end(streamId, otherId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(media.token).not.toHaveBeenCalled(); expect(media.deleteRoom).not.toHaveBeenCalled(); expect(db.liveStream.update).not.toHaveBeenCalled();
  });
  it('mints a generated anonymous viewer identity with publishing disabled, only while live', async () => {
    const { service, media } = fixture(); await service.viewerToken(streamId);
    expect(media.token).toHaveBeenCalledWith('livestar-test-room', expect.stringMatching(/^viewer-/), 'Viewer', false);
    const reserved = fixture(record('SCHEDULED'));
    await expect(reserved.service.viewerToken(streamId)).rejects.toBeInstanceOf(ConflictException);
    expect(reserved.media.token).not.toHaveBeenCalled();
  });
  it('refuses viewer tokens for an actual media room that no longer exists', async () => {
    const { service, media } = fixture(); media.rooms.mockResolvedValue(new Set());
    await expect(service.viewerToken(streamId)).rejects.toBeInstanceOf(ConflictException);
    expect(media.token).not.toHaveBeenCalled();
  });
  it('requires an actual broadcaster track before marking the stream live', async () => {
    const { service, media, db } = fixture(record('SCHEDULED'));
    media.presence.mockResolvedValue({ viewerCount: 2, publisherConnected: true, publisherHasTracks: false });
    await expect(service.activate(streamId, ownerId)).rejects.toBeInstanceOf(ConflictException);
    expect(db.liveStream.updateMany).not.toHaveBeenCalled();
  });
  it('activates a connected broadcaster and returns measured viewer presence', async () => {
    const { service, db } = fixture(record('SCHEDULED'));
    expect(await service.activate(streamId, ownerId)).toMatchObject({ status: 'LIVE', mediaAvailable: true, publisherConnected: true, viewerCount: 3 });
    expect(db.liveStream.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: streamId, creatorId: ownerId }), data: expect.objectContaining({ status: 'LIVE' }) }));
  });
  it('does not claim a stream ended if the media server failed to stop it', async () => {
    const { service, media, db } = fixture(); media.deleteRoom.mockRejectedValue(new Error('unreachable'));
    await expect(service.end(streamId, ownerId)).rejects.toBeInstanceOf(BadGatewayException);
    expect(db.liveStream.update).not.toHaveBeenCalled();
  });
  it('ends the real media room before committing its ended state', async () => {
    const { service, media, db } = fixture();
    expect(await service.end(streamId, ownerId)).toMatchObject({ status: 'ENDED', viewerCount: 0 });
    expect(media.deleteRoom.mock.invocationCallOrder[0]).toBeLessThan(db.liveStream.update.mock.invocationCallOrder[0]!);
  });
  it('does not advertise a broadcaster without connected tracks as live content', async () => {
    const { service, media } = fixture();
    media.presence.mockResolvedValue({ viewerCount: 3, publisherConnected: false, publisherHasTracks: false });
    expect((await service.list({})).items).toEqual([]);
  });
  it('reports unknown counts during media outages instead of inventing zero viewers', async () => {
    const { service, media } = fixture(); media.rooms.mockRejectedValue(new Error('unreachable'));
    expect(await service.get(streamId)).toMatchObject({ viewerCount: null, mediaAvailable: false, publisherConnected: false });
    expect((await service.list({})).items).toEqual([]);
    await expect(service.hostToken(streamId, ownerId)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('expires vanished live rooms while allowing a just-reserved room to finish creation', async () => {
    const vanished = fixture(); vanished.media.rooms.mockResolvedValue(new Set());
    expect((await vanished.service.get(streamId)).status).toBe('ENDED');
    const reserving = fixture(record('SCHEDULED')); reserving.media.rooms.mockResolvedValue(new Set());
    expect((await reserving.service.get(streamId)).status).toBe('SCHEDULED'); expect(reserving.db.liveStream.update).not.toHaveBeenCalled();
  });
  it('stops an inactive creator room and refuses additional viewer credentials', async () => {
    const inactive = record(); inactive.creator.status = 'SUSPENDED'; const { service, media, db } = fixture(inactive);
    await expect(service.viewerToken(streamId)).rejects.toBeInstanceOf(NotFoundException);
    expect(media.deleteRoom).toHaveBeenCalledWith(inactive.livekitRoom); expect(db.liveStream.update).toHaveBeenCalled(); expect(media.token).not.toHaveBeenCalled();
  });
  it('reserves a room as scheduled and supplies publishing access to its creator only', async () => {
    const { service, media, db } = fixture(record('SCHEDULED')); db.liveStream.findFirst.mockResolvedValue(null);
    const result = await service.create(ownerId, { title: '  First live  ', category: 'chat' });
    expect(result.stream.status).toBe('SCHEDULED');
    expect(db.liveStream.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: 'First live', creatorId: ownerId, status: 'SCHEDULED' }) }));
    expect(media.token).toHaveBeenCalledWith('livestar-test-room', ownerId, 'Broadcaster', true);
  });
  it('cleans up failed media reservations instead of leaving an unusable open stream', async () => {
    const { service, media, db } = fixture(record('SCHEDULED')); db.liveStream.findFirst.mockResolvedValue(null);
    media.createRoom.mockRejectedValue(new Error('unreachable'));
    await expect(service.create(ownerId, { title: 'Broadcast' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(media.deleteRoom).toHaveBeenCalled(); expect(db.liveStream.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ENDED' }) }));
    expect(media.token).not.toHaveBeenCalled();
  });
  it('rejects blank titles and a second active stream before allocating a media room', async () => {
    const { service, media, db } = fixture();
    await expect(service.create(ownerId, { title: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.liveStream.create).not.toHaveBeenCalled();
    await expect(service.create(ownerId, { title: 'Second room' })).rejects.toBeInstanceOf(ConflictException);
    expect(media.createRoom).not.toHaveBeenCalled();
  });
});
