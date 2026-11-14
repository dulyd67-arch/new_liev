import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';

export const DEPENDENCY_PROBE = Symbol('DEPENDENCY_PROBE');
export type DependencyState = 'up' | 'down';
export interface DependencyStatus {
  postgres: DependencyState;
  redis: DependencyState | 'disabled';
}
export interface DependencyProbe {
  check(): Promise<DependencyStatus>;
}

async function boundedProbe(operation: () => Promise<void>): Promise<DependencyState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Readiness timeout')), 2000);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class DependencyProbeService implements DependencyProbe {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async check(): Promise<DependencyStatus> {
    const [postgres, redis] = await Promise.all([
      boundedProbe(() => this.database.probe()),
      this.redis.isEnabled() ? boundedProbe(() => this.redis.probe()) : Promise.resolve('disabled' as const),
    ]);
    return { postgres, redis };
  }
}
