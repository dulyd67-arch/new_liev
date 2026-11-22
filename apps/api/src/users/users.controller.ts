import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { validateDto } from '../validation';
import { DeleteAccountDto, ProfilePageQueryDto, SearchUsersDto, UpdateProfileDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search active public profiles; credentials and private profile fields are excluded.' })
  search(@Query(validateDto(SearchUsersDto)) query: SearchUsersDto) { return this.users.search(query.query, query.limit); }

  @Get('me') @UseGuards(AuthGuard) @ApiBearerAuth()
  @ApiOperation({ summary: 'Read the authenticated account and its profile.' })
  me(@Req() request: AuthenticatedRequest) { return this.users.me(request.actor.userId); }

  @Patch('me') @UseGuards(AuthGuard) @ApiBearerAuth()
  @ApiOperation({ summary: 'Update your display name, bio, locale, time zone or validated profile photo.' })
  update(@Req() request: AuthenticatedRequest, @Body(validateDto(UpdateProfileDto)) input: UpdateProfileDto) {
    return this.users.updateProfile(request.actor.userId, input);
  }

  @Get('me/export') @UseGuards(AuthGuard) @ApiBearerAuth()
  @ApiOperation({ summary: 'Export your identity, profile, consent and follows data. Financial export is added with its modules.' })
  export(@Req() request: AuthenticatedRequest) { return this.users.exportIdentity(request.actor.userId); }

  @Delete('me') @UseGuards(AuthGuard) @ApiBearerAuth() @HttpCode(202)
  @ApiOperation({ summary: 'Request account deletion with password confirmation; revoke sessions and pseudonymize personal profile data.' })
  async remove(@Req() request: AuthenticatedRequest, @Body(validateDto(DeleteAccountDto)) input: DeleteAccountDto) {
    await this.auth.deleteAccount(request.actor.userId, input.password);
    return { status: 'deletion_pending', message: 'Access has been revoked. Required financial and audit records are retained.' };
  }

  @Get(':username/avatar')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @ApiProduces('image/jpeg', 'image/png', 'image/webp')
  @ApiOperation({ summary: 'Read the validated profile image of an active public account.' })
  async avatar(@Param('username') username: string) {
    const avatar = await this.users.avatar(username);
    return new StreamableFile(avatar.bytes, { type: avatar.contentType, length: avatar.bytes.length });
  }

  @Get(':username/followers')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Page active public followers, without private account fields.' })
  followers(@Param('username') username: string, @Query(validateDto(ProfilePageQueryDto)) query: ProfilePageQueryDto) {
    return this.users.connections(username, 'followers', query.cursor, query.limit);
  }

  @Get(':username/following')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Page active public followed accounts, without private account fields.' })
  following(@Param('username') username: string, @Query(validateDto(ProfilePageQueryDto)) query: ProfilePageQueryDto) {
    return this.users.connections(username, 'following', query.cursor, query.limit);
  }

  @Get(':username/streams')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Page completed public broadcast-session metadata. No recordings or terminated sessions are returned.' })
  broadcasts(@Param('username') username: string, @Query(validateDto(ProfilePageQueryDto)) query: ProfilePageQueryDto) {
    return this.users.broadcasts(username, query.cursor, query.limit);
  }

  @Get(':username')
  @ApiOperation({ summary: 'Read an active public profile.' })
  profile(@Param('username') username: string) { return this.users.publicProfile(username); }
}
