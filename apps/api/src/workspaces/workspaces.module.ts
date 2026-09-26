import { Module } from '@nestjs/common';

import { TeamAdministrationService } from './team-administration.service';
import { TeamsController } from './teams.controller';
import { WorkspaceAdministrationService } from './workspace-administration.service';
import { WorkspacesController } from './workspaces.controller';

/** Workspace and team administration and lifecycle (Phase 1C.1b, ADR-012 F-6). */
@Module({
  controllers: [WorkspacesController, TeamsController],
  providers: [WorkspaceAdministrationService, TeamAdministrationService],
})
export class WorkspacesModule {}
