import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Actor, AuthService } from './auth.service';

export interface AuthenticatedRequest extends Request { actor: Actor; }
const PERMISSIONS = 'livestar:permissions';
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS, permissions);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9._-]+$/.test(header)) throw new UnauthorizedException('Bearer authentication is required.');
    request.actor = await this.auth.authenticate(header.slice(7));
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, [context.getHandler(), context.getClass()]) ?? [];
    if (!required.every(permission => request.actor.permissions.includes(permission))) throw new ForbiddenException('Permission is required.');
    return true;
  }
}
