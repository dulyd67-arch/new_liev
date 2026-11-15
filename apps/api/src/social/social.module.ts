import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoreModule } from '../core.module';
import { SocialController, StreamReportsController } from './social.controller';
import { SocialService } from './social.service';

@Module({ imports: [CoreModule, AuthModule], controllers: [SocialController, StreamReportsController], providers: [SocialService] })
export class SocialModule {}
