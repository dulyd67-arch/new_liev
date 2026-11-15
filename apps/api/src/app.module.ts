import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CoreModule } from './core.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { StreamsModule } from './streams/streams.module';
import { HealthController } from './health/health.controller';
import { DEPENDENCY_PROBE, DependencyProbeService } from './health/health.service';
import { PlatformController } from './platform.controller';
import { DuModule } from './du/du.module';
import { SocialModule } from './social/social.module';

@Module({
  imports: [CoreModule, AuthModule, UsersModule, StreamsModule, DuModule, SocialModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
  controllers: [HealthController, PlatformController],
  providers: [
    { provide: DEPENDENCY_PROBE, useClass: DependencyProbeService },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
