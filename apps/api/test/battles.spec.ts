import 'reflect-metadata';
import { ConflictException, ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@livestar/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BattlesService } from '../src/battles/battles.service';
import { DatabaseService } from '../src/database.service';
import { LiveKitService } from '../src/streams/livekit.service';
import { StreamsService } from '../src/streams/streams.service';

const hostId = '11111111-1111-4111-8111-111111111111';
const guestId = '22222222-2222-4222-8222-222222222222';
const hostStreamId = '33333333-3333-4333-8333-333333333333';
const guestStreamId = '44444444-4444-4444-8444-444444444444';
const battleId = '55555555-5555-4555-8555-555555555555';
const idempotencyKey = 'ABCD1111-6666-4666-8666-666666666666';
const now = new Date('2026-11-16T10:00:00Z');
const host = { streamId: hostStreamId, userId: hostId, title: 'Host live', username: 'host', displayName: 'Host' };
const guest = { streamId: guestStreamId, userId: guestId, title: 'Guest live', username: 'guest', displayName: 'Guest' };
const row = {
  id: battleId, status: 'ACTIVE', inviterId: hostId, host, guest, startsAt: now,
  endsAt: new Date('2026-11-16T10:05:00Z'), invitationExpiresAt: new Date('2026-11-16T10:01:00Z'),
  durationSeconds: 300, hostScore: '9007199254740993', guestScore: '2',
  winnerStreamId: null, finishReason: null, settledAt: null, createdAt: now, serverNow: now,
};
const identity = {
  id: battleId, status: 'INVITED', hostStreamId, guestStreamId, hostUserId: hostId, guestUserId: guestId,
  invitationExpiresAt: new Date('2026-11-16T10:01:00Z'), serverNow: now,
};
const streamRows = [
  { id: hostStreamId, creatorId: hostId, status: 'LIVE', creatorStatus: 'ACTIVE', deletedAt: null, livekitRoom: 'host-room', serverNow: now },
  { id: guestStreamId, creatorId: guestId, status: 'LIVE', creatorStatus: 'ACTIVE', deletedAt: null, livekitRoom: 'guest-room', serverNow: now },
];
function fixture() {
  const query = vi.fn();
  const media = { configured: vi.fn().mockReturnValue(true), presence: vi.fn().mockResolvedValue({ publisherConnected: true, publisherHasTracks: true }) };
  const streams = { list: vi.fn().mockResolvedValue({ items: [] }) };
  const service = new BattlesService({ $queryRaw: query } as unknown as DatabaseService, media as unknown as LiveKitService, streams as unknown as StreamsService);
  return { service, query, media, streams };
}
function sqlError(state: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed.', { code: 'P2010', clientVersion: 'test', meta: { code: state, message } });
}
function taggedValues(call: unknown[]) { return call.slice(1); }

