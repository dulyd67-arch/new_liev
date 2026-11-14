import { describe, expect, it, vi } from 'vitest';
import { DependencyProbeService } from '../src/health/health.service';
import { DatabaseService } from '../src/database.service';
import { RedisService } from '../src/redis.service';
import { HealthController } from '../src/health/health.controller';
import { ServiceUnavailableException } from '@nestjs/common';

describe('dependency readiness', () => {
  it('checks actual dependency probes and isolates failures', async () => {
    const database = { probe: vi.fn().mockRejectedValue(new Error('postgresql://private-value')) };
    const redis = { isEnabled: () => true, probe: vi.fn().mockResolvedValue(undefined) };
    const service = new DependencyProbeService(database as unknown as DatabaseService, redis as unknown as RedisService);
    expect(await service.check()).toEqual({ postgres: 'down', redis: 'up' });
    expect(database.probe).toHaveBeenCalledOnce();
    expect(redis.probe).toHaveBeenCalledOnce();
  });

  it('bounds requests when a dependency never responds', async () => {
    vi.useFakeTimers();
    try {
      const database = { probe: () => new Promise<void>(() => undefined) };
      const redis = { isEnabled: () => true, probe: async () => undefined };
      const service = new DependencyProbeService(database as unknown as DatabaseService, redis as unknown as RedisService);
      const result = service.check();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toEqual({ postgres: 'down', redis: 'up' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports explicitly disabled Redis instead of pretending it was probed', async () => {
    const database = { probe: vi.fn().mockResolvedValue(undefined) };
    const redis = { isEnabled: () => false, probe: vi.fn() };
    const service = new DependencyProbeService(database as unknown as DatabaseService, redis as unknown as RedisService);
    expect(await service.check()).toEqual({ postgres: 'up', redis: 'disabled' });
    expect(redis.probe).not.toHaveBeenCalled();
    const controller = new HealthController(service);
    expect(await controller.ready()).toEqual({ status: 'ready', dependencies: { postgres: 'up', redis: 'disabled' } });
  });

  it('does not hide a PostgreSQL outage when Redis is disabled', async () => {
    const database = { probe: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const redis = { isEnabled: () => false, probe: vi.fn() };
    const service = new DependencyProbeService(database as unknown as DatabaseService, redis as unknown as RedisService);
    await expect(new HealthController(service).ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await service.check()).toEqual({ postgres: 'down', redis: 'disabled' });
    expect(redis.probe).not.toHaveBeenCalled();
  });
});
