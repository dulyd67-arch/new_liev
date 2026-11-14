import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@livestar/database';
import { APP_CONFIG, AppConfig } from './config';

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleDestroy {
  private pendingProbe?: Promise<void>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ datasources: { db: { url: config.databaseUrl } }, log: [] });
  }

  async probe(): Promise<void> {
    // The HTTP readiness deadline cannot cancel an already issued Prisma query.
    // Share that query until it settles so repeated probes cannot fill the pool
    // with work during a database outage.
    this.pendingProbe ??= this.$queryRaw`SELECT 1`
      .then(() => undefined)
      .finally(() => { this.pendingProbe = undefined; });
    await this.pendingProbe;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
