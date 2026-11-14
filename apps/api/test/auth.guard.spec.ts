import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';

function context(authorization?: string): { context: ExecutionContext; request: Record<string, unknown> } {
  const request = { headers: { authorization } };
  return {
    request,
    context: { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => () => undefined, getClass: () => class Controller {} } as unknown as ExecutionContext,
  };
}

describe('permission guard', () => {
  it('requires current server-derived permissions even when the user has an admin role name', async () => {
    const authenticate = vi.fn().mockResolvedValue({ userId: 'member', roles: ['ADMIN'], permissions: ['profile:own'] });
    const reflector = { getAllAndOverride: () => ['role:manage'] };
    const guard = new AuthGuard({ authenticate } as unknown as AuthService, reflector as unknown as Reflector);
    const request = context('Bearer signed.token.value');
    await expect(guard.canActivate(request.context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authenticate).toHaveBeenCalledWith('signed.token.value');
  });

  it('binds the verified actor and permits only the required permission set', async () => {
    const actor = { userId: 'member', permissions: ['profile:own', 'role:manage'], roles: ['SUPER_ADMIN'] };
    const guard = new AuthGuard({ authenticate: async () => actor } as unknown as AuthService, { getAllAndOverride: () => ['role:manage'] } as unknown as Reflector);
    const request = context('Bearer signed.token.value');
    expect(await guard.canActivate(request.context)).toBe(true);
    expect(request.request.actor).toBe(actor);
  });

  it('rejects missing or malformed bearer headers before calling authentication', async () => {
    const authenticate = vi.fn();
    const guard = new AuthGuard({ authenticate } as unknown as AuthService, {} as Reflector);
    for (const header of [undefined, 'Basic abc', 'Bearer token extra']) {
      await expect(guard.canActivate(context(header).context)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(authenticate).not.toHaveBeenCalled();
  });
});
