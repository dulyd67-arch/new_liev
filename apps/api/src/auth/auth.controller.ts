import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Post, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { APP_CONFIG, AppConfig } from '../config';
import { validateDto } from '../validation';
import { ChallengeDto, EmailDto, LoginDto, RefreshDto, RegisterDto, ResetPasswordDto } from './auth.dto';
import { AuthenticatedRequest, AuthGuard } from './auth.guard';
import { AuthResult, AuthService } from './auth.service';

const COOKIE = 'livestar_refresh';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private requireWebOrigin(request: Request): void {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !this.config.webOrigins.includes(origin)) throw new ForbiddenException('A trusted browser origin is required.');
  }

  private rejectUntrustedOrigin(request: Request): void {
    const origin = request.headers.origin;
    if (origin !== undefined && !this.config.webOrigins.includes(origin)) throw new ForbiddenException('Untrusted origin.');
  }

  private finishWeb(result: AuthResult, response: Response): Omit<AuthResult, 'refreshToken'> {
    response.cookie(COOKIE, result.refreshToken, {
      httpOnly: true, secure: this.config.environment === 'production', sameSite: 'strict',
      path: '/api/v1/auth', maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    const { refreshToken: _privateToken, ...body } = result;
    response.setHeader('Cache-Control', 'no-store');
    return body;
  }

  private cookie(request: Request): string {
    const values = (request.headers.cookie ?? '').split(';').map(segment => segment.trim()).filter(segment => segment.startsWith(`${COOKIE}=`));
    if (values.length !== 1) throw new UnauthorizedException('Refresh cookie is required.');
    const value = values[0]!.slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new UnauthorizedException('Invalid refresh cookie.');
    return value;
  }

  @Post('register') @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register an adult self-attested account; assign USER only; send verification email.' })
  async register(@Body(validateDto(RegisterDto)) dto: RegisterDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.requireWebOrigin(request);
    return this.finishWeb(await this.auth.register(dto, 'WEB'), response);
  }

  @Post('mobile/register') @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async mobileRegister(@Body(validateDto(RegisterDto)) dto: RegisterDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.rejectUntrustedOrigin(request); response.setHeader('Cache-Control', 'no-store');
    return this.auth.register(dto, 'MOBILE');
  }

  @Post('login') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body(validateDto(LoginDto)) dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.requireWebOrigin(request);
    return this.finishWeb(await this.auth.login(dto.email, dto.password, 'WEB'), response);
  }

  @Post('mobile/login') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async mobileLogin(@Body(validateDto(LoginDto)) dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.rejectUntrustedOrigin(request); response.setHeader('Cache-Control', 'no-store');
    return this.auth.login(dto.email, dto.password, 'MOBILE');
  }

  @Post('refresh') @HttpCode(200) @ApiCookieAuth(COOKIE)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.requireWebOrigin(request);
    try { return this.finishWeb(await this.auth.refresh(this.cookie(request), 'WEB'), response); }
    catch (error) {
      response.clearCookie(COOKIE, { path: '/api/v1/auth', sameSite: 'strict', secure: this.config.environment === 'production' });
      throw error;
    }
  }

  @Post('mobile/refresh') @HttpCode(200)
  async mobileRefresh(@Body(validateDto(RefreshDto)) dto: RefreshDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.rejectUntrustedOrigin(request); response.setHeader('Cache-Control', 'no-store');
    return this.auth.refresh(dto.refreshToken, 'MOBILE');
  }

  @Post('logout') @HttpCode(204) @UseGuards(AuthGuard) @ApiBearerAuth()
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    this.requireWebOrigin(request);
    await this.auth.logout(request.actor);
    response.clearCookie(COOKIE, { path: '/api/v1/auth', sameSite: 'strict', secure: this.config.environment === 'production' });
  }

  @Post('mobile/logout') @HttpCode(204) @UseGuards(AuthGuard) @ApiBearerAuth()
  async mobileLogout(@Req() request: AuthenticatedRequest): Promise<void> {
    this.rejectUntrustedOrigin(request);
    await this.auth.logout(request.actor);
  }

  @Get('me') @UseGuards(AuthGuard) @ApiBearerAuth()
  me(@Req() request: AuthenticatedRequest) { return request.actor; }

  @Post('password/forgot') @HttpCode(202) @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async forgot(@Body(validateDto(EmailDto)) dto: EmailDto, @Req() request: Request) {
    this.rejectUntrustedOrigin(request);
    if (!this.config.emailEnabled) throw new ServiceUnavailableException('Email-based account recovery is not enabled for this deployment.');
    await this.auth.requestChallenge(dto.email, 'PASSWORD_RESET');
    return { message: 'If an eligible account exists, an email will be sent.' };
  }

  @Post('password/reset') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reset(@Body(validateDto(ResetPasswordDto)) dto: ResetPasswordDto, @Req() request: Request) {
    this.rejectUntrustedOrigin(request);
    await this.auth.consumeChallenge(dto.token, 'PASSWORD_RESET', dto.password);
    return { ok: true };
  }

  @Post('email/verify') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verify(@Body(validateDto(ChallengeDto)) dto: ChallengeDto, @Req() request: Request) {
    this.rejectUntrustedOrigin(request);
    await this.auth.consumeChallenge(dto.token, 'EMAIL_VERIFY');
    return { ok: true };
  }

  @Post('email/resend') @HttpCode(202) @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async resend(@Body(validateDto(EmailDto)) dto: EmailDto, @Req() request: Request) {
    this.rejectUntrustedOrigin(request);
    if (!this.config.emailEnabled) throw new ServiceUnavailableException('Email verification messages are not enabled for this deployment.');
    await this.auth.requestChallenge(dto.email, 'EMAIL_VERIFY');
    return { message: 'If an eligible account exists, an email will be sent.' };
  }
}
