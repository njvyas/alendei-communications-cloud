import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

@Module({
  controllers: [ContactsController, SegmentsController],
  providers: [ContactsService, SegmentsService],
  exports: [ContactsService, SegmentsService],
})
export class ContactsModule {}
