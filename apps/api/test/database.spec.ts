import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnvironment } from '../src/config';
import { DatabaseService } from '../src/database.service';

describe('PostgreSQL readiness resource use', () => {
  const instances: DatabaseService[] = [];
  const createService = () => {
    const service = new DatabaseService(parseEnvironment({
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
    }));
    instances.push(service);
    return service;
  };

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((service) => service.onModuleDestroy()));
  });

  it('shares a slow query across concurrent readiness requests and probes again after recovery', async () => {
    const service = createService();
    let resolveQuery!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { resolveQuery = resolve; });
    const query = vi.spyOn(service, '$queryRaw').mockReturnValueOnce(pending as never);

    const requests = [service.probe(), service.probe(), service.probe()];
    expect(query).toHaveBeenCalledTimes(1);
    resolveQuery([{ '?column?': 1 }]);
    await Promise.all(requests);

    query.mockReturnValueOnce(Promise.resolve([{ '?column?': 1 }]) as never);
    await service.probe();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('releases a failed probe so a restored database can become ready', async () => {
    const service = createService();
    const query = vi.spyOn(service, '$queryRaw')
      .mockReturnValueOnce(Promise.reject(new Error('database unavailable')) as never)
      .mockReturnValueOnce(Promise.resolve([{ '?column?': 1 }]) as never);

    await expect(service.probe()).rejects.toThrow('database unavailable');
    await expect(service.probe()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
