import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@livestar/database';
import { DatabaseService } from '../database.service';
import { LiveKitService } from '../streams/livekit.service';
import { StreamsService } from '../streams/streams.service';
import { BattleInvitationsDto, BattleSnapshotDto, BattleViewDto, InviteBattleDto, LikeMutationDto, LikeTotalDto, SendLikesDto } from './battles.dto';

type BattleAction = 'ACCEPT' | 'DECLINE' | 'CANCEL' | 'LEAVE';
type BattleRow = Omit<BattleViewDto, 'startsAt' | 'endsAt' | 'invitationExpiresAt' | 'settledAt' | 'createdAt' | 'serverNow'> & {
  startsAt: Date | null; endsAt: Date | null; invitationExpiresAt: Date; settledAt: Date | null; createdAt: Date; serverNow: Date;
};
type StreamRow = { id: string; creatorId: string; status: string; creatorStatus: string; deletedAt: Date | null; livekitRoom: string; serverNow: Date };
type BattleIdentityRow = { id: string; hostStreamId: string; guestStreamId: string; hostUserId: string; guestUserId: string; status: string; invitationExpiresAt: Date; serverNow: Date };
type PublisherCheck = { checkedAt: number; absentSince: Map<string, number>; inFlight: Promise<boolean> | null; settled: boolean };

const domainErrors = {
  PK_INVALID_REQUEST: { status: 400, message: 'Invalid PK battle request.' },
  PK_ACCOUNT_UNAVAILABLE: { status: 403, message: 'Your account is unavailable.' },
  PK_STREAM_UNAVAILABLE: { status: 409, message: 'Both broadcasters must be live and publishing before a PK battle can start.' },
  PK_BLOCKED: { status: 403, message: 'PK battles are unavailable between these accounts.' },
  PK_NOT_FOUND: { status: 404, message: 'PK battle not found.' },
  PK_FORBIDDEN: { status: 403, message: 'Only the appropriate broadcaster can perform this action.' },
  PK_BUSY: { status: 409, message: 'A broadcaster already has an active battle or pending invitation.' },
  PK_STATE_CONFLICT: { status: 409, message: 'This PK battle can no longer perform that action.' },
  PK_IDEMPOTENCY_CONFLICT: { status: 409, message: 'This request UUID has already been used for a different invitation.' },
  LIKES_INVALID_REQUEST: { status: 400, message: 'Send an integer batch of 1 to 20 likes with a request UUID.' },
  LIKES_ACCOUNT_UNAVAILABLE: { status: 403, message: 'Your account is unavailable.' },
  LIKES_STREAM_UNAVAILABLE: { status: 404, message: 'This stream is unavailable for likes.' },
  LIKES_BLOCKED: { status: 403, message: 'Likes are unavailable between these accounts.' },
  LIKES_RATE_LIMITED: { status: 429, message: 'You can send up to 120 likes per minute. Try again shortly.' },
  LIKES_IDEMPOTENCY_CONFLICT: { status: 409, message: 'This request UUID has already been used for a different batch of likes.' },
} as const;

// Every BIGINT/numeric score is converted by Postgres, preserving exact values.
const battleColumns = Prisma.sql`
  b.id, b.status::text AS status, b.inviter_id AS "inviterId",
  b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.invitation_expires_at AS "invitationExpiresAt",
  b.duration_seconds AS "durationSeconds", b.winner_stream_id AS "winnerStreamId",
  b.finish_reason AS "finishReason", b.settled_at AS "settledAt", b.created_at AS "createdAt",
  jsonb_build_object('streamId', hs.id, 'userId', b.host_user_id, 'title', hs.title,
    'username', CASE WHEN hu.status = 'ACTIVE' AND hu.deleted_at IS NULL THEN hp.username ELSE NULL END,
    'displayName', CASE WHEN hu.status = 'ACTIVE' AND hu.deleted_at IS NULL THEN COALESCE(hp.display_name, 'LiveStar creator') ELSE 'LiveStar creator' END) AS host,
  jsonb_build_object('streamId', gs.id, 'userId', b.guest_user_id, 'title', gs.title,
    'username', CASE WHEN gu.status = 'ACTIVE' AND gu.deleted_at IS NULL THEN gp.username ELSE NULL END,
    'displayName', CASE WHEN gu.status = 'ACTIVE' AND gu.deleted_at IS NULL THEN COALESCE(gp.display_name, 'LiveStar creator') ELSE 'LiveStar creator' END) AS guest`;
