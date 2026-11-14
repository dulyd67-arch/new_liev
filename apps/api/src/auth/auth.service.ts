import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, SessionClientType } from '@livestar/database';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database.service';
import { RegisterDto } from './auth.dto';
import { MailService } from './mail.service';
import { hashPassword, verifyPassword } from './password';

export const CURRENT_TERMS_VERSION = '2026-11-07';
export const CURRENT_PRIVACY_VERSION = '2026-11-07';
const ACCESS_SECONDS = 900;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 30 * 60 * 1000;
const userInclude = { profile: true, roles: { include: { role: true } } } as const;
type AuthUser = Prisma.UserGetPayload<{ include: typeof userInclude }>;
export interface Actor { userId: string; sessionId: string; familyId: string; roles: string[]; permissions: string[]; }
export interface AuthResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; email: string; username: string | null; displayName: string | null; locale: string | null; emailVerified: boolean };
  emailDelivery?: 'sent' | 'unavailable';
}

function token(): string { return randomBytes(32).toString('base64url'); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function validToken(value: string): boolean { return /^[A-Za-z0-9_-]{43}$/.test(value); }

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  private async lockedUser(tx: Prisma.TransactionClient, id: string): Promise<AuthUser | null> {
    await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.user.findUnique({ where: { id }, include: userInclude });
  }

  private async audit(tx: Prisma.TransactionClient, userId: string, action: string): Promise<void> {
    await tx.adminAuditLog.create({ data: { actorId: userId, action, entityType: 'USER', entityId: userId, requestId: randomUUID() } });
  }

  private async result(user: AuthUser, sessionId: string, refreshToken: string): Promise<AuthResult> {
    const accessToken = await this.jwt.signAsync({ sid: sessionId }, {
      secret: this.config.jwtSecret,
      algorithm: 'HS256',
      subject: user.id,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
      expiresIn: ACCESS_SECONDS,
    });
    return {
      accessToken, expiresIn: ACCESS_SECONDS, refreshToken,
      user: { id: user.id, email: user.email, username: user.profile?.username ?? null, displayName: user.profile?.displayName ?? null, locale: user.profile?.locale ?? null, emailVerified: !!user.emailVerifiedAt },
    };
  }

  private async newSession(tx: Prisma.TransactionClient, userId: string, clientType: SessionClientType, refreshToken: string) {
    return tx.session.create({ data: { userId, clientType, familyId: randomUUID(), refreshTokenHash: digest(refreshToken), expiresAt: new Date(Date.now() + REFRESH_MS) } });
  }

  private async challenge(tx: Prisma.TransactionClient, userId: string, kind: 'PASSWORD_RESET' | 'EMAIL_VERIFY', raw: string): Promise<void> {
    await tx.authChallenge.updateMany({ where: { userId, kind, consumedAt: null }, data: { consumedAt: new Date() } });
    await tx.authChallenge.create({ data: { userId, kind, tokenHash: digest(raw), expiresAt: new Date(Date.now() + CHALLENGE_MS) } });
  }

  async register(dto: RegisterDto, clientType: SessionClientType): Promise<AuthResult> {
    if (dto.termsVersion !== CURRENT_TERMS_VERSION || dto.privacyVersion !== CURRENT_PRIVACY_VERSION) {
      throw new BadRequestException('Accept the current terms and privacy policy versions.');
    }
    const birth = new Date(`${dto.birthDate}T00:00:00Z`);
    const cutoff = new Date(); cutoff.setUTCHours(0, 0, 0, 0); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 18);
    const oldest = new Date(); oldest.setUTCHours(0, 0, 0, 0); oldest.setUTCFullYear(oldest.getUTCFullYear() - 120);
    if (!Number.isFinite(birth.getTime()) || birth > cutoff || birth < oldest) throw new BadRequestException('Registration requires age 18 or older and a valid date of birth.');
    const passwordHash = await hashPassword(dto.password);
    const id = randomUUID(); const refreshToken = token(); const verificationToken = token();
    try {
      const saved = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT public.register_user(${id}::uuid, ${dto.email.toLowerCase()}, ${passwordHash}, ${dto.username.toLowerCase()}, ${dto.displayName.trim()}, ${dto.birthDate}::date, ${dto.termsVersion}, ${dto.privacyVersion}, ${dto.locale})`;
        const user = await tx.user.findUniqueOrThrow({ where: { id }, include: userInclude });
        const session = await this.newSession(tx, id, clientType, refreshToken);
        await this.challenge(tx, id, 'EMAIL_VERIFY', verificationToken);
        await this.audit(tx, id, 'AUTH_REGISTER');
        return { user, session };
      });
      const response = await this.result(saved.user, saved.session.id, refreshToken);
      response.emailDelivery = await this.mail.challenge(saved.user.email, 'EMAIL_VERIFY', verificationToken) ? 'sent' : 'unavailable';
      return response;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || (error.code === 'P2010' && error.meta?.code === '23505'))) throw new ConflictException('Email or username is already registered.');
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010' && error.meta?.code === '23514') throw new BadRequestException('Registration details do not satisfy the account policy.');
      throw error;
    }
  }

  async login(email: string, password: string, clientType: SessionClientType): Promise<AuthResult> {
    const candidate = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    const valid = await verifyPassword(password, candidate?.passwordHash ?? null);
    if (!valid || !candidate || candidate.status !== 'ACTIVE') throw new UnauthorizedException('Invalid credentials.');
    const refreshToken = token();
    const saved = await this.db.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, candidate.id);
      // A password reset racing the expensive hash check must invalidate login.
      if (!user || user.status !== 'ACTIVE' || user.passwordHash !== candidate.passwordHash) return null;
      const session = await this.newSession(tx, user.id, clientType, refreshToken);
      await this.audit(tx, user.id, 'AUTH_LOGIN');
      return { user, session };
    });
    if (!saved) throw new UnauthorizedException('Invalid credentials.');
    return this.result(saved.user, saved.session.id, refreshToken);
  }

  async refresh(raw: string, clientType: SessionClientType): Promise<AuthResult> {
    if (!validToken(raw)) throw new UnauthorizedException('Invalid refresh token.');
    const candidate = await this.db.session.findUnique({ where: { refreshTokenHash: digest(raw) } });
    if (!candidate) throw new UnauthorizedException('Invalid refresh token.');
    const nextToken = token();
    const saved = await this.db.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, candidate.userId);
      await tx.$queryRaw`SELECT id FROM public.sessions WHERE id = ${candidate.id}::uuid FOR UPDATE`;
      const session = await tx.session.findUnique({ where: { id: candidate.id } });
      if (!session || session.clientType !== clientType) return null;
      if (session.revokedAt || session.replacedById) {
        await tx.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.audit(tx, candidate.userId, 'AUTH_REFRESH_REPLAY_REVOKED');
        return null; // Commit revocation; throw only after the transaction ends.
      }
      if (!user || user.status !== 'ACTIVE' || session.expiresAt <= new Date()) return null;
      const next = await tx.session.create({ data: {
        userId: user.id, familyId: session.familyId, clientType,
        refreshTokenHash: digest(nextToken), expiresAt: session.expiresAt,
      } });
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), replacedById: next.id } });
      return { user, next };
    });
    if (!saved) throw new UnauthorizedException('Invalid refresh token.');
    return this.result(saved.user, saved.next.id, nextToken);
  }

  async authenticate(accessToken: string): Promise<Actor> {
    let payload: { sub: string; sid: string };
    try {
      payload = await this.jwt.verifyAsync(accessToken, { secret: this.config.jwtSecret, algorithms: ['HS256'], issuer: this.config.jwtIssuer, audience: this.config.jwtAudience });
      if (![payload.sub, payload.sid].every(value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) throw new Error('Malformed claims');
    } catch { throw new UnauthorizedException('Invalid access token.'); }
    const session = await this.db.session.findUnique({ where: { id: payload.sid }, include: { user: { include: { roles: { include: { role: true } } } } } });
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') throw new UnauthorizedException('Session is no longer active.');
    return { userId: session.userId, sessionId: session.id, familyId: session.familyId, roles: session.user.roles.map(item => item.role.name), permissions: [...new Set(session.user.roles.flatMap(item => item.role.permissions))] };
  }

  async logout(actor: Actor): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.lockedUser(tx, actor.userId);
      await tx.session.updateMany({ where: { userId: actor.userId, familyId: actor.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit(tx, actor.userId, 'AUTH_LOGOUT');
    });
  }

  async requestChallenge(email: string, kind: 'PASSWORD_RESET' | 'EMAIL_VERIFY'): Promise<void> {
    const candidate = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!candidate || candidate.status !== 'ACTIVE' || (kind === 'EMAIL_VERIFY' && candidate.emailVerifiedAt)) return;
    const raw = token();
    const created = await this.db.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, candidate.id);
      if (!user || user.status !== 'ACTIVE' || (kind === 'EMAIL_VERIFY' && user.emailVerifiedAt)) return false;
      await this.challenge(tx, user.id, kind, raw);
      return true;
    });
    if (created) await this.mail.challenge(candidate.email, kind, raw);
  }

  async consumeChallenge(raw: string, kind: 'PASSWORD_RESET' | 'EMAIL_VERIFY', password?: string): Promise<void> {
    if (!validToken(raw)) throw new BadRequestException('Invalid or expired link.');
    if (kind === 'PASSWORD_RESET' && !password) throw new BadRequestException('A new password is required.');
    const candidate = await this.db.authChallenge.findUnique({ where: { tokenHash: digest(raw) } });
    if (!candidate || candidate.kind !== kind) throw new BadRequestException('Invalid or expired link.');
    const nextHash = kind === 'PASSWORD_RESET' && password ? await hashPassword(password) : undefined;
    const accepted = await this.db.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, candidate.userId);
      await tx.$queryRaw`SELECT id FROM public.auth_challenges WHERE id = ${candidate.id}::uuid FOR UPDATE`;
      const challenge = await tx.authChallenge.findUnique({ where: { id: candidate.id } });
      if (!user || user.status !== 'ACTIVE' || !challenge || challenge.kind !== kind || challenge.consumedAt || challenge.expiresAt <= new Date()) return false;
      const now = new Date();
      await tx.authChallenge.updateMany({ where: { userId: user.id, kind, consumedAt: null }, data: { consumedAt: now } });
      if (kind === 'PASSWORD_RESET') {
        if (!nextHash) return false;
        await tx.user.update({ where: { id: user.id }, data: { passwordHash: nextHash } });
        await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      } else {
        await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
      }
      await this.audit(tx, user.id, kind === 'PASSWORD_RESET' ? 'AUTH_PASSWORD_RESET' : 'AUTH_EMAIL_VERIFIED');
      return true;
    });
    if (!accepted) throw new BadRequestException('Invalid or expired link.');
  }

  async verifyPasswordForUser(userId: string, password: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!await verifyPassword(password, user?.passwordHash ?? null) || user?.status !== 'ACTIVE') throw new UnauthorizedException('Invalid credentials.');
  }

  async deleteAccount(userId: string, password: string): Promise<void> {
    const candidate = await this.db.user.findUnique({ where: { id: userId } });
    if (!await verifyPassword(password, candidate?.passwordHash ?? null) || !candidate || candidate.status !== 'ACTIVE') throw new UnauthorizedException('Invalid credentials.');
    const accepted = await this.db.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, userId);
      if (!user || user.status !== 'ACTIVE' || user.passwordHash !== candidate.passwordHash) return false;
      await tx.$queryRaw`SELECT public.request_account_deletion(${userId}::uuid)`;
      return true;
    });
    if (!accepted) throw new UnauthorizedException('Invalid credentials.');
  }
}
