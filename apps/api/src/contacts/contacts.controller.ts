import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiErrors, ApiIdempotencyKey } from '../openapi/openapi-responses';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import {
  CreateContactDto,
  CreateContactIdentityDto,
  CreateConsentEventDto,
  ExportContactsDto,
  GetEffectiveConsentDto,
  ImportContactsDto,
  ListContactActivitiesDto,
  ListContactsDto,
  ResolveAudienceDto,
  UpdateContactDto,
  UpdateContactIdentityDto,
} from './contacts.dto';
import { ContactExportService } from './contact-export.service';
import { ContactImportService } from './contact-import.service';
import { ContactsService } from './contacts.service';

const AT_WORKSPACE = 'the target is the workspace resolved from path or contact record';

@ApiTags('contacts')
@Controller()
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly importService: ContactImportService,
    private readonly exportService: ContactExportService,
  ) {}

  // --- Contacts under workspace ------------------------------------------------

  @Get('workspaces/:workspaceId/contacts')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List contacts in a workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async list(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query() query: ListContactsDto,
  ) {
    const { items, page } = await this.contacts.list(requestPrincipal(), workspaceId, {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
    });
    return { data: items, page };
  }

  @Post('workspaces/:workspaceId/contacts')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Create a contact in a workspace' })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() dto: CreateContactDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.contacts.create(
      requestPrincipal(),
      workspaceId,
      dto,
      idempotencyKey,
    );
    response.status(outcome.status);
    return outcome.body;
  }

  // --- Contacts Bulk Import & Export (Phase 8A-2) ------------------------------

  @Post('workspaces/:workspaceId/contacts/import')
  @RequiresPermission(PERMISSIONS.CONTACTS_IMPORT, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Import contacts, identities and consent into a workspace' })
  @ApiErrors(400, 401, 403, 404, 409, 413, 415, 422, 429)
  async importContacts(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() dto: ImportContactsDto,
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const mergedDto: ImportContactsDto = {
      ...dto,
      mode: dto.mode ?? (query.mode as ImportContactsDto['mode']),
      duplicateStrategy:
        dto.duplicateStrategy ??
        (query.duplicateStrategy as ImportContactsDto['duplicateStrategy']),
      defaultPhoneChannelId: dto.defaultPhoneChannelId ?? query.defaultPhoneChannelId,
      defaultEmailChannelId: dto.defaultEmailChannelId ?? query.defaultEmailChannelId,
    };

    const outcome = await this.importService.importContacts(
      requestPrincipal(),
      workspaceId,
      mergedDto,
    );
    response.status(outcome.status);
    return outcome.body;
  }

  @Post('workspaces/:workspaceId/contacts/export')
  @RequiresPermission(PERMISSIONS.CONTACTS_EXPORT, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Stream contacts export from a workspace' })
  @ApiErrors(400, 401, 403, 404, 422, 429)
  async exportContactsPost(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() dto: ExportContactsDto,
    @Res() response: Response,
  ) {
    await this.exportService.exportContacts(requestPrincipal(), workspaceId, dto, response);
  }

  @Get('workspaces/:workspaceId/contacts/export')
  @RequiresPermission(PERMISSIONS.CONTACTS_EXPORT, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Stream contacts export from a workspace (GET download)' })
  @ApiErrors(400, 401, 403, 404, 422, 429)
  async exportContactsGet(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query() query: ExportContactsDto,
    @Res() response: Response,
  ) {
    await this.exportService.exportContacts(requestPrincipal(), workspaceId, query, response);
  }

  @Get('workspaces/:workspaceId/contacts/:contactId')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a contact by workspace and id' })
  @ApiErrors(400, 401, 403, 404, 429)
  async getByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
  ) {
    return { data: await this.contacts.get(requestPrincipal(), contactId, workspaceId) };
  }

  @Get('contacts/:contactId')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a contact by id' })
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('contactId', new ParseUUIDPipe()) contactId: string) {
    return { data: await this.contacts.get(requestPrincipal(), contactId) };
  }

  @Get('workspaces/:workspaceId/contacts/:contactId/activities')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List activities of a contact in a workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async listActivitiesByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Query() query: ListContactActivitiesDto,
  ) {
    const { items, page } = await this.contacts.listActivities(
      requestPrincipal(),
      contactId,
      query,
      workspaceId,
    );
    return { data: items, page };
  }

  @Get('contacts/:contactId/activities')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List activities of a contact' })
  @ApiErrors(400, 401, 403, 404, 429)
  async listActivities(
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Query() query: ListContactActivitiesDto,
  ) {
    const { items, page } = await this.contacts.listActivities(
      requestPrincipal(),
      contactId,
      query,
    );
    return { data: items, page };
  }

  @Patch('workspaces/:workspaceId/contacts/:contactId')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a contact' })
  @ApiErrors(400, 401, 403, 404, 429)
  async updateByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() dto: UpdateContactDto,
  ) {
    return {
      data: await this.contacts.update(requestPrincipal(), contactId, dto, workspaceId),
    };
  }

  @Patch('contacts/:contactId')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a contact' })
  @ApiErrors(400, 401, 403, 404, 429)
  async update(
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() dto: UpdateContactDto,
  ) {
    return { data: await this.contacts.update(requestPrincipal(), contactId, dto) };
  }

  // --- Contact Identities ------------------------------------------------------

  @Post('workspaces/:workspaceId/contacts/:contactId/identities')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Add an identity to a contact' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async createIdentityByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() dto: CreateContactIdentityDto,
  ) {
    return {
      data: await this.contacts.createIdentity(requestPrincipal(), contactId, dto, workspaceId),
    };
  }

  @Post('contacts/:contactId/identities')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Add an identity to a contact' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async createIdentity(
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() dto: CreateContactIdentityDto,
  ) {
    return {
      data: await this.contacts.createIdentity(requestPrincipal(), contactId, dto),
    };
  }

  @Get('workspaces/:workspaceId/contacts/:contactId/identities')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List identities of a contact' })
  @ApiErrors(400, 401, 403, 404, 429)
  async listIdentitiesByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
  ) {
    return {
      data: await this.contacts.listIdentities(requestPrincipal(), contactId, workspaceId),
    };
  }

  @Get('contacts/:contactId/identities')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List identities of a contact' })
  @ApiErrors(400, 401, 403, 404, 429)
  async listIdentities(@Param('contactId', new ParseUUIDPipe()) contactId: string) {
    return { data: await this.contacts.listIdentities(requestPrincipal(), contactId) };
  }

  @Patch('identities/:identityId')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a contact identity' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async updateIdentity(
    @Param('identityId', new ParseUUIDPipe()) identityId: string,
    @Body() dto: UpdateContactIdentityDto,
  ) {
    return {
      data: await this.contacts.updateIdentity(requestPrincipal(), identityId, dto),
    };
  }

  // --- Consent Events & Effective State ----------------------------------------

  @Post('workspaces/:workspaceId/contacts/:contactId/consent-events')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Record a consent event' })
  @ApiErrors(400, 401, 403, 404, 429)
  async createConsentEventByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() dto: CreateConsentEventDto,
  ) {
    return {
      data: await this.contacts.createConsentEvent(requestPrincipal(), contactId, dto, workspaceId),
    };
  }

  @Post('contacts/:contactId/consent-events')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Record a consent event' })
  @ApiErrors(400, 401, 403, 404, 429)
  async createConsentEvent(
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() dto: CreateConsentEventDto,
  ) {
    return {
      data: await this.contacts.createConsentEvent(requestPrincipal(), contactId, dto),
    };
  }

  @Get('workspaces/:workspaceId/contacts/:contactId/consent-events')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List consent events for a contact' })
  @ApiErrors(400, 401, 403, 404, 429)
  async listConsentEventsByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
  ) {
    return {
      data: await this.contacts.listConsentEvents(requestPrincipal(), contactId, workspaceId),
    };
  }

  @Get('contacts/:contactId/consent-events')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List consent events for a contact' })
  @ApiErrors(400, 401, 403, 404, 429)
  async listConsentEvents(@Param('contactId', new ParseUUIDPipe()) contactId: string) {
    return {
      data: await this.contacts.listConsentEvents(requestPrincipal(), contactId),
    };
  }

  @Get('workspaces/:workspaceId/contacts/:contactId/consent-effective')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get effective consent state for a contact, channel, and consent type' })
  @ApiErrors(400, 401, 403, 404, 429)
  async getEffectiveConsentByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Query() query: GetEffectiveConsentDto,
  ) {
    return {
      data: await this.contacts.getEffectiveConsent(
        requestPrincipal(),
        contactId,
        query,
        workspaceId,
      ),
    };
  }

  @Get('contacts/:contactId/consent-effective')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get effective consent state for a contact, channel, and consent type' })
  @ApiErrors(400, 401, 403, 404, 429)
  async getEffectiveConsent(
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Query() query: GetEffectiveConsentDto,
  ) {
    return {
      data: await this.contacts.getEffectiveConsent(requestPrincipal(), contactId, query),
    };
  }

  // --- Campaign Audience Resolution (Phase 8A-S) --------------------------------

  @Post('workspaces/:workspaceId/contacts/audience/resolve')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Resolve campaign audience in a workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async resolveAudienceByWorkspacePost(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() dto: ResolveAudienceDto,
  ) {
    return this.contacts.resolveAudience(requestPrincipal(), dto, workspaceId);
  }

  @Get('workspaces/:workspaceId/contacts/audience/resolve')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Resolve campaign audience in a workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async resolveAudienceByWorkspaceGet(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query() query: ResolveAudienceDto,
  ) {
    return this.contacts.resolveAudience(requestPrincipal(), query, workspaceId);
  }

  @Post('workspaces/:workspaceId/audience/preview')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Preview campaign audience in a workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async previewAudienceByWorkspace(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() dto: ResolveAudienceDto,
  ) {
    return this.contacts.resolveAudience(requestPrincipal(), dto, workspaceId);
  }

  @Post('contacts/audience/resolve')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Resolve campaign audience across organization or workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async resolveAudiencePost(@Body() dto: ResolveAudienceDto) {
    return this.contacts.resolveAudience(requestPrincipal(), dto);
  }

  @Get('contacts/audience/resolve')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Resolve campaign audience across organization or workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async resolveAudienceGet(@Query() query: ResolveAudienceDto) {
    return this.contacts.resolveAudience(requestPrincipal(), query);
  }
}
