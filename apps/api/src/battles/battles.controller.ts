import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest, AuthGuard } from '../auth/auth.guard';
import { validateDto } from '../validation';
import { BattleActionDto, BattleCandidatesDto, BattleInvitationsDto, BattleSnapshotDto, InviteBattleDto, LikeMutationDto, LikeTotalDto, SendLikesDto } from './battles.dto';
import { BattlesService } from './battles.service';

@ApiTags('PK battles')
@Controller('battles')
@UseGuards(AuthGuard) @ApiBearerAuth()
export class BattlesController {
  constructor(@Inject(BattlesService) private readonly battles: BattlesService) {}

  @Get('invitations') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @ApiOkResponse({ type: BattleInvitationsDto })
  @ApiOperation({ summary: 'Read your own incoming, unexpired PK invitations.' })
  invitations(@Req() request: AuthenticatedRequest) { return this.battles.invitations(request.actor.userId); }

  @Get('candidates') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOkResponse({ type: BattleCandidatesDto })
  @ApiOperation({ summary: 'Find actual live broadcasters, excluding yourself and accounts blocked in either direction.' })
  candidates(@Req() request: AuthenticatedRequest) { return this.battles.candidates(request.actor.userId); }

  @Post(':id/accept') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiBody({ type: BattleActionDto }) @ApiOkResponse({ type: BattleSnapshotDto })
  @ApiOperation({ summary: 'Accept your incoming invitation. Both broadcasters must still be publishing media.' })
  accept(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(BattleActionDto)) _input: BattleActionDto) {
    return this.battles.respond(request.actor.userId, id, 'ACCEPT');
  }

  @Post(':id/decline') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiBody({ type: BattleActionDto }) @ApiOkResponse({ type: BattleSnapshotDto })
  @ApiOperation({ summary: 'Decline your incoming invitation.' })
  decline(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(BattleActionDto)) _input: BattleActionDto) {
    return this.battles.respond(request.actor.userId, id, 'DECLINE');
  }

  @Post(':id/cancel') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiBody({ type: BattleActionDto }) @ApiOkResponse({ type: BattleSnapshotDto })
  @ApiOperation({ summary: 'Cancel your own outgoing invitation.' })
  cancel(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(BattleActionDto)) _input: BattleActionDto) {
    return this.battles.respond(request.actor.userId, id, 'CANCEL');
  }

  @Post(':id/leave') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiBody({ type: BattleActionDto }) @ApiOkResponse({ type: BattleSnapshotDto })
  @ApiOperation({ summary: 'Forfeit an active PK battle without ending your own livestream.' })
  leave(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(BattleActionDto)) _input: BattleActionDto) {
    return this.battles.respond(request.actor.userId, id, 'LEAVE');
  }
}

@ApiTags('PK battles', 'Live likes')
@Controller('streams')
export class BattleStreamsController {
  constructor(@Inject(BattlesService) private readonly battles: BattlesService) {}

  @Get(':id/battle') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @ApiOkResponse({ type: BattleSnapshotDto })
  @ApiOperation({ summary: 'Read the current or most recent PK battle with authoritative server time and exact DU scores.' })
  snapshot(@Param('id', new ParseUUIDPipe()) id: string) { return this.battles.snapshot(id); }

  @Post(':id/battles') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard) @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBody({ type: InviteBattleDto }) @ApiOkResponse({ type: BattleSnapshotDto })
  @ApiOperation({ summary: 'Invite another live broadcaster to a five-minute PK battle. Retrying the same UUID keeps the original invitation.' })
  invite(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(InviteBattleDto)) input: InviteBattleDto) {
    return this.battles.invite(request.actor.userId, id, input);
  }

  @Get(':id/likes') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @ApiOkResponse({ type: LikeTotalDto })
  @ApiOperation({ summary: 'Read genuine authenticated likes. Likes are separate from PK DU scores.' })
  likes(@Param('id', new ParseUUIDPipe()) id: string) { return this.battles.likes(id); }

  @Post(':id/likes') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard) @ApiBearerAuth()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiBody({ type: SendLikesDto }) @ApiOkResponse({ type: LikeMutationDto })
  @ApiOperation({ summary: 'Send 1–20 authenticated likes, at most 120 per user per minute across streams. Retrying the same UUID adds nothing twice.' })
  sendLikes(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(SendLikesDto)) input: SendLikesDto) {
    return this.battles.sendLikes(request.actor.userId, id, input);
  }
}
