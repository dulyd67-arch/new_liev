import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest, AuthGuard } from '../auth/auth.guard';
import { validateDto } from '../validation';
import { ClaimDuDto, DuCatalogDto, DuFeedQueryDto, DuGiftFeedDto, DuHistoryDto, DuHistoryQueryDto, DuMutationDto, DuWalletDto, SendDuGiftDto } from './du.dto';
import { DuService } from './du.service';

@ApiTags('DU promotional gifts')
@Controller('wallet')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class DuWalletController {
  constructor(@Inject(DuService) private readonly du: DuService) {}

  @Get() @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read your promotional DU wallet. DU cannot be purchased, redeemed, withdrawn or exchanged for money.' })
  @ApiOkResponse({ type: DuWalletDto })
  wallet(@Req() request: AuthenticatedRequest) { return this.du.wallet(request.actor.userId); }

  @Get('history') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read your own persistent promotional DU transaction history, newest first.' })
  @ApiOkResponse({ type: DuHistoryDto })
  history(@Req() request: AuthenticatedRequest, @Query(validateDto(DuHistoryQueryDto)) query: DuHistoryQueryDto) {
    return this.du.history(request.actor.userId, query.cursor);
  }

  @Post('claim') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Explicitly claim 100 free promotional DU once per account. Retrying the same UUID never grants a second claim.' })
  @ApiBody({ type: ClaimDuDto })
  @ApiOkResponse({ type: DuMutationDto })
  claim(@Req() request: AuthenticatedRequest, @Body(validateDto(ClaimDuDto)) input: ClaimDuDto) {
    return this.du.claim(request.actor.userId, input.idempotencyKey);
  }
}

@ApiTags('DU promotional gifts')
@Controller('gifts')
export class DuCatalogController {
  constructor(@Inject(DuService) private readonly du: DuService) {}

  @Get()
  @ApiOperation({ summary: 'Browse promotional gifts and exact DU prices. Purchasing and cash payouts are unavailable.' })
  @ApiOkResponse({ type: DuCatalogDto })
  catalog() { return this.du.catalog(); }
}

@ApiTags('DU promotional gifts')
@Controller('streams')
export class DuStreamGiftsController {
  constructor(@Inject(DuService) private readonly du: DuService) {}

  @Get(':id/gifts') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @ApiOperation({ summary: 'Read stream gift totals and poll persisted events by sequence. The initial request returns the latest cursor without replaying historical animations.' })
  @ApiOkResponse({ type: DuGiftFeedDto })
  feed(@Param('id', new ParseUUIDPipe()) id: string, @Query(validateDto(DuFeedQueryDto)) query: DuFeedQueryDto) {
    return this.du.feed(id, query.after);
  }

  @Post(':id/gifts') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard) @ApiBearerAuth()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Atomically send a promotional DU gift to a live broadcaster. Self gifts and blocked accounts are refused; retries with the same UUID do not spend twice.' })
  @ApiBody({ type: SendDuGiftDto })
  @ApiOkResponse({ type: DuMutationDto })
  send(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(SendDuGiftDto)) input: SendDuGiftDto) {
    return this.du.send(request.actor.userId, id, input);
  }
}
