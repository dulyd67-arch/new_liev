import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@livestar/database';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { LiveKitService } from '../streams/livekit.service';
import { AdminPageQueryDto, AdminReasonDto, AdminReportsQueryDto, AdminReviewReportDto, AdminStreamsQueryDto, AdminUsersQueryDto } from './admin.dto';

const errors = {
  ADMIN_INVALID_REQUEST: [400, 'Invalid administration request.'],
  ADMIN_FORBIDDEN: [403, 'Administrator access is required.'],
  ADMIN_ACCOUNT_UNAVAILABLE: [403, 'Your administrator account is unavailable.'],
  ADMIN_TARGET_UNAVAILABLE: [409, 'This account is unavailable for this action.'],
  ADMIN_TARGET_PROTECTED: [403, 'This action cannot target yourself or a staff account.'],
  ADMIN_STATE_CONFLICT: [409, 'The current state does not allow this action. Stop any remaining broadcasts before restoring an account.'],
  ADMIN_IDEMPOTENCY_CONFLICT: [409, 'This request identifier has already been used for another action.'],
  ADMIN_NOT_FOUND: [404, 'The requested administration record was not found.'],
  ADMIN_TERMINATED_IMMUTABLE: [409, 'A terminated broadcast cannot be reopened or rewritten.'],
} as const;

type UserIdentity = { id: string; status: string; deletedAt: Date | null; profile: { username: string; displayName: string } | null };
const identitySelect = { id: true, status: true, deletedAt: true, profile: { select: { username: true, displayName: true } } } as const;
const openStatuses = ['LIVE', 'SCHEDULED'] as const;
type MutationStream = { id: string; creator_id: string; livekit_room: string; status: string };

function identity(user: UserIdentity | null) {
  if (!user) return null;
  const visible = user.deletedAt === null && !['DELETED', 'DELETION_PENDING'].includes(user.status);
  return { id: user.id, username: visible ? user.profile?.username ?? null : null, displayName: visible ? user.profile?.displayName ?? 'LiveStar member' : 'Deleted account' };
}

// No arbitrary historic audit payload is returned to the dashboard. Only
// operation fields written by the administration RPCs may cross this boundary.
const auditKeys = new Set(['status', 'reason', 'operation', 'phase', 'request', 'body', 'targetStatus', 'fromStatus', 'toStatus', 'mediaStopped', 'media_stopped', 'type', 'roles', 'streamIds', 'streamId', 'targetUserId', 'targetId', 'reportId', 'action']);
function safeAudit(value: Prisma.JsonValue | null, depth = 0): Prisma.JsonValue | null {
  if (value === null || depth > 4) return null;
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => safeAudit(item, depth + 1));
  const output: Record<string, Prisma.JsonValue> = {};
  for (const [key, item] of Object.entries(value)) if (auditKeys.has(key) && item !== undefined) output[key] = safeAudit(item, depth + 1);
  return output;
}

