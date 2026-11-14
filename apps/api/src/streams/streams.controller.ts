import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest, AuthGuard } from '../auth/auth.guard';
import { validateDto } from '../validation';
import { CreateStreamDto, MessageDto, MessageQueryDto, StreamQueryDto } from './streams.dto';
import { StreamsService } from './streams.service';

@ApiTags('Live streams')
@Controller('streams')
export class StreamsController {
  constructor(@Inject(StreamsService) private readonly streams: StreamsService) {}

  @Get()
  @ApiOperation({ summary: 'Find active public livestreams and actual media-server viewer counts.' })
  list(@Query(validateDto(StreamQueryDto)) query: StreamQueryDto) { return this.streams.list(query); }

  @Get('mine') @UseGuards(AuthGuard) @ApiBearerAuth()
  mine(@Req() request: AuthenticatedRequest) { return this.streams.mine(request.actor.userId); }

  @Post() @UseGuards(AuthGuard) @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a room and obtain an owner-only publish token; publishing does not begin until camera/mic tracks are connected.' })
  create(@Req() request: AuthenticatedRequest, @Body(validateDto(CreateStreamDto)) input: CreateStreamDto) {
    return this.streams.create(request.actor.userId, input);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) { return this.streams.get(id); }

  @Post(':id/host-token') @UseGuards(AuthGuard) @ApiBearerAuth()
  hostToken(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) {
    return this.streams.hostToken(id, request.actor.userId);
  }

  @Post(':id/token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get an anonymous, subscribe-only viewer token. It cannot publish media or data.' })
  viewerToken(@Param('id', new ParseUUIDPipe()) id: string) { return this.streams.viewerToken(id); }

  @Post(':id/activate') @UseGuards(AuthGuard) @ApiBearerAuth()
  activate(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) {
    return this.streams.activate(id, request.actor.userId);
  }

  @Post(':id/end') @UseGuards(AuthGuard) @ApiBearerAuth()
  @ApiOperation({ summary: 'Stop the actual media room, then mark the stream ended.' })
  end(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) {
    return this.streams.end(id, request.actor.userId);
  }

  @Get(':id/messages')
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  messages(@Param('id', new ParseUUIDPipe()) id: string, @Query(validateDto(MessageQueryDto)) query: MessageQueryDto) {
    return this.streams.messages(id, query.after);
  }

  @Post(':id/messages') @UseGuards(AuthGuard) @ApiBearerAuth()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  sendMessage(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(MessageDto)) input: MessageDto) {
    return this.streams.sendMessage(id, request.actor.userId, input.body);
  }
}
