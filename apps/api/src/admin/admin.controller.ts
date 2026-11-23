import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest, AuthGuard } from '../auth/auth.guard';
import { validateDto } from '../validation';
import { AdminPageQueryDto, AdminReasonDto, AdminReportsQueryDto, AdminReviewReportDto, AdminStreamsQueryDto, AdminUsersQueryDto } from './admin.dto';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@ApiTags('Administration')
@ApiBearerAuth()
@UseGuards(AuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('overview') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read real account, open-session, report and promotional DU aggregates.' })
  overview() { return this.admin.overview(); }

  @Get('users') @Header('Cache-Control', 'no-store')
  users(@Query(validateDto(AdminUsersQueryDto)) query: AdminUsersQueryDto) { return this.admin.users(query); }

  @Get('streams') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  streams(@Query(validateDto(AdminStreamsQueryDto)) query: AdminStreamsQueryDto) { return this.admin.streams(query); }

  @Get('reports') @Header('Cache-Control', 'no-store')
  reports(@Query(validateDto(AdminReportsQueryDto)) query: AdminReportsQueryDto) { return this.admin.reports(query); }

  @Get('audit') @Header('Cache-Control', 'no-store')
  audit(@Query(validateDto(AdminPageQueryDto)) query: AdminPageQueryDto) { return this.admin.audit(query); }

  @Post('users/:id/suspend') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  suspend(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(AdminReasonDto)) input: AdminReasonDto) {
    return this.admin.setUserStatus(request.actor.userId, id, 'SUSPENDED', input);
  }

  @Post('users/:id/restore') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  restore(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(AdminReasonDto)) input: AdminReasonDto) {
    return this.admin.setUserStatus(request.actor.userId, id, 'ACTIVE', input);
  }

  @Post('streams/:id/terminate') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  terminate(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(AdminReasonDto)) input: AdminReasonDto) {
    return this.admin.terminateStream(request.actor.userId, id, input);
  }

  @Patch('reports/:id') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  review(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Body(validateDto(AdminReviewReportDto)) input: AdminReviewReportDto) {
    return this.admin.reviewReport(request.actor.userId, id, input);
  }
}
