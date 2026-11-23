import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@livestar/database';
import { describe, expect, it, vi } from 'vitest';
import { AdminService, suspensionStreamRequestKey } from '../src/admin/admin.service';
import { DatabaseService } from '../src/database.service';
import { LiveKitService } from '../src/streams/livekit.service';

const actorId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const streamId = '20000000-0000-4000-8000-000000000001';
const otherStreamId = '20000000-0000-4000-8000-000000000002';
const requestId = '30000000-0000-4000-8000-000000000001';
const at = new Date('2026-11-23T12:00:00.000Z');
const input = { reason: 'Reviewed community guideline violation.', idempotencyKey: requestId };

function identity(id = userId) {
  return { id, status: 'ACTIVE', deletedAt: null as Date | null, profile: { username: 'member', displayName: 'Member' }, email: 'private@example.invalid', passwordHash: 'never-return' };
}
function stream(id = streamId, status = 'LIVE') {
  return { id, creatorId: userId, livekitRoom: `private-room-${id}`, title: 'A broadcast', status, createdAt: at, startedAt: status === 'SCHEDULED' ? null : at, endedAt: ['ENDED', 'TERMINATED'].includes(status) ? at : null, creator: identity() };
}
function mutationStream(status = 'LIVE', id = streamId) {
  return { id, creator_id: userId, livekit_room: `private-room-${id}`, status };
}
function sqlError(message: string, state = '23514') {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed.', { code: 'P2010', clientVersion: 'test', meta: { code: state, message } });
}
function fixture() {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]), $transaction: vi.fn(),
    user: { findMany: vi.fn().mockResolvedValue([]) },
    liveStream: { findMany: vi.fn().mockResolvedValue([]) },
    report: { findMany: vi.fn().mockResolvedValue([]) },
    adminAuditLog: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const media = { configured: vi.fn().mockReturnValue(true), presence: vi.fn().mockResolvedValue({ viewerCount: 7, publisherConnected: true, publisherHasTracks: true }), deleteRoom: vi.fn().mockResolvedValue(undefined) };
  return { db, media, service: new AdminService(db as unknown as DatabaseService, media as unknown as LiveKitService) };
}

