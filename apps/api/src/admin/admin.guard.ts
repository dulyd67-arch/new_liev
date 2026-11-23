import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/auth.guard';

// AuthGuard authenticates the session and reads roles from PostgreSQL first.
// Neither client-supplied role claims nor the presence of a frontend route grant access.
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const actor = context.switchToHttp().getRequest<AuthenticatedRequest>().actor;
    if (!actor?.roles.some(role => role === 'ADMIN' || role === 'SUPER_ADMIN')) {
      throw new ForbiddenException({ code: 'ADMIN_FORBIDDEN', message: 'Administrator access is required.' });
    }
    return true;
  }
}
