import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoreModule } from '../core.module';
import { LiveKitService } from './livekit.service';
import { StreamsController } from './streams.controller';
import { StreamsService } from './streams.service';

@Module({
  imports: [CoreModule, AuthModule],
  controllers: [StreamsController],
  providers: [LiveKitService, StreamsService],
  exports: [LiveKitService, StreamsService],
})
export class StreamsModule {}