describe('administration read boundaries', () => {
  it('retains exact DU totals and labels stored sessions separately from media presence', async () => {
    const { db, media, service } = fixture();
    const row = { users: { total: 9, active: 8, suspended: 1, newLast7Days: 2 }, streams: { liveSessions: 3, scheduledSessions: 2 }, reports: { open: 2, reviewing: 1 }, gifts: { sentCount: 4, spentDu: '900719925474099312345', claimedDu: '900719925474099399999' }, dailyRegistrations: [{ date: '2026-11-23', count: 2 }], serverNow: at };
    db.$queryRaw.mockResolvedValue([row]);
    expect(await service.overview()).toEqual({ ...row, serverNow: at.toISOString() });
    expect(media.presence).not.toHaveBeenCalled();
    expect(db.$queryRaw.mock.calls[0]?.[0].join('')).toContain('clock_timestamp()');
  });

  it('does not invent a successful empty overview if statistics are unavailable', async () => {
    const { service } = fixture();
    await expect(service.overview()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('uses bounded cursor pagination and returns only the staff user projection', async () => {
    const { db, service } = fixture();
    const user = { ...identity(), createdAt: at, roles: [{ role: { name: 'USER' } }], _count: { streams: 2 }, birthDate: '2000-01-01', refreshTokens: ['never-return'] };
    db.user.findMany.mockResolvedValue([user, { ...user, id: actorId }]);
    expect(await service.users({ limit: 1, cursor: requestId.toUpperCase(), query: 'member', status: 'ACTIVE' })).toEqual({ items: [{ id: userId, email: 'private@example.invalid', username: 'member', displayName: 'Member', status: 'ACTIVE', createdAt: at.toISOString(), roles: ['USER'], openStreamCount: 2 }], nextCursor: userId });
    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { gt: requestId }, status: 'ACTIVE', deletedAt: null, OR: expect.any(Array) }), orderBy: { id: 'asc' }, take: 2 }));
    const select = db.user.findMany.mock.calls[0]?.[0].select;
    expect(select).not.toHaveProperty('passwordHash');
    expect(select).not.toHaveProperty('birthDate');
    expect(select).not.toHaveProperty('refreshTokens');
  });

  it('excludes deleted accounts and uses a fixed maximum default page for users', async () => {
    const { db, service } = fixture();
    expect(await service.users({})).toEqual({ items: [], nextCursor: null });
    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { in: ['ACTIVE', 'SUSPENDED'] }, deletedAt: null }, take: 21 }));
  });

  it('measures actual presence only for visible open streams and omits provider room names and private creator fields', async () => {
    const { db, media, service } = fixture();
    db.liveStream.findMany.mockResolvedValue([stream(), stream(otherStreamId)]);
    media.presence.mockResolvedValue({ viewerCount: 7, publisherConnected: true, publisherHasTracks: false });
    const result = await service.streams({ limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({ id: streamId, title: 'A broadcast', status: 'LIVE', createdAt: at.toISOString(), startedAt: at.toISOString(), endedAt: null, creator: { id: userId, username: 'member', displayName: 'Member' }, viewerCount: 7, mediaStatus: 'publishing' });
    expect(result.nextCursor).toBe(streamId);
    expect(media.presence).toHaveBeenCalledExactlyOnceWith(`private-room-${streamId}`, userId);
    expect(db.liveStream.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, orderBy: { id: 'asc' } }));
  });

  it('keeps unknown viewer counts during provider outages rather than reporting zero', async () => {
    const { db, media, service } = fixture();
    db.liveStream.findMany.mockResolvedValue([stream()]);
    media.presence.mockRejectedValue(new Error('provider credentials and internal URL must not leak'));
    expect((await service.streams({})).items[0]).toMatchObject({ viewerCount: null, mediaStatus: 'unknown' });
    media.configured.mockReturnValue(false);
    media.presence.mockClear();
    expect((await service.streams({})).items[0]).toMatchObject({ viewerCount: null, mediaStatus: 'unknown' });
    expect(media.presence).not.toHaveBeenCalled();
  });

  it.each([{ code: 'not_found' }, { status: 404 }, { statusCode: 404 }])('recognizes a missing provider room as offline: %j', async error => {
    const { db, media, service } = fixture();
    db.liveStream.findMany.mockResolvedValue([stream()]); media.presence.mockRejectedValue(error);
    expect((await service.streams({})).items[0]).toMatchObject({ viewerCount: 0, mediaStatus: 'offline' });
  });

  it('does not query media for terminal streams or expose a deleted creator identity', async () => {
    const { db, media, service } = fixture();
    const row = stream(streamId, 'TERMINATED'); row.creator.status = 'DELETED'; row.creator.deletedAt = at;
    db.liveStream.findMany.mockResolvedValue([row]);
    expect((await service.streams({ status: 'TERMINATED' })).items[0]).toMatchObject({ status: 'TERMINATED', viewerCount: null, mediaStatus: 'offline', creator: { id: userId, username: null, displayName: 'Deleted account' } });
    expect(media.presence).not.toHaveBeenCalled();
  });

  it('returns report evidence and public identities while removing deleted identities and credentials', async () => {
    const { db, service } = fixture();
    const target = identity(); target.status = 'DELETION_PENDING';
    db.report.findMany.mockResolvedValue([{ id: requestId, status: 'OPEN', reasonCode: 'HARASSMENT', details: 'Reported content', createdAt: at, resolvedAt: null, reporter: identity(actorId), targetUser: target, stream: { id: streamId, title: 'A broadcast', status: 'LIVE', livekitRoom: 'must-not-leak' }, privateNote: 'must-not-leak' }]);
    expect(await service.reports({ status: 'OPEN', limit: 2, cursor: requestId.toUpperCase() })).toEqual({ items: [{ id: requestId, status: 'OPEN', reasonCode: 'HARASSMENT', details: 'Reported content', createdAt: at.toISOString(), resolvedAt: null, reporter: { id: actorId, username: 'member', displayName: 'Member' }, target: { id: userId, username: null, displayName: 'Deleted account' }, stream: { id: streamId, title: 'A broadcast', status: 'LIVE' } }], nextCursor: null });
    expect(db.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'OPEN', id: { gt: requestId } }, take: 3 }));
  });

  it('restricts audit queries and recursively drops non-administration payload fields', async () => {
    const { db, service } = fixture();
    db.adminAuditLog.findMany.mockResolvedValue([{ id: requestId, action: 'ADMIN_ACCOUNT_STATUS_CHANGED', entityType: 'user', entityId: userId, requestId, createdAt: at, actor: identity(actorId), before: { status: 'ACTIVE', passwordHash: 'secret', email: 'private' }, after: { status: 'SUSPENDED', reason: 'Staff evidence', request: { operation: 'suspend', body: { reason: 'Review completed', apiSecret: 'secret', profile: { birthDate: 'private' } }, sessionToken: 'secret' }, roles: Array.from({ length: 60 }, () => 'USER'), unknownFinancialData: { balance: '100' } } }]);
    const result = await service.audit({ cursor: requestId.toUpperCase() });
    expect(result.items[0]).toMatchObject({ before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED', reason: 'Staff evidence', request: { operation: 'suspend', body: { reason: 'Review completed' } }, roles: Array.from({ length: 50 }, () => 'USER') }, actor: { id: actorId, username: 'member', displayName: 'Member' } });
    const serialized = JSON.stringify(result);
    for (const privateField of ['passwordHash', 'private@example', 'birthDate', 'apiSecret', 'sessionToken', 'unknownFinancialData']) expect(serialized).not.toContain(privateField);
    expect(db.adminAuditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { action: { startsWith: 'ADMIN_' }, id: { gt: requestId } }, take: 21 }));
  });
});

