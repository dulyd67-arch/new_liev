import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { validateDto } from '../validation';
import { DeleteAccountDto, SearchUsersDto, UpdateProfileDto } from './users.dto';
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
  @ApiOperation({ summary: 'Update only your display name, bio, locale or time zone.' })
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

  @Get(':username')
  @ApiOperation({ summary: 'Read an active public profile.' })
  profile(@Param('username') username: string) { return this.users.publicProfile(username); }
}
