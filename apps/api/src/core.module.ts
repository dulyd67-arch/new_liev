import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, parseEnvironment } from './config';
import { DatabaseService } from './database.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => parseEnvironment(process.env) },
    DatabaseService,
    RedisService,
  ],
  exports: [APP_CONFIG, DatabaseService, RedisService],
})
export class CoreModule {}
