import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CoreModule } from '../core.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';

@Module({
  imports: [CoreModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, MailService],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
