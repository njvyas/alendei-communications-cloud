import { Module } from '@nestjs/common';

import { ResellersController } from './resellers.controller';
import { ResellersService } from './resellers.service';

/** Reseller administration and hierarchy management (Phase 4, U13). */
@Module({
  controllers: [ResellersController],
  providers: [ResellersService],
  exports: [ResellersService],
})
export class ResellersModule {}