describe('durable administrative termination', () => {
  it('binds the request before provider I/O, settles PK without a transaction, and finalizes only afterward', async () => {
    const { db, media, service } = fixture();
    const events: string[] = [];
    db.$queryRaw.mockImplementation(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?');
      if (sql.includes('pk_settle_stream')) { events.push('settle'); return []; }
      if (sql.includes(',false)')) { events.push('reserve'); return [mutationStream()]; }
      events.push('finalize'); return [mutationStream('TERMINATED')];
    });
    media.deleteRoom.mockImplementation(async () => { events.push('delete-room'); });
    expect(await service.terminateStream(actorId, streamId, input)).toEqual({ stream: { id: streamId, status: 'TERMINATED' } });
    expect(events).toEqual(['reserve', 'delete-room', 'settle', 'finalize']);
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual([actorId, streamId, input.reason, requestId]);
    expect(db.$queryRaw.mock.calls[2]?.slice(1)).toEqual([actorId, streamId, input.reason, requestId]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('leaves a durable pending request on provider failure and retries it using the same key', async () => {
    const { db, media, service } = fixture();
    db.$queryRaw.mockResolvedValue([mutationStream()]); media.deleteRoom.mockRejectedValueOnce(new Error('provider secret'));
    await expect(service.terminateStream(actorId, streamId, input)).rejects.toMatchObject({ status: 503, response: { code: 'ADMIN_MEDIA_UNAVAILABLE' } });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.calls[0]?.[0].join('')).toContain(',false)');
    db.$queryRaw.mockResolvedValueOnce([mutationStream()]).mockResolvedValueOnce([]).mockResolvedValueOnce([mutationStream('TERMINATED')]);
    expect(await service.terminateStream(actorId, streamId, input)).toEqual({ stream: { id: streamId, status: 'TERMINATED' } });
    expect(media.deleteRoom).toHaveBeenCalledTimes(2);
    expect(db.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('reserves before reporting missing media configuration and never claims a final status', async () => {
    const { db, media, service } = fixture();
    db.$queryRaw.mockResolvedValue([mutationStream()]); media.configured.mockReturnValue(false);
    await expect(service.terminateStream(actorId, streamId, input)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1); expect(media.deleteRoom).not.toHaveBeenCalled();
  });

  it('does not repeat media calls or audit finalization for an already terminated replay', async () => {
    const { db, media, service } = fixture(); db.$queryRaw.mockResolvedValue([mutationStream('TERMINATED')]);
    expect(await service.terminateStream(actorId, streamId, input)).toEqual({ stream: { id: streamId, status: 'TERMINATED' } });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1); expect(media.deleteRoom).not.toHaveBeenCalled();
  });

  it('rejects a key reserved for another target before it can delete the wrong room', async () => {
    const { db, media, service } = fixture(); db.$queryRaw.mockRejectedValue(sqlError('ADMIN_IDEMPOTENCY_CONFLICT'));
    await expect(service.terminateStream(actorId, otherStreamId, input)).rejects.toMatchObject({ status: 409, response: { code: 'ADMIN_IDEMPOTENCY_CONFLICT' } });
    expect(media.configured).not.toHaveBeenCalled(); expect(media.deleteRoom).not.toHaveBeenCalled();
  });

  it('does not finalize if PK settlement fails after the room has stopped', async () => {
    const { db, media, service } = fixture(); const failure = new Error('settlement unavailable');
    db.$queryRaw.mockResolvedValueOnce([mutationStream()]).mockRejectedValueOnce(failure);
    await expect(service.terminateStream(actorId, streamId, input)).rejects.toBe(failure);
    expect(media.deleteRoom).toHaveBeenCalledOnce(); expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('honors fresh database permission checks at finalization after provider I/O', async () => {
    const { db, media, service } = fixture();
    db.$queryRaw.mockResolvedValueOnce([mutationStream()]).mockResolvedValueOnce([]).mockRejectedValueOnce(sqlError('ADMIN_FORBIDDEN'));
    await expect(service.terminateStream(actorId, streamId, input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(media.deleteRoom).toHaveBeenCalledOnce(); expect(db.$queryRaw).toHaveBeenCalledTimes(3);
  });
});

describe('atomic account changes and suspension cleanup', () => {
  it('uses separate stable UUID request keys for every suspension and room', () => {
    const key = suspensionStreamRequestKey(requestId, streamId);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(suspensionStreamRequestKey(requestId.toUpperCase(), streamId.toUpperCase())).toBe(key);
    expect(suspensionStreamRequestKey(requestId, otherStreamId)).not.toBe(key);
    expect(suspensionStreamRequestKey(actorId, streamId)).not.toBe(key);
  });

  it('commits suspension before attempting rooms and accurately reports pending cleanup on failure', async () => {
    const { db, media, service } = fixture();
    db.$queryRaw.mockResolvedValueOnce([{ id: userId, status: 'SUSPENDED' }]).mockResolvedValueOnce([mutationStream()]);
    db.liveStream.findMany.mockResolvedValue([{ id: streamId }]); media.deleteRoom.mockRejectedValue(new Error('outage'));
    expect(await service.setUserStatus(actorId, userId, 'SUSPENDED', input)).toEqual({ user: { id: userId, status: 'SUSPENDED' }, mediaCleanup: { complete: false, pendingStreamIds: [streamId] } });
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual([actorId, userId, 'SUSPENDED', input.reason, requestId]);
    expect(db.$queryRaw.mock.calls[1]?.slice(1)).toEqual([actorId, streamId, input.reason, suspensionStreamRequestKey(requestId, streamId)]);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(media.deleteRoom.mock.invocationCallOrder[0]!);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('rechecks all remaining rooms after partial cleanup rather than trusting individual stop responses', async () => {
    const { db, service } = fixture(); db.$queryRaw.mockResolvedValue([{ id: userId, status: 'SUSPENDED' }]);
    db.liveStream.findMany.mockResolvedValueOnce([{ id: streamId }, { id: otherStreamId }]).mockResolvedValueOnce([{ id: otherStreamId }]);
    const terminate = vi.spyOn(service, 'terminateStream').mockResolvedValueOnce({ stream: { id: streamId, status: 'TERMINATED' } }).mockRejectedValueOnce(new ServiceUnavailableException());
    expect(await service.setUserStatus(actorId, userId, 'SUSPENDED', input)).toMatchObject({ mediaCleanup: { complete: false, pendingStreamIds: [otherStreamId] } });
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenNthCalledWith(2, actorId, otherStreamId, { reason: input.reason, idempotencyKey: suspensionStreamRequestKey(requestId, otherStreamId) });
  });

  it('does not stop newly authorized rooms when an old suspension key is replayed after restore', async () => {
    const { db, media, service } = fixture(); db.$queryRaw.mockResolvedValue([{ id: userId, status: 'ACTIVE' }]);
    expect(await service.setUserStatus(actorId, userId, 'SUSPENDED', input)).toEqual({ user: { id: userId, status: 'ACTIVE' }, mediaCleanup: { complete: true, pendingStreamIds: [] } });
    expect(db.liveStream.findMany).not.toHaveBeenCalled(); expect(media.deleteRoom).not.toHaveBeenCalled();
  });

  it('returns a completed restoration only after the database accepted its atomic transition', async () => {
    const { db, media, service } = fixture(); db.$queryRaw.mockResolvedValue([{ id: userId, status: 'ACTIVE' }]);
    expect(await service.setUserStatus(actorId, userId, 'ACTIVE', input)).toEqual({ user: { id: userId, status: 'ACTIVE' }, mediaCleanup: { complete: true, pendingStreamIds: [] } });
    expect(media.deleteRoom).not.toHaveBeenCalled();
    db.$queryRaw.mockRejectedValueOnce(sqlError('ADMIN_STATE_CONFLICT'));
    await expect(service.setUserStatus(actorId, userId, 'ACTIVE', input)).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not let a stale restore request clean up a later suspension as a new mutation', async () => {
    const { db, media, service } = fixture(); db.$queryRaw.mockResolvedValue([{ id: userId, status: 'SUSPENDED' }]);
    db.liveStream.findMany.mockResolvedValue([{ id: streamId }]);
    expect(await service.setUserStatus(actorId, userId, 'ACTIVE', input)).toMatchObject({ user: { status: 'SUSPENDED' }, mediaCleanup: { complete: false, pendingStreamIds: [streamId] } });
    expect(media.deleteRoom).not.toHaveBeenCalled();
  });
});

describe('report decisions and safe database errors', () => {
  it('reviews a report using the authenticated actor and never stops a stream implicitly', async () => {
    const { db, media, service } = fixture(); db.$queryRaw.mockResolvedValue([{ id: requestId, status: 'RESOLVED', resolved_at: at }]);
    expect(await service.reviewReport(actorId, requestId, { ...input, status: 'RESOLVED' })).toEqual({ report: { id: requestId, status: 'RESOLVED', resolvedAt: at.toISOString() } });
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual([actorId, requestId, 'RESOLVED', input.reason, requestId]);
    expect(media.deleteRoom).not.toHaveBeenCalled();
  });

  it.each([
    ['ADMIN_INVALID_REQUEST', BadRequestException], ['ADMIN_FORBIDDEN', ForbiddenException], ['ADMIN_ACCOUNT_UNAVAILABLE', ForbiddenException],
    ['ADMIN_TARGET_UNAVAILABLE', ConflictException], ['ADMIN_TARGET_PROTECTED', ForbiddenException], ['ADMIN_STATE_CONFLICT', ConflictException],
    ['ADMIN_IDEMPOTENCY_CONFLICT', ConflictException], ['ADMIN_NOT_FOUND', NotFoundException], ['ADMIN_TERMINATED_IMMUTABLE', ConflictException],
  ])('maps only the exact database tag %s to its safe HTTP error', async (tag, ErrorClass) => {
    const { db, service } = fixture(); db.$queryRaw.mockRejectedValue(sqlError(`ERROR: ${tag}\nCONTEXT: internal SQL and private data`));
    await expect(service.reviewReport(actorId, requestId, { ...input, status: 'REVIEWING' })).rejects.toBeInstanceOf(ErrorClass);
    await expect(service.setUserStatus(actorId, userId, 'SUSPENDED', input)).rejects.toMatchObject({ response: { code: tag } });
  });

  it('does not reinterpret unrelated SQL errors or strings containing an administration tag', async () => {
    for (const failure of [sqlError('ADMIN_FORBIDDEN', '42501'), sqlError('some query failed: ADMIN_FORBIDDEN'), new Error('ADMIN_FORBIDDEN')]) {
      const { db, service } = fixture(); db.$queryRaw.mockRejectedValue(failure);
      await expect(service.reviewReport(actorId, requestId, { ...input, status: 'REVIEWING' })).rejects.toBe(failure);
    }
  });

  it('treats missing RPC rows as not found instead of fabricating successful actions', async () => {
    const { service, media } = fixture();
    await expect(service.setUserStatus(actorId, userId, 'SUSPENDED', input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.terminateStream(actorId, streamId, input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reviewReport(actorId, requestId, { ...input, status: 'DISMISSED' })).rejects.toBeInstanceOf(NotFoundException);
    expect(media.deleteRoom).not.toHaveBeenCalled();
  });
});