export function suspensionStreamRequestKey(requestKey: string, streamId: string): string {
  const bytes = createHash('sha256').update(`livestar.admin.suspend-stop:${requestKey.toLowerCase()}:${streamId.toLowerCase()}`).digest().subarray(0, 16);
  // A deterministic UUID-shaped request key for this one suspension and room.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

@Injectable()
export class AdminService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, @Inject(LiveKitService) private readonly livekit: LiveKitService) {}

  private databaseError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010' && error.meta?.code === '23514') {
      const message = typeof error.meta.message === 'string' ? error.meta.message.trim() : '';
      const match = /^(?:ERROR:\s*)?(ADMIN_[A-Z_]+)(?:\n[^]*)?$/.exec(message);
      const code = match?.[1] as keyof typeof errors | undefined;
      if (code && Object.hasOwn(errors, code)) {
        const [status, detail] = errors[code]; const body = { code, message: detail };
        if (status === 400) throw new BadRequestException(body);
        if (status === 403) throw new ForbiddenException(body);
        if (status === 404) throw new NotFoundException(body);
        throw new ConflictException(body);
      }
    }
    throw error;
  }

  async overview() {
    type OverviewRow = {
      users: { total: number; active: number; suspended: number; newLast7Days: number };
      streams: { liveSessions: number; scheduledSessions: number };
      reports: { open: number; reviewing: number };
      gifts: { sentCount: number; spentDu: string; claimedDu: string };
      dailyRegistrations: { date: string; count: number }[]; serverNow: Date;
    };
    const [row] = await this.database.$queryRaw<OverviewRow[]>`
      WITH observed AS (SELECT clock_timestamp() AS at)
      SELECT
        (SELECT jsonb_build_object(
          'total', count(*) FILTER (WHERE status IN ('ACTIVE','SUSPENDED') AND deleted_at IS NULL),
          'active', count(*) FILTER (WHERE status='ACTIVE' AND deleted_at IS NULL),
          'suspended', count(*) FILTER (WHERE status='SUSPENDED' AND deleted_at IS NULL),
          'newLast7Days', count(*) FILTER (WHERE created_at>=observed.at-interval '7 days' AND status IN ('ACTIVE','SUSPENDED') AND deleted_at IS NULL)) FROM public.users) AS users,
        (SELECT jsonb_build_object('liveSessions',count(*) FILTER (WHERE status='LIVE'),
          'scheduledSessions',count(*) FILTER (WHERE status='SCHEDULED')) FROM public.live_streams) AS streams,
        (SELECT jsonb_build_object('open',count(*) FILTER (WHERE status='OPEN'),
          'reviewing',count(*) FILTER (WHERE status='REVIEWING')) FROM public.reports) AS reports,
        (SELECT jsonb_build_object('sentCount',count(*) FILTER (WHERE type='GIFT'),
          'spentDu',coalesce(-sum(amount::numeric) FILTER (WHERE type='GIFT'),0)::text,
          'claimedDu',coalesce(sum(amount::numeric) FILTER (WHERE type='CLAIM'),0)::text) FROM public.du_transactions) AS gifts,
        (SELECT jsonb_agg(jsonb_build_object('date',to_char(day,'YYYY-MM-DD'), 'count',
          (SELECT count(*) FROM public.users u WHERE (u.created_at AT TIME ZONE 'UTC')::date=day::date
            AND u.status IN ('ACTIVE','SUSPENDED') AND u.deleted_at IS NULL)) ORDER BY day)
          FROM generate_series((observed.at AT TIME ZONE 'UTC')::date-6,
            (observed.at AT TIME ZONE 'UTC')::date,interval '1 day') AS days(day)) AS "dailyRegistrations",
        observed.at AS "serverNow" FROM observed`;
    if (!row) throw new ServiceUnavailableException('Administration statistics are unavailable.');
    return { users: row.users, streams: row.streams, reports: row.reports, gifts: row.gifts, dailyRegistrations: row.dailyRegistrations, serverNow: row.serverNow.toISOString() };
  }

  async users(query: AdminUsersQueryDto) {
    const limit = query.limit ?? 20;
    const rows = await this.database.user.findMany({
      where: {
        status: query.status ?? { in: ['ACTIVE', 'SUSPENDED'] }, deletedAt: null,
        ...(query.cursor ? { id: { gt: query.cursor.toLowerCase() } } : {}),
        ...(query.query ? { OR: [
          { email: { contains: query.query, mode: 'insensitive' as const } },
          { profile: { username: { contains: query.query, mode: 'insensitive' as const } } },
          { profile: { displayName: { contains: query.query, mode: 'insensitive' as const } } },
        ] } : {}),
      },
      select: { id: true, email: true, status: true, createdAt: true, profile: { select: { username: true, displayName: true } },
        roles: { select: { role: { select: { name: true } } } }, _count: { select: { streams: { where: { status: { in: [...openStatuses] } } } } } },
      orderBy: { id: 'asc' }, take: limit + 1,
    });
    const visible = rows.slice(0, limit);
    return { items: visible.map(row => ({ id: row.id, email: row.email, username: row.profile?.username ?? null, displayName: row.profile?.displayName ?? 'LiveStar member',
      status: row.status, createdAt: row.createdAt.toISOString(), roles: row.roles.map(item => item.role.name), openStreamCount: row._count.streams })),
      nextCursor: rows.length > limit ? visible.at(-1)!.id : null };
  }

  async streams(query: AdminStreamsQueryDto) {
    const limit = query.limit ?? 20;
    const rows = await this.database.liveStream.findMany({
      where: { ...(query.status ? { status: query.status } : {}), ...(query.cursor ? { id: { gt: query.cursor.toLowerCase() } } : {}) },
      select: { id: true, title: true, status: true, createdAt: true, startedAt: true, endedAt: true, livekitRoom: true, creatorId: true, creator: { select: identitySelect } },
      orderBy: { id: 'asc' }, take: limit + 1,
    });
    const visible = rows.slice(0, limit);
    const items = await Promise.all(visible.map(async row => {
      let viewerCount: number | null = null; let mediaStatus: 'publishing' | 'offline' | 'unknown' = 'offline';
      if (row.status === 'LIVE' || row.status === 'SCHEDULED') {
        mediaStatus = 'unknown';
        if (this.livekit.configured()) {
          try {
            const presence = await this.livekit.presence(row.livekitRoom, row.creatorId);
            viewerCount = presence.viewerCount; mediaStatus = presence.publisherConnected ? 'publishing' : 'offline';
          } catch (error) {
            const missing = error as { code?: unknown; status?: unknown; statusCode?: unknown };
            if (missing?.code === 'not_found' || missing?.status === 404 || missing?.statusCode === 404) { viewerCount = 0; mediaStatus = 'offline'; }
          }
        }
      }
      return { id: row.id, title: row.title, status: row.status, createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
        endedAt: row.endedAt?.toISOString() ?? null, creator: identity(row.creator)!, viewerCount, mediaStatus };
    }));
    return { items, nextCursor: rows.length > limit ? visible.at(-1)!.id : null };
  }

  async reports(query: AdminReportsQueryDto) {
    const limit = query.limit ?? 20;
    const rows = await this.database.report.findMany({
      where: { ...(query.status ? { status: query.status } : {}), ...(query.cursor ? { id: { gt: query.cursor.toLowerCase() } } : {}) },
      select: { id: true, status: true, reasonCode: true, details: true, createdAt: true, resolvedAt: true,
        reporter: { select: identitySelect }, targetUser: { select: identitySelect }, stream: { select: { id: true, title: true, status: true } } },
      orderBy: { id: 'asc' }, take: limit + 1,
    });
    const visible = rows.slice(0, limit);
    return { items: visible.map(row => ({ id: row.id, status: row.status, reasonCode: row.reasonCode, details: row.details,
      createdAt: row.createdAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null,
      reporter: identity(row.reporter)!, target: identity(row.targetUser), stream: row.stream ? { id: row.stream.id, title: row.stream.title, status: row.stream.status } : null })),
      nextCursor: rows.length > limit ? visible.at(-1)!.id : null };
  }

  async audit(query: AdminPageQueryDto) {
    const limit = query.limit ?? 20;
    const rows = await this.database.adminAuditLog.findMany({
      where: { action: { startsWith: 'ADMIN_' }, ...(query.cursor ? { id: { gt: query.cursor.toLowerCase() } } : {}) },
      select: { id: true, action: true, entityType: true, entityId: true, before: true, after: true, requestId: true, createdAt: true, actor: { select: identitySelect } },
      orderBy: { id: 'asc' }, take: limit + 1,
    });
    const visible = rows.slice(0, limit);
    return { items: visible.map(row => ({ id: row.id, action: row.action, entityType: row.entityType, entityId: row.entityId,
      before: safeAudit(row.before), after: safeAudit(row.after), requestId: row.requestId, createdAt: row.createdAt.toISOString(), actor: identity(row.actor) })),
      nextCursor: rows.length > limit ? visible.at(-1)!.id : null };
  }

  async setUserStatus(actorId: string, userId: string, status: 'ACTIVE' | 'SUSPENDED', input: AdminReasonDto) {
    let rows: { id: string; status: string }[];
    try {
      rows = await this.database.$queryRaw`SELECT id,status::text AS status FROM public.admin_set_user_status(${actorId}::uuid,${userId}::uuid,${status}::text,${input.reason}::text,${input.idempotencyKey}::uuid)`;
    } catch (error) { this.databaseError(error); }
    const user = rows[0]; if (!user) throw new NotFoundException('Account not found.');
    // A replay returns the current row. An old suspension replay after a later
    // restore must not stop a newly authorized broadcast.
    if (user.status !== 'SUSPENDED') return { user: { id: user.id, status: user.status }, mediaCleanup: { complete: true, pendingStreamIds: [] as string[] } };
    const remaining = await this.database.liveStream.findMany({ where: { creatorId: user.id, status: { in: [...openStatuses] } }, select: { id: true }, orderBy: { id: 'asc' } });
    if (status === 'SUSPENDED') {
      for (const stream of remaining) {
        try { await this.terminateStream(actorId, stream.id, { reason: input.reason, idempotencyKey: suspensionStreamRequestKey(input.idempotencyKey, stream.id) }); }
        catch { /* Suspension is committed; retry the remaining rooms without claiming success. */ }
      }
    }
    const pending = await this.database.liveStream.findMany({ where: { creatorId: user.id, status: { in: [...openStatuses] } }, select: { id: true }, orderBy: { id: 'asc' } });
    return { user: { id: user.id, status: user.status }, mediaCleanup: { complete: pending.length === 0, pendingStreamIds: pending.map(stream => stream.id) } };
  }

  async terminateStream(actorId: string, streamId: string, input: AdminReasonDto) {
    let rows: MutationStream[];
    try {
      // Reserving before provider I/O binds concurrent retries to one action.
      // The short SQL call releases all locks before the media request begins.
      rows = await this.database.$queryRaw`SELECT id,creator_id,livekit_room,status::text AS status FROM public.admin_terminate_stream(${actorId}::uuid,${streamId}::uuid,${input.reason}::text,${input.idempotencyKey}::uuid,false)`;
    } catch (error) { this.databaseError(error); }
    const stream = rows[0]; if (!stream) throw new NotFoundException('Stream not found.');
    if (stream.status === 'TERMINATED') return { stream: { id: stream.id, status: stream.status } };
    if (!this.livekit.configured()) throw new ServiceUnavailableException({ code: 'ADMIN_MEDIA_UNAVAILABLE', message: 'The media service could not stop this broadcast. Try again.' });
    try { await this.livekit.deleteRoom(stream.livekit_room); }
    catch { throw new ServiceUnavailableException({ code: 'ADMIN_MEDIA_UNAVAILABLE', message: 'The media service could not stop this broadcast. Try again.' }); }
    // PK takes its own global/participant locks. Never call it under an admin
    // user-row transaction, which would reverse the established lock order.
    await this.database.$queryRaw`SELECT public.pk_settle_stream(${stream.id}::uuid)::text`;
    try {
      rows = await this.database.$queryRaw`SELECT id,creator_id,livekit_room,status::text AS status FROM public.admin_terminate_stream(${actorId}::uuid,${stream.id}::uuid,${input.reason}::text,${input.idempotencyKey}::uuid,true)`;
    } catch (error) { this.databaseError(error); }
    const result = rows[0]; if (!result) throw new NotFoundException('Stream not found.');
    return { stream: { id: result.id, status: result.status } };
  }

  async reviewReport(actorId: string, reportId: string, input: AdminReviewReportDto) {
    let rows: { id: string; status: string; resolved_at: Date | null }[];
    try {
      rows = await this.database.$queryRaw`SELECT id,status::text AS status,resolved_at FROM public.admin_review_report(${actorId}::uuid,${reportId}::uuid,${input.status}::text,${input.reason}::text,${input.idempotencyKey}::uuid)`;
    } catch (error) { this.databaseError(error); }
    const row = rows[0]; if (!row) throw new NotFoundException('Report not found.');
    return { report: { id: row.id, status: row.status, resolvedAt: row.resolved_at?.toISOString() ?? null } };
  }
}
