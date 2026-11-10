import { Module } from '@nestjs/common';
import { ContactExportService } from './contact-export.service';
import { ContactImportService } from './contact-import.service';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

@Module({
  controllers: [ContactsController, SegmentsController],
  providers: [ContactsService, SegmentsService, ContactImportService, ContactExportService],
  exports: [ContactsService, SegmentsService, ContactImportService, ContactExportService],
})
export class ContactsModule {}
