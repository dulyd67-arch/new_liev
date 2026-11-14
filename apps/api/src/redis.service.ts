import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from './config';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client?: Redis;
  private connecting?: Promise<void>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (!config.redisUrl) return;
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 1500,
      commandTimeout: 1500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    // Readiness reports failure without exposing connection URLs in logs.
    this.client.on('error', () => undefined);
  }

  isEnabled(): boolean { return this.client !== undefined; }

  async probe(): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (['wait', 'end'].includes(client.status)) {
      this.connecting ??= client.connect().finally(() => { this.connecting = undefined; });
    }
    if (this.connecting) await this.connecting;
    if (await client.ping() !== 'PONG') throw new Error('Redis readiness failed');
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.disconnect();
  }
}