const battleJoins = Prisma.sql`
  JOIN public.live_streams hs ON hs.id = b.host_stream_id
  JOIN public.live_streams gs ON gs.id = b.guest_stream_id
  JOIN public.users hu ON hu.id = b.host_user_id
  JOIN public.users gu ON gu.id = b.guest_user_id
  LEFT JOIN public.user_profiles hp ON hp.user_id = hu.id
  LEFT JOIN public.user_profiles gp ON gp.user_id = gu.id`;

@Injectable()
export class BattlesService {
  private readonly publisherChecks = new Map<string, PublisherCheck>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LiveKitService) private readonly livekit: LiveKitService,
    @Inject(StreamsService) private readonly streams: StreamsService,
  ) {}

  private fail(code: keyof typeof domainErrors): never {
    const detail = domainErrors[code];
    const body = { code, message: detail.message };
    if (detail.status === 400) throw new BadRequestException(body);
    if (detail.status === 403) throw new ForbiddenException(body);
    if (detail.status === 404) throw new NotFoundException(body);
    if (detail.status === 429) throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
    throw new ConflictException(body);
  }

  private databaseError(error: unknown): never {
    // Only exact application tags with the expected SQLSTATE are public.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010' && error.meta?.code === '23514') {
      const message = typeof error.meta.message === 'string' ? error.meta.message.trim() : '';
      const match = /^(?:ERROR:\s*)?((?:PK|LIKES)_[A-Z_]+)(?:\n[^]*)?$/.exec(message);
      const code = match?.[1];
      if (code && Object.hasOwn(domainErrors, code)) this.fail(code as keyof typeof domainErrors);
    }
    throw error;
  }

  private view(row: BattleRow): BattleViewDto {
    return {
      ...row, startsAt: row.startsAt?.toISOString() ?? null, endsAt: row.endsAt?.toISOString() ?? null,
      invitationExpiresAt: row.invitationExpiresAt.toISOString(), settledAt: row.settledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(), serverNow: row.serverNow.toISOString(),
    };
  }

  private async now(): Promise<string> {
    const [row] = await this.database.$queryRaw<{ serverNow: Date }[]>`SELECT clock_timestamp() AS "serverNow"`;
    return row!.serverNow.toISOString();
  }

  private async streamRecords(ids: string[]): Promise<StreamRow[]> {
    return this.database.$queryRaw<StreamRow[]>(Prisma.sql`
      SELECT s.id, s.creator_id AS "creatorId", s.status::text AS status, s.livekit_room AS "livekitRoom",
        u.status::text AS "creatorStatus", u.deleted_at AS "deletedAt", clock_timestamp() AS "serverNow"
      FROM public.live_streams s JOIN public.users u ON u.id = s.creator_id
      WHERE s.id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})`);
  }

  private async publishingPair(hostId: string, guestId: string, actorId: string, accepting: boolean): Promise<void> {
    const records = await this.streamRecords([hostId, guestId]);
    const host = records.find(row => row.id === hostId.toLowerCase());
    const guest = records.find(row => row.id === guestId.toLowerCase());
    if (!host || !guest) this.fail('PK_STREAM_UNAVAILABLE');
    if ((accepting ? guest.creatorId : host.creatorId) !== actorId) this.fail('PK_FORBIDDEN');
    if (host.creatorId === guest.creatorId) this.fail('PK_FORBIDDEN');
    if ([host, guest].some(row => row.status !== 'LIVE' || row.creatorStatus !== 'ACTIVE' || row.deletedAt)) this.fail('PK_STREAM_UNAVAILABLE');
    if (!this.livekit.configured()) throw new ServiceUnavailableException('Live streaming is not configured.');
    let published: boolean[];
    try {
      // Media I/O never holds database locks. The function rechecks DB state
      // atomically after these measurements, closing status-change races.
      published = await Promise.all([host, guest].map(async row => (await this.livekit.presence(row.livekitRoom, row.creatorId)).publisherHasTracks));
    } catch { throw new ServiceUnavailableException('The media server is unavailable.'); }
    if (published.some(value => !value)) this.fail('PK_STREAM_UNAVAILABLE');
  }

  private async battleIdentity(id: string): Promise<BattleIdentityRow> {
    const [row] = await this.database.$queryRaw<BattleIdentityRow[]>`
      SELECT id, host_stream_id AS "hostStreamId", guest_stream_id AS "guestStreamId",
        host_user_id AS "hostUserId", guest_user_id AS "guestUserId", status::text AS status,
        invitation_expires_at AS "invitationExpiresAt", clock_timestamp() AS "serverNow"
      FROM public.pk_battles WHERE id = ${id}::uuid`;
    if (!row) this.fail('PK_NOT_FOUND');
    return row;
  }

  private async refreshStream(streamId: string): Promise<BattleRow | null> {
    try {
      const [row] = await this.database.$queryRaw<BattleRow[]>(Prisma.sql`
        SELECT ${battleColumns}, b.host_score AS "hostScore", b.guest_score AS "guestScore", b.server_now AS "serverNow"
        FROM public.pk_snapshot(${streamId}::uuid) b ${battleJoins}`);
      return row ?? null;
    } catch (error) { this.databaseError(error); }
  }

  private async reconcilePublishers(battle: BattleRow): Promise<boolean> {
    if (battle.status !== 'INVITED' && battle.status !== 'ACTIVE') {
      this.publisherChecks.delete(battle.id);
      return false;
    }
    let check = this.publisherChecks.get(battle.id);
    if (!check) {
      check = { checkedAt: -Infinity, absentSince: new Map(), inFlight: null, settled: false };
    }
    // Bound memory and share measurements between viewers of either room.
    this.publisherChecks.delete(battle.id);
    this.publisherChecks.set(battle.id, check);
    if (this.publisherChecks.size > 512) this.publisherChecks.delete(this.publisherChecks.keys().next().value!);
    if (check.inFlight) return check.inFlight;
    if (performance.now() - check.checkedAt < 2_000) return check.settled;
    const state = check;
    state.inFlight = (async () => {
      let publishers: { streamId: string; connected: boolean }[];
      try {
        if (!this.livekit.configured()) { state.absentSince.clear(); return false; }
        const records = await this.streamRecords([battle.host.streamId, battle.guest.streamId]);
        if (records.length !== 2) { state.absentSince.clear(); return false; }
        publishers = await Promise.all(records.map(async stream => {
          try {
            const presence = await this.livekit.presence(stream.livekitRoom, stream.creatorId);
            // Muting audio and video is not a disconnect.
            return { streamId: stream.id, connected: presence.publisherConnected };
          } catch (error) {
            const missing = error as { code?: unknown; status?: unknown; statusCode?: unknown };
            if (missing?.code === 'not_found' || missing?.status === 404 || missing?.statusCode === 404) {
              return { streamId: stream.id, connected: false };
            }
            throw error;
          }
        }));
      } catch {
        // An outage breaks the evidence of continuous absence. Never forfeit
        // based on an unsuccessful media lookup.
        state.absentSince.clear();
        return false;
      }
      const observedAt = battle.serverNow.getTime();
      const absent: string[] = [];
      for (const publisher of publishers) {
        if (publisher.connected) state.absentSince.delete(publisher.streamId);
        else {
          const since = state.absentSince.get(publisher.streamId) ?? observedAt;
          state.absentSince.set(publisher.streamId, since);
          if (observedAt - since >= 15_000) absent.push(publisher.streamId);
        }
      }
      if (!absent.length) return false;
      try {
        // Bind delayed measurements to this battle so they cannot terminate a
        // newer round started while the media request was in flight.
        await this.database.$queryRaw`SELECT public.pk_settle_absent(${battle.id}::uuid, ${absent}::uuid[])::text`;
      } catch (error) { this.databaseError(error); }
      return true;
    })();
    try {
      state.settled = await state.inFlight;
      return state.settled;
    } finally {
      state.checkedAt = performance.now();
      state.inFlight = null;
    }
  }

  private async exactBattle(id: string, hostStreamId: string): Promise<BattleSnapshotDto> {
    await this.refreshStream(hostStreamId);
    const [row] = await this.database.$queryRaw<BattleRow[]>(Prisma.sql`
      SELECT ${battleColumns}, clock_timestamp() AS "serverNow",
        COALESCE(b.final_host_score, (SELECT COALESCE(-SUM(t.amount), 0) FROM public.du_transactions t
          WHERE t.type = 'GIFT' AND t.amount < 0 AND t.stream_id = b.host_stream_id AND t.creator_id = b.host_user_id
            AND t.created_at >= b.starts_at AND t.created_at < LEAST(b.ends_at, clock_timestamp())))::text AS "hostScore",
        COALESCE(b.final_guest_score, (SELECT COALESCE(-SUM(t.amount), 0) FROM public.du_transactions t
          WHERE t.type = 'GIFT' AND t.amount < 0 AND t.stream_id = b.guest_stream_id AND t.creator_id = b.guest_user_id
            AND t.created_at >= b.starts_at AND t.created_at < LEAST(b.ends_at, clock_timestamp())))::text AS "guestScore"
      FROM public.pk_battles b ${battleJoins} WHERE b.id = ${id}::uuid`);
    if (!row) this.fail('PK_NOT_FOUND');
    const battle = this.view(row);
    return { battle, serverNow: battle.serverNow };
  }

  async snapshot(streamId: string): Promise<BattleSnapshotDto> {
    const [stream] = await this.streamRecords([streamId]);
    if (!stream || stream.creatorStatus !== 'ACTIVE' || stream.deletedAt) throw new NotFoundException('Stream not found.');
    let row = await this.refreshStream(streamId);
    if (row && await this.reconcilePublishers(row)) row = await this.refreshStream(streamId);
    const battle = row ? this.view(row) : null;
    return { battle, serverNow: battle?.serverNow ?? stream.serverNow.toISOString() };
  }

  async candidates(userId: string) {
    const [feed, blocked] = await Promise.all([
      this.streams.list({}),
      this.database.$queryRaw<{ userId: string }[]>`
        SELECT CASE WHEN blocker_id = ${userId}::uuid THEN blocked_id ELSE blocker_id END AS "userId"
        FROM public.user_blocks WHERE blocker_id = ${userId}::uuid OR blocked_id = ${userId}::uuid`,
    ]);
    const excluded = new Set([userId, ...blocked.map(row => row.userId)]);
    return { items: feed.items.filter(stream => !excluded.has(stream.creator.id)) };
  }

  async invitations(userId: string): Promise<BattleInvitationsDto> {
    const pending = await this.database.$queryRaw<{ streamId: string }[]>`
      SELECT DISTINCT guest_stream_id AS "streamId" FROM public.pk_battles
      WHERE guest_user_id = ${userId}::uuid AND status = 'INVITED' LIMIT 20`;
    const snapshots = await Promise.all(pending.map(row => this.refreshStream(row.streamId)));
    const items = snapshots.filter((row): row is BattleRow => !!row && row.status === 'INVITED' && row.guest.userId === userId).map(row => this.view(row));
    return { items, serverNow: items[0]?.serverNow ?? await this.now() };
  }

  async invite(userId: string, streamId: string, input: InviteBattleDto): Promise<BattleSnapshotDto> {
    if (streamId.toLowerCase() === input.opponentStreamId.toLowerCase()) this.fail('PK_FORBIDDEN');
    const [existing] = await this.database.$queryRaw<{ id: string }[]>`
      SELECT id FROM public.pk_battles WHERE inviter_id = ${userId}::uuid AND idempotency_key = ${input.idempotencyKey.toLowerCase()}::uuid`;
    // Retrying a committed invitation must still work after the media ends.
    // pk_invite checks that the original streams match before replaying it.
    if (!existing) await this.publishingPair(streamId, input.opponentStreamId, userId, false);
    let rows: { id: string; host_stream_id: string }[];
    try {
      rows = await this.database.$queryRaw`
        SELECT id, host_stream_id FROM public.pk_invite(${userId}::uuid, ${streamId}::uuid,
          ${input.opponentStreamId}::uuid, ${input.idempotencyKey.toLowerCase()}::uuid, 300)`;
    } catch (error) { this.databaseError(error); }
    return this.exactBattle(rows[0]!.id, rows[0]!.host_stream_id);
  }

  async respond(userId: string, battleId: string, action: BattleAction): Promise<BattleSnapshotDto> {
    const battle = await this.battleIdentity(battleId);
    if (battle.hostUserId !== userId && battle.guestUserId !== userId) this.fail('PK_FORBIDDEN');
    if (action === 'CANCEL' && battle.hostUserId !== userId) this.fail('PK_FORBIDDEN');
    if ((action === 'ACCEPT' || action === 'DECLINE') && battle.guestUserId !== userId) this.fail('PK_FORBIDDEN');
    if (action === 'ACCEPT' && battle.status === 'INVITED' && battle.invitationExpiresAt > battle.serverNow) {
      await this.publishingPair(battle.hostStreamId, battle.guestStreamId, userId, true);
    }
    let rows: { id: string; host_stream_id: string }[];
    try {
      rows = await this.database.$queryRaw`
        SELECT id, host_stream_id FROM public.pk_respond(${userId}::uuid, ${battleId}::uuid, ${action}::text)`;
    } catch (error) { this.databaseError(error); }
    return this.exactBattle(rows[0]!.id, rows[0]!.host_stream_id);
  }

  async likes(streamId: string): Promise<LikeTotalDto> {
    const [row] = await this.database.$queryRaw<{ total: string; serverNow: Date }[]>`
      SELECT COALESCE((SELECT SUM(l.count) FROM public.stream_likes l WHERE l.stream_id = s.id), 0)::text AS total,
        clock_timestamp() AS "serverNow"
      FROM public.live_streams s JOIN public.users u ON u.id = s.creator_id
      WHERE s.id = ${streamId}::uuid AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`;
    if (!row) this.fail('LIKES_STREAM_UNAVAILABLE');
    return { total: row.total, serverNow: row.serverNow.toISOString() };
  }

  async sendLikes(userId: string, streamId: string, input: SendLikesDto): Promise<LikeMutationDto> {
    let rows: { total: string; count: number; serverNow: Date }[];
    try {
      rows = await this.database.$queryRaw`
        SELECT total, count, clock_timestamp() AS "serverNow"
        FROM public.stream_send_likes(${userId}::uuid, ${streamId}::uuid, ${input.count}::integer, ${input.idempotencyKey.toLowerCase()}::uuid)`;
    } catch (error) { this.databaseError(error); }
    const row = rows[0]!;
    return { total: row.total, acceptedCount: row.count, serverNow: row.serverNow.toISOString() };
  }
}
