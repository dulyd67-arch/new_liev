import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@livestar/database';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database.service';
import { DuService } from '../src/du/du.service';

const userId = '11111111-1111-4111-8111-111111111111';
const streamId = '22222222-2222-4222-8222-222222222222';
const giftId = '33333333-3333-4333-8333-333333333333';
const idempotencyKey = 'ABCD1111-4444-4444-8444-444444444444';
const gift = { id: giftId, slug: 'rose', nameAr: 'وردة', nameEn: 'Rose', emoji: '🌹', price: '1', effect: 'float' };
const wallet = { balance: '9007199254740993', claimAvailable: false, receivedCoins: '9007199254740995', receivedGifts: '9007199254740997' };
const createdAt = new Date('2026-11-15T12:00:00.000Z');
const row = { id: giftId, sequence: '9007199254740999', type: 'GIFT', amount: '-2', balanceAfter: '9007199254740993', streamId, quantity: 2, gift, createdAt };

function fixture() {
  const query = vi.fn();
  return { service: new DuService({ $queryRaw: query } as unknown as DatabaseService), query };
}

function sqlError(code: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed.', { code: 'P2010', clientVersion: 'test', meta: { code, message } });
}

describe('promotional DU database boundary', () => {
  it('preserves exact large balances and reports no payment capability', async () => {
    const { service, query } = fixture(); query.mockResolvedValueOnce([wallet]);
    expect(await service.wallet(userId)).toEqual({ currency: 'DU', ...wallet, promotional: true, purchasingEnabled: false });
    expect(query.mock.calls[0]?.slice(1)).toEqual([userId]);
    expect(query.mock.calls[0]?.[0].join('')).toContain('u.deleted_at IS NULL');
    query.mockResolvedValueOnce([]);
    await expect(service.wallet(userId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('delegates the complete spend to one atomic function with trusted actor and normalized request UUID', async () => {
    const { service, query } = fixture(); query.mockResolvedValueOnce([row]).mockResolvedValueOnce([wallet]);
    const result = await service.send(userId, streamId, { giftId, quantity: 2, idempotencyKey });
    expect(result.transaction).toEqual({ ...row, createdAt: createdAt.toISOString() });
    expect(result.wallet.balance).toBe('9007199254740993');
    const sql = query.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.sql).toContain('FROM public.du_send_gift(?::uuid, ?::uuid, ?::uuid,');
    expect(sql.values).toEqual([userId, streamId, giftId, '2', idempotencyKey.toLowerCase()]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('delegates an explicit claim without granting coins from wallet reads', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([{ ...row, type: 'CLAIM', amount: '100', gift: null, quantity: null, streamId: null }]).mockResolvedValueOnce([wallet]);
    expect((await service.claim(userId, idempotencyKey)).transaction.amount).toBe('100');
    const sql = query.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.sql).toContain('FROM public.du_claim_coins(?::uuid, ?::text)');
    expect(sql.values).toEqual([userId, idempotencyKey.toLowerCase()]);
  });

  it.each([
    ['23514', 'DU_INVALID_REQUEST', BadRequestException],
    ['23514', 'DU_ACCOUNT_UNAVAILABLE', ForbiddenException],
    ['23514', 'DU_ALREADY_CLAIMED', ConflictException],
    ['23514', 'DU_STREAM_UNAVAILABLE', NotFoundException],
    ['23514', 'DU_SELF_GIFT', ForbiddenException],
    ['23514', 'DU_BLOCKED', ForbiddenException],
    ['23514', 'DU_GIFT_UNAVAILABLE', NotFoundException],
    ['23514', 'DU_INSUFFICIENT_BALANCE', ConflictException],
    ['23514', 'DU_AMOUNT_OVERFLOW', BadRequestException],
    ['23514', 'DU_IDEMPOTENCY_CONFLICT', ConflictException],
  ])('maps tagged SQL error %s/%s to a stable public error', async (state, code, expected) => {
    const { service, query } = fixture(); query.mockRejectedValueOnce(sqlError(state as string, `ERROR: ${code}\nCONTEXT: private SQL function`));
    const error = await service.send(userId, streamId, { giftId, quantity: 2, idempotencyKey }).catch(error => error);
    expect(error).toBeInstanceOf(expected);
    expect(error.getResponse()).toMatchObject({ code });
    expect(JSON.stringify(error.getResponse())).not.toContain('private SQL');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['23505', 'DU_INSUFFICIENT_BALANCE'],
    ['23505', 'Unique constraint failed: '],
    ['23514', 'other failure mentions DU_SELF_GIFT'],
    ['23514', 'DU_NOT_A_PUBLIC_CODE'],
    ['42501', 'DU_ACCOUNT_UNAVAILABLE'],
  ])('does not disguise unexpected database errors (%s/%s)', async (state, code) => {
    const { service, query } = fixture(); const error = sqlError(state, code); query.mockRejectedValueOnce(error);
    await expect(service.claim(userId, idempotencyKey)).rejects.toBe(error);
  });

  it('paginates private history with exact sequences and a strict before cursor', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce(Array.from({ length: 51 }, (_, index) => ({ ...row, sequence: String(9007199254741000n - BigInt(index)) })));
    const result = await service.history(userId, '9007199254741001');
    expect(result.items).toHaveLength(50);
    expect(result.nextCursor).toBe('9007199254740951');
    expect((query.mock.calls[0]?.[0] as Prisma.Sql).values).toEqual([userId, '9007199254741001', '9007199254741001']);
  });

  it('starts polling at the current head without historical animation events', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([{ head: '9007199254740999', totalCoins: '50', totalGifts: '10', items: [] }]);
    expect(await service.feed(streamId)).toEqual({ items: [], nextCursor: '9007199254740999', totalCoins: '50', totalGifts: '10' });
    expect((query.mock.calls[0]?.[0] as Prisma.Sql).sql).toContain("IS NULL THEN '[]'::jsonb");
  });

  it('advances only through returned events so a full page cannot skip unseen gifts', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([{ head: '100', totalCoins: '100', totalGifts: '100', items: [{ ...row, totalPrice: '2', sequence: '50', sender: { id: userId, username: null, displayName: 'Member' } }] }]);
    expect((await service.feed(streamId, '0')).nextCursor).toBe('50');
    query.mockResolvedValueOnce([{ head: '100', totalCoins: '100', totalGifts: '100', items: [] }]);
    expect((await service.feed(streamId, '9223372036854775807')).nextCursor).toBe('9223372036854775807');
    query.mockResolvedValueOnce([]);
    await expect(service.feed(streamId, '0')).rejects.toBeInstanceOf(NotFoundException);
  });
});
