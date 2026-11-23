import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoreModule } from '../core.module';
import { StreamsModule } from '../streams/streams.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Module({
  imports: [CoreModule, AuthModule, StreamsModule],
  controllers: [AdminController],
  providers: [AdminGuard, AdminService],
})
export class AdminModule {}
