import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest, AuthGuard } from '../auth/auth.guard';
import { validateDto } from '../validation';
import { FollowStatusDto, ReportReceiptDto, ReportStreamDto } from './social.dto';
import { SocialService } from './social.service';

@ApiTags('Social')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('social')
export class SocialController {
  constructor(@Inject(SocialService) private readonly social: SocialService) {}

  @Get(':userId')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: FollowStatusDto })
  @ApiOperation({ summary: 'Read whether you follow an active account.' })
  status(@Param('userId', new ParseUUIDPipe()) targetId: string, @Req() request: AuthenticatedRequest) {
    return this.social.status(request.actor.userId, targetId);
  }

  @Post(':userId/follow') @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ type: FollowStatusDto })
  @ApiOperation({ summary: 'Follow an active account. Repeated requests keep one follow.' })
  follow(@Param('userId', new ParseUUIDPipe()) targetId: string, @Req() request: AuthenticatedRequest) {
    return this.social.follow(request.actor.userId, targetId, true);
  }

  @Delete(':userId/follow') @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ type: FollowStatusDto })
  @ApiOperation({ summary: 'Stop following an active account.' })
  unfollow(@Param('userId', new ParseUUIDPipe()) targetId: string, @Req() request: AuthenticatedRequest) {
    return this.social.follow(request.actor.userId, targetId, false);
  }
}

@ApiTags('Social')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('streams')
export class StreamReportsController {
  constructor(@Inject(SocialService) private readonly social: SocialService) {}

  @Post(':id/report') @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOkResponse({ type: ReportReceiptDto, description: 'A persistent report for moderator review.' })
  @ApiOperation({ summary: 'Report a livestream and its creator for moderator review.' })
  @ApiBody({ type: ReportStreamDto })
  report(@Param('id', new ParseUUIDPipe()) streamId: string, @Req() request: AuthenticatedRequest, @Body(validateDto(ReportStreamDto)) input: ReportStreamDto) {
    return this.social.report(request.actor.userId, streamId, input.reason);
  }
}
