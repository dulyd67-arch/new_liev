import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@livestar/database';
import { DatabaseService } from '../database.service';
import { DuCatalogDto, DuGiftDto, DuGiftFeedDto, DuHistoryDto, DuMutationDto, DuTransactionDto, DuWalletDto, SendDuGiftDto } from './du.dto';

type TransactionRow = Omit<DuTransactionDto, 'createdAt'> & { createdAt: Date };
type WalletRow = Pick<DuWalletDto, 'balance' | 'claimAvailable' | 'receivedCoins' | 'receivedGifts'>;
type FeedRow = Omit<DuGiftFeedDto, 'nextCursor'> & { head: string };

// Amounts and sequences are converted by Postgres before JSON construction.
// No financial value passes through a JavaScript floating point number.
const giftJson = Prisma.sql`jsonb_build_object(
  'id', g.id, 'slug', g.slug, 'nameAr', g.name_ar, 'nameEn', g.name_en,
  'emoji', g.emoji, 'price', COALESCE(t.unit_price, g.price)::text, 'effect', g.effect
)`;
const transactionColumns = Prisma.sql`
  t.id, t.seq::text AS sequence, t.type, t.amount::text AS amount,
  t.balance_after::text AS "balanceAfter", t.stream_id::text AS "streamId",
  t.quantity::int AS quantity,
  CASE WHEN t.gift_id IS NULL THEN NULL ELSE ${giftJson} END AS gift,
  t.created_at AS "createdAt"`;

const domainErrors = {
  DU_INVALID_REQUEST: { status: 400, message: 'Invalid promotional DU request.' },
  DU_ACCOUNT_UNAVAILABLE: { status: 403, message: 'Your account is unavailable.' },
  DU_ALREADY_CLAIMED: { status: 409, message: 'The free promotional DU claim has already been used.' },
  DU_STREAM_UNAVAILABLE: { status: 404, message: 'This stream is unavailable for gifts.' },
  DU_SELF_GIFT: { status: 403, message: 'You cannot send gifts to your own stream.' },
  DU_BLOCKED: { status: 403, message: 'Gifting is unavailable between these accounts.' },
  DU_GIFT_UNAVAILABLE: { status: 404, message: 'This gift is unavailable.' },
  DU_INSUFFICIENT_BALANCE: { status: 409, message: 'You do not have enough promotional DU for this gift.' },
  DU_AMOUNT_OVERFLOW: { status: 400, message: 'This promotional DU amount is too large.' },
  DU_IDEMPOTENCY_CONFLICT: { status: 409, message: 'This request UUID has already been used for a different action.' },
} as const;