describe('PK battle and authenticated likes database boundary', () => {
  it('measures both publishers before atomically inviting for the fixed duration', async () => {
    const { service, query, media } = fixture();
    query.mockResolvedValueOnce([]).mockResolvedValueOnce(streamRows)
      .mockResolvedValueOnce([{ id: battleId, host_stream_id: hostStreamId }])
      .mockResolvedValueOnce([row]).mockResolvedValueOnce([row]);
    const result = await service.invite(hostId, hostStreamId, { opponentStreamId: guestStreamId, idempotencyKey });
    expect(media.presence).toHaveBeenCalledWith('host-room', hostId);
    expect(media.presence).toHaveBeenCalledWith('guest-room', guestId);
    expect(media.presence.mock.invocationCallOrder.at(-1)).toBeLessThan(query.mock.invocationCallOrder[2]!);
    expect(taggedValues(query.mock.calls[2]!)).toEqual([hostId, hostStreamId, guestStreamId, idempotencyKey.toLowerCase()]);
    expect(query.mock.calls[2]![0].join('')).toContain('::uuid, 300)');
    expect(result.battle).toMatchObject({ hostScore: '9007199254740993', durationSeconds: 300, startsAt: now.toISOString() });
    expect(result.serverNow).toBe(now.toISOString());
  });

  it('replays the original invitation without requiring media to remain online', async () => {
    const { service, query, media } = fixture();
    const terminal = { ...row, status: 'FINISHED', winnerStreamId: hostStreamId, finishReason: 'TIMEOUT', settledAt: now };
    query.mockResolvedValueOnce([{ id: battleId }]).mockResolvedValueOnce([{ id: battleId, host_stream_id: hostStreamId }])
      .mockResolvedValueOnce([{ ...row, id: 'newer-battle' }]).mockResolvedValueOnce([terminal]);
    const result = await service.invite(hostId, hostStreamId, { opponentStreamId: guestStreamId, idempotencyKey });
    expect(media.presence).not.toHaveBeenCalled();
    expect(result.battle?.id).toBe(battleId); expect(result.battle?.status).toBe('FINISHED');
    expect((query.mock.calls[3]![0] as Prisma.Sql).values).toEqual([battleId]);
  });

  it('refuses self battles and another broadcaster before any media call', async () => {
    const own = fixture();
    await expect(own.service.invite(hostId, hostStreamId, { opponentStreamId: hostStreamId, idempotencyKey })).rejects.toBeInstanceOf(ForbiddenException);
    expect(own.query).not.toHaveBeenCalled();
    const other = fixture(); other.query.mockResolvedValueOnce([]).mockResolvedValueOnce(streamRows);
    await expect(other.service.invite(guestId, hostStreamId, { opponentStreamId: guestStreamId, idempotencyKey })).rejects.toBeInstanceOf(ForbiddenException);
    expect(other.media.presence).not.toHaveBeenCalled();
  });

  it('rejects missing publisher tracks and distinguishes a media outage', async () => {
    const missing = fixture(); missing.query.mockResolvedValueOnce([]).mockResolvedValueOnce(streamRows);
    missing.media.presence.mockResolvedValue({ publisherHasTracks: false });
    await expect(missing.service.invite(hostId, hostStreamId, { opponentStreamId: guestStreamId, idempotencyKey })).rejects.toBeInstanceOf(ConflictException);
    expect(missing.query).toHaveBeenCalledTimes(2);
    const outage = fixture(); outage.query.mockResolvedValueOnce([]).mockResolvedValueOnce(streamRows);
    outage.media.presence.mockRejectedValue(new Error('offline'));
    await expect(outage.service.invite(hostId, hostStreamId, { opponentStreamId: guestStreamId, idempotencyKey })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(outage.query).toHaveBeenCalledTimes(2);
  });

  it('accepts only the invited broadcaster after rechecking both publishers', async () => {
    const { service, query, media } = fixture();
    query.mockResolvedValueOnce([identity]).mockResolvedValueOnce(streamRows)
      .mockResolvedValueOnce([{ id: battleId, host_stream_id: hostStreamId }]).mockResolvedValueOnce([row]).mockResolvedValueOnce([row]);
    await service.respond(guestId, battleId, 'ACCEPT');
    expect(media.presence).toHaveBeenCalledTimes(2);
    expect(taggedValues(query.mock.calls[2]!)).toEqual([guestId, battleId, 'ACCEPT']);
    const wrong = fixture(); wrong.query.mockResolvedValue([identity]);
    await expect(wrong.service.respond(hostId, battleId, 'ACCEPT')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(wrong.service.respond(hostId, battleId, 'DECLINE')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(wrong.service.respond(guestId, battleId, 'CANCEL')).rejects.toBeInstanceOf(ForbiddenException);
    expect(wrong.media.presence).not.toHaveBeenCalled();
  });

  it('does not perform media I/O when retrying a terminal action or leaving', async () => {
    const { service, query, media } = fixture();
    query.mockResolvedValueOnce([{ ...identity, status: 'FINISHED' }])
      .mockResolvedValueOnce([{ id: battleId, host_stream_id: hostStreamId }]).mockResolvedValueOnce([row]).mockResolvedValueOnce([row]);
    await service.respond(hostId, battleId, 'LEAVE');
    expect(media.presence).not.toHaveBeenCalled();
    expect(taggedValues(query.mock.calls[1]!)).toEqual([hostId, battleId, 'LEAVE']);
  });

  it('returns null with database server time when a real stream has no battle', async () => {
    const { service, query } = fixture(); query.mockResolvedValueOnce([streamRows[0]]).mockResolvedValueOnce([]);
    expect(await service.snapshot(hostStreamId)).toEqual({ battle: null, serverNow: now.toISOString() });
  });

  it('returns only the authenticated broadcaster’s incoming, refreshed invitations', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([{ streamId: guestStreamId }, { streamId: hostStreamId }])
      .mockResolvedValueOnce([{ ...row, status: 'INVITED' }]).mockResolvedValueOnce([{ ...row, status: 'CANCELED' }]);
    const result = await service.invitations(guestId);
    expect(result.items).toHaveLength(1); expect(result.items[0]?.guest.userId).toBe(guestId);
    expect(taggedValues(query.mock.calls[0]!)).toEqual([guestId]);
    expect((query.mock.calls[1]![0] as Prisma.Sql).sql).toContain('pk_snapshot');
  });

  it('excludes yourself and either-direction blocked accounts from actual live candidates', async () => {
    const { service, query, streams } = fixture();
    streams.list.mockResolvedValue({ items: [
      { id: hostStreamId, creator: { id: hostId } }, { id: guestStreamId, creator: { id: guestId } },
      { id: battleId, creator: { id: 'other' } },
    ] });
    query.mockResolvedValue([{ userId: guestId }]);
    expect((await service.candidates(hostId)).items).toEqual([{ id: battleId, creator: { id: 'other' } }]);
  });

  it('keeps real like totals exact and delegates one authenticated idempotent batch', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([{ total: '9007199254740993', serverNow: now }])
      .mockResolvedValueOnce([{ total: '9007199254741013', count: 20, serverNow: now }]);
    expect(await service.likes(hostStreamId)).toEqual({ total: '9007199254740993', serverNow: now.toISOString() });
    expect(await service.sendLikes(guestId, hostStreamId, { count: 20, idempotencyKey })).toEqual({ total: '9007199254741013', acceptedCount: 20, serverNow: now.toISOString() });
    expect(taggedValues(query.mock.calls[1]!)).toEqual([guestId, hostStreamId, 20, idempotencyKey.toLowerCase()]);
    expect(query.mock.calls[1]![0].join('')).toContain('public.stream_send_likes(');
  });

  it.each([
    ['PK_BUSY', 409], ['PK_BLOCKED', 403], ['PK_IDEMPOTENCY_CONFLICT', 409],
    ['LIKES_INVALID_REQUEST', 400], ['LIKES_IDEMPOTENCY_CONFLICT', 409], ['LIKES_ACCOUNT_UNAVAILABLE', 403],
    ['LIKES_STREAM_UNAVAILABLE', 404], ['LIKES_BLOCKED', 403], ['LIKES_RATE_LIMITED', 429],
  ])('maps only exact tagged domain errors: %s', async (code, status) => {
    const { service, query } = fixture(); query.mockRejectedValueOnce(sqlError('23514', `ERROR: ${code}\nCONTEXT: private SQL`));
    const error = await service.sendLikes(guestId, hostStreamId, { count: 1, idempotencyKey }).catch(error => error) as HttpException;
    expect(error.getStatus()).toBe(status); expect(error.getResponse()).toMatchObject({ code });
    expect(JSON.stringify(error.getResponse())).not.toContain('private SQL');
  });

  it.each([
    ['23505', 'LIKES_RATE_LIMITED'], ['23514', 'unexpected failure mentions PK_BUSY'], ['23514', 'PK_UNKNOWN'], ['42501', 'PK_FORBIDDEN'],
  ])('preserves unexpected database errors (%s/%s)', async (state, message) => {
    const { service, query } = fixture(); const error = sqlError(state, message); query.mockRejectedValueOnce(error);
    await expect(service.sendLikes(guestId, hostStreamId, { count: 1, idempotencyKey })).rejects.toBe(error);
  });
});

describe('PK publisher disconnect reconciliation', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function presenceFixture() {
    const { service, query, media } = fixture();
    let elapsed = 0;
    let current = { ...row, settledAt: null as Date | null };
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    query.mockImplementation(async (statement: Prisma.Sql | TemplateStringsArray) => {
      const sql = 'sql' in statement ? statement.sql : statement.join('');
      if (sql.includes('pk_snapshot')) return [{ ...current, serverNow: new Date(now.getTime() + elapsed) }];
      if (sql.includes('pk_settle_absent')) {
        current = { ...current, status: 'FINISHED', settledAt: new Date(now.getTime() + elapsed) };
        return [{}];
      }
      if (sql.includes('FROM public.live_streams s JOIN')) {
        return streamRows.map(stream => ({ ...stream, serverNow: new Date(now.getTime() + elapsed) }));
      }
      throw new Error('Unexpected presence test query: ' + sql);
    });
    const advance = (milliseconds: number) => { elapsed += milliseconds; clock.mockReturnValue(elapsed); };
    const settleCalls = () => query.mock.calls.filter(([statement]) => {
      const sql = 'sql' in statement ? statement.sql : statement.join('');
      return sql.includes('pk_settle_absent');
    });
    return { service, query, media, advance, settleCalls };
  }

  it('gives a missing publisher 15 seconds to reconnect before forfeiting the observed battle', async () => {
    const { service, media, advance, settleCalls } = presenceFixture();
    media.presence.mockImplementation(async room => ({ publisherConnected: room !== 'guest-room', publisherHasTracks: room !== 'guest-room' }));
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('ACTIVE');
    advance(12_000);
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('ACTIVE');
    expect(settleCalls()).toHaveLength(0);
    advance(3_000);
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('FINISHED');
    expect(settleCalls()).toHaveLength(1);
    expect(taggedValues(settleCalls()[0]!)).toEqual([battleId, [guestStreamId]]);
  });

  it('clears a prior absence when the publisher reconnects', async () => {
    const { service, media, advance, settleCalls } = presenceFixture();
    media.presence.mockResolvedValue({ publisherConnected: false, publisherHasTracks: false });
    await service.snapshot(hostStreamId);
    advance(12_000);
    media.presence.mockResolvedValue({ publisherConnected: true, publisherHasTracks: true });
    await service.snapshot(hostStreamId);
    advance(3_000);
    media.presence.mockResolvedValue({ publisherConnected: false, publisherHasTracks: false });
    await service.snapshot(hostStreamId);
    advance(12_000);
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('ACTIVE');
    expect(settleCalls()).toHaveLength(0);
  });

  it('keeps a connected publisher in the battle when all their tracks are muted', async () => {
    const { service, media, advance, settleCalls } = presenceFixture();
    media.presence.mockResolvedValue({ publisherConnected: true, publisherHasTracks: false });
    await service.snapshot(hostStreamId);
    advance(20_000);
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('ACTIVE');
    expect(settleCalls()).toHaveLength(0);
  });

  it('resets confirmed absence after a media provider error and never treats an outage as a forfeit', async () => {
    const { service, media, advance, settleCalls } = presenceFixture();
    media.presence.mockResolvedValue({ publisherConnected: false, publisherHasTracks: false });
    await service.snapshot(hostStreamId);
    advance(12_000);
    media.presence.mockRejectedValue(new Error('provider unavailable'));
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('ACTIVE');
    advance(3_000);
    media.presence.mockResolvedValue({ publisherConnected: false, publisherHasTracks: false });
    await service.snapshot(hostStreamId);
    advance(12_000);
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('ACTIVE');
    expect(settleCalls()).toHaveLength(0);
    advance(3_000);
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('FINISHED');
  });

  it('settles both missing publishers together so neither receives a forfeit win', async () => {
    const { service, media, advance, settleCalls } = presenceFixture();
    media.presence.mockResolvedValue({ publisherConnected: false, publisherHasTracks: false });
    await service.snapshot(hostStreamId);
    advance(15_000);
    await service.snapshot(hostStreamId);
    expect(settleCalls()).toHaveLength(1);
    expect(taggedValues(settleCalls()[0]!)).toEqual([battleId, [hostStreamId, guestStreamId]]);
  });

  it('treats a confirmed missing media room as publisher absence', async () => {
    const { service, media, advance, settleCalls } = presenceFixture();
    media.presence.mockRejectedValue(Object.assign(new Error('Room not found'), { code: 'not_found' }));
    await service.snapshot(hostStreamId);
    advance(15_000);
    expect((await service.snapshot(hostStreamId)).battle?.status).toBe('FINISHED');
    expect(settleCalls()).toHaveLength(1);
  });

  it('shares concurrent media measurements and caches them for two seconds', async () => {
    const { service, media, advance } = presenceFixture();
    await Promise.all([service.snapshot(hostStreamId), service.snapshot(guestStreamId)]);
    expect(media.presence).toHaveBeenCalledTimes(2);
    await service.snapshot(hostStreamId);
    expect(media.presence).toHaveBeenCalledTimes(2);
    advance(2_001);
    await service.snapshot(hostStreamId);
    expect(media.presence).toHaveBeenCalledTimes(4);
  });
});
