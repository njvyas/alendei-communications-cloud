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
} from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../openapi/openapi-responses';
import { OrganizationProviderAssignmentSchema } from '../openapi/openapi-schemas';
import { PLATFORM_CATALOGUE, requestPrincipal } from './channels.controller';
import {
  CreateOrganizationProviderAssignmentDto,
  ListOrganizationProviderAssignmentsQueryDto,
  UpdateOrganizationProviderAssignmentDto,
} from './organization-provider-assignments.dto';
import { OrganizationProviderAssignmentsService } from './organization-provider-assignments.service';

/**
 * Organization Provider Assignments controller (Phase 3.2, ADR-014 §4, P3-D01–D05).
 *
 * Couples the platform provider catalogue to tenant organizations.
 * Platform administration only: `providers.read` for reads, `providers.manage` for writes.
 * No DELETE route: assignments are disabled, never hard-deleted.
 */
@ApiTags('organization-provider-assignments')
@Controller('organizations/:orgId/provider-assignments')
export class OrganizationProviderAssignmentsController {
  constructor(private readonly service: OrganizationProviderAssignmentsService) {}

  @Get()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_READ, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List provider assignments for an organization' })
  @ApiPaged(OrganizationProviderAssignmentSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async list(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Query() query: ListOrganizationProviderAssignmentsQueryDto,
  ) {
    const { items, page } = await this.service.listAssignments(requestPrincipal(), orgId, query);
    return { data: items, page };
  }

  @Get(':assignmentId')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_READ, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Get a provider assignment by id' })
  @ApiData(OrganizationProviderAssignmentSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ) {
    return { data: await this.service.getAssignment(requestPrincipal(), orgId, assignmentId) };
  }

  @Post()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Assign a provider to an organization',
    description:
      'Creates a new provider assignment with integer priority >= 1. Fails with 409 if provider is already assigned or priority is already used for the channel.',
  })
  @ApiData(OrganizationProviderAssignmentSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async create(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() dto: CreateOrganizationProviderAssignmentDto,
  ) {
    return { data: await this.service.createAssignment(requestPrincipal(), orgId, dto) };
  }

  @Patch(':assignmentId')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Update an assignment (priority and/or status)' })
  @ApiData(OrganizationProviderAssignmentSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async update(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() dto: UpdateOrganizationProviderAssignmentDto,
  ) {
    return {
      data: await this.service.updateAssignment(requestPrincipal(), orgId, assignmentId, dto),
    };
  }

  @Post(':assignmentId/disable')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Disable an assignment (unassign from active candidate set)' })
  @ApiData(OrganizationProviderAssignmentSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async disable(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ) {
    return {
      data: await this.service.transitionAssignment(
        requestPrincipal(),
        orgId,
        assignmentId,
        'disabled',
      ),
    };
  }

  @Post(':assignmentId/enable')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Enable an assignment (reinstate as active candidate)' })
  @ApiData(OrganizationProviderAssignmentSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async enable(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ) {
    return {
      data: await this.service.transitionAssignment(
        requestPrincipal(),
        orgId,
        assignmentId,
        'active',
      ),
    };
  }
}