@Injectable()
export class DuService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private mapDatabaseError(error: unknown): never {
    // Only the exact tagged errors emitted by the DU functions are public.
    // Do not match arbitrary database messages containing a familiar substring.
    // Intentional idempotency conflicts also use 23514: Prisma strips the
    // custom message from 23505 unique violations, so that state is never public.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
      const sqlState = error.meta?.code;
      const message = typeof error.meta?.message === 'string' ? error.meta.message.trim() : '';
      const match = /^(?:ERROR:\s*)?(DU_[A-Z_]+)(?:\n[^]*)?$/.exec(message);
      const code = match?.[1];
      if (code && Object.hasOwn(domainErrors, code) && sqlState === '23514') {
        const detail = domainErrors[code as keyof typeof domainErrors];
        const body = { code, message: detail.message };
        if (detail.status === 400) throw new BadRequestException(body);
        if (detail.status === 403) throw new ForbiddenException(body);
        if (detail.status === 404) throw new NotFoundException(body);
        throw new ConflictException(body);
      }
    }
    throw error;
  }

  private transaction(row: TransactionRow): DuTransactionDto {
    return { ...row, createdAt: row.createdAt.toISOString() };
  }

  async wallet(userId: string): Promise<DuWalletDto> {
    const [row] = await this.database.$queryRaw<WalletRow[]>`
      SELECT COALESCE(w.balance, 0)::text AS balance, (w.claimed_at IS NULL) AS "claimAvailable",
        COALESCE((SELECT -SUM(t.amount) FROM public.du_transactions t
          WHERE t.creator_id = u.id AND t.type = 'GIFT'), 0)::text AS "receivedCoins",
        COALESCE((SELECT SUM(t.quantity) FROM public.du_transactions t
          WHERE t.creator_id = u.id AND t.type = 'GIFT'), 0)::text AS "receivedGifts"
      FROM public.users u LEFT JOIN public.du_wallets w ON w.user_id = u.id
      WHERE u.id = ${userId}::uuid AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`;
    if (!row) throw new ForbiddenException({ code: 'DU_ACCOUNT_UNAVAILABLE', message: 'Your account is unavailable.' });
    return { currency: 'DU', ...row, promotional: true, purchasingEnabled: false };
  }

  async catalog(): Promise<DuCatalogDto> {
    const items = await this.database.$queryRaw<DuGiftDto[]>`
      SELECT id, slug, name_ar AS "nameAr", name_en AS "nameEn", emoji, price::text AS price, effect
      FROM public.du_gifts ORDER BY sort_order ASC, id ASC`;
    return { items, currency: 'DU', promotional: true };
  }

  async history(userId: string, cursor?: string): Promise<DuHistoryDto> {
    const rows = await this.database.$queryRaw<TransactionRow[]>(Prisma.sql`
      SELECT ${transactionColumns} FROM public.du_transactions t
      LEFT JOIN public.du_gifts g ON g.id = t.gift_id
      WHERE t.user_id = ${userId}::uuid AND (${cursor ?? null}::bigint IS NULL OR t.seq < ${cursor ?? null}::bigint)
      ORDER BY t.seq DESC LIMIT 51`);
    const items = rows.slice(0, 50).map(row => this.transaction(row));
    return { items, nextCursor: rows.length > 50 ? items[items.length - 1]!.sequence : null };
  }

  async claim(userId: string, idempotencyKey: string): Promise<DuMutationDto> {
    let rows: TransactionRow[];
    try {
      rows = await this.database.$queryRaw<TransactionRow[]>(Prisma.sql`
        SELECT ${transactionColumns}
        FROM public.du_claim_coins(${userId}::uuid, ${idempotencyKey.toLowerCase()}::text) t
        LEFT JOIN public.du_gifts g ON g.id = t.gift_id`);
    } catch (error) { this.mapDatabaseError(error); }
    return { transaction: this.transaction(rows[0]!), wallet: await this.wallet(userId) };
  }

  async send(userId: string, streamId: string, input: SendDuGiftDto): Promise<DuMutationDto> {
    let rows: TransactionRow[];
    try {
      rows = await this.database.$queryRaw<TransactionRow[]>(Prisma.sql`
        SELECT ${transactionColumns}
        FROM public.du_send_gift(${userId}::uuid, ${streamId}::uuid, ${input.giftId}::uuid,
          ${String(input.quantity)}::bigint, ${input.idempotencyKey.toLowerCase()}::text) t
        LEFT JOIN public.du_gifts g ON g.id = t.gift_id`);
    } catch (error) { this.mapDatabaseError(error); }
    return { transaction: this.transaction(rows[0]!), wallet: await this.wallet(userId) };
  }

  async feed(streamId: string, after?: string): Promise<DuGiftFeedDto> {
    // One statement gives totals, head and events the same committed snapshot.
    // The DB serializes gift commits per stream so sequence pagination cannot
    // skip an earlier gift that is still in flight when this poll completes.
    const [row] = await this.database.$queryRaw<FeedRow[]>(Prisma.sql`
      SELECT COALESCE((SELECT MAX(t.seq) FROM public.du_transactions t
          WHERE t.stream_id = s.id AND t.type = 'GIFT'), 0)::text AS head,
        COALESCE((SELECT -SUM(t.amount) FROM public.du_transactions t
          WHERE t.stream_id = s.id AND t.type = 'GIFT'), 0)::text AS "totalCoins",
        COALESCE((SELECT SUM(t.quantity) FROM public.du_transactions t
          WHERE t.stream_id = s.id AND t.type = 'GIFT'), 0)::text AS "totalGifts",
        CASE WHEN ${after ?? null}::bigint IS NULL THEN '[]'::jsonb ELSE
          COALESCE((SELECT jsonb_agg(event ORDER BY seq) FROM (
            SELECT t.seq, jsonb_build_object(
              'id', t.id, 'sequence', t.seq::text, 'quantity', t.quantity::int,
              'totalPrice', (-t.amount)::text, 'gift', ${giftJson},
              'sender', jsonb_build_object('id', t.user_id,
                'username', CASE WHEN sender.status = 'ACTIVE' AND sender.deleted_at IS NULL THEN p.username ELSE NULL END,
                'displayName', CASE WHEN sender.status = 'ACTIVE' AND sender.deleted_at IS NULL THEN COALESCE(p.display_name, 'LiveStar member') ELSE 'LiveStar member' END),
              'createdAt', to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            ) AS event
            FROM public.du_transactions t
            JOIN public.du_gifts g ON g.id = t.gift_id
            JOIN public.users sender ON sender.id = t.user_id
            LEFT JOIN public.user_profiles p ON p.user_id = t.user_id
            WHERE t.stream_id = s.id AND t.type = 'GIFT' AND t.seq > ${after ?? null}::bigint
            ORDER BY t.seq ASC LIMIT 50
          ) events), '[]'::jsonb) END AS items
      FROM public.live_streams s JOIN public.users creator ON creator.id = s.creator_id
      WHERE s.id = ${streamId}::uuid AND creator.status = 'ACTIVE' AND creator.deleted_at IS NULL`);
    if (!row) throw new NotFoundException({ code: 'DU_STREAM_UNAVAILABLE', message: 'This stream is unavailable for gifts.' });
    const last = row.items[row.items.length - 1];
    const nextCursor = last?.sequence ?? (after !== undefined && BigInt(after) > BigInt(row.head) ? after : row.head);
    return { items: row.items, nextCursor, totalCoins: row.totalCoins, totalGifts: row.totalGifts };
  }
}
