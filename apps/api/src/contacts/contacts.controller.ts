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
  GetEffectiveConsentDto,
  ListContactsDto,
  UpdateContactDto,
  UpdateContactIdentityDto,
} from './contacts.dto';
import { ContactsService } from './contacts.service';

const AT_WORKSPACE = 'the target is the workspace resolved from path or contact record';

@ApiTags('contacts')
@Controller()
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

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
      data: await this.contacts.createIdentity(
        requestPrincipal(),
        contactId,
        dto,
        workspaceId,
      ),
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
      data: await this.contacts.listIdentities(
        requestPrincipal(),
        contactId,
        workspaceId,
      ),
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
      data: await this.contacts.createConsentEvent(
        requestPrincipal(),
        contactId,
        dto,
        workspaceId,
      ),
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
      data: await this.contacts.listConsentEvents(
        requestPrincipal(),
        contactId,
        workspaceId,
      ),
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
}
