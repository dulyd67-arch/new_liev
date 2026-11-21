import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoreModule } from '../core.module';
import { StreamsModule } from '../streams/streams.module';
import { BattlesController, BattleStreamsController } from './battles.controller';
import { BattlesService } from './battles.service';

@Module({
  imports: [CoreModule, AuthModule, StreamsModule],
  controllers: [BattlesController, BattleStreamsController],
  providers: [BattlesService],
})
export class BattlesModule {}
