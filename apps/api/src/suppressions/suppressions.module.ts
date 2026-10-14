import { Module } from '@nestjs/common';
import { SuppressionsController } from './suppressions.controller';
import { SuppressionsService } from './suppressions.service';

@Module({
  controllers: [SuppressionsController],
  providers: [SuppressionsService],
  exports: [SuppressionsService],
})
export class SuppressionsModule {}
