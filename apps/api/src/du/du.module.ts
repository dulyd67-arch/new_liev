import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoreModule } from '../core.module';
import { DuCatalogController, DuStreamGiftsController, DuWalletController } from './du.controller';
import { DuService } from './du.service';

@Module({
  imports: [CoreModule, AuthModule],
  controllers: [DuWalletController, DuCatalogController, DuStreamGiftsController],
  providers: [DuService],
})
export class DuModule {}
