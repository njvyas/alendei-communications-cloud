import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUDIT_ACTIONS, isSecuritySensitiveAction } from '@acc/contracts';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CreateTeamDto,
  CreateWorkspaceDto,
  ListTeamsDto,
  UpdateTeamDto,
  UpdateWorkspaceDto,
} from './workspace.dto';

/**
 * Structural guarantees for workspace and team administration (Phase 1C.1b).
 *
 * Source-level where the property is about which code may do what — a
 * deletion, an organization taken from the request, a mutation that skips the
 * in-transaction status check — each of which would look reasonable in review
 * and pass every behavioural case that exists today.
 */

const codeOf = (file: string): string =>
  readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const workspaces = codeOf('workspace-administration.service.ts');
const teams = codeOf('team-administration.service.ts');
const controllers = codeOf('workspaces.controller.ts') + codeOf('teams.controller.ts');

/** The same whitelist options as the global pipe (`common/http/validation.pipe.ts`). */
const errorsFor = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
    (e) => e.property,
  );

describe('workspace and team administration boundary', () => {
  it('finds the files it is asserting over', () => {
    expect(workspaces.length).toBeGreaterThan(1000);
    expect(teams.length).toBeGreaterThan(1000);
    expect(controllers.length).toBeGreaterThan(500);
  });

  it('never deletes a workspace or a team (ADR-012 OD-5)', () => {
    for (const code of [workspaces, teams]) {
      expect(code).not.toMatch(/\.delete\(\s*schema\.(workspaces|teams)/);
    }
    expect(controllers).not.toMatch(/@Delete/);
  });

  it('never takes an organization from the request', () => {
    // The organization is the resolved context's (`requireOrganization`) or a
    // parent row's — never a field of the input.
    for (const code of [workspaces, teams]) {
      expect(code).not.toMatch(/input\.orgId/);
      expect(code).not.toMatch(/filter\.orgId/);
    }
    // A team's organization is its workspace's, read from the workspace's row.
    expect(teams).toMatch(/this\.insert\(tx, workspace\.orgId, workspace\.id,/);
  });

  it('checks the organization is active inside every mutation’s transaction (F-5)', () => {
    // create, update and the lifecycle transition in each service.
    expect(workspaces.match(/assertOrganizationActive\(tx,/g)).toHaveLength(3);
    expect(teams.match(/assertOrganizationActive\(tx,/g)).toHaveLength(3);
  });

  it('reads every addressed workspace and team pinned to the selected organization', () => {
    expect(workspaces).toMatch(
      /and\(eq\(schema\.workspaces\.id, id\), eq\(schema\.workspaces\.orgId, orgId\)\)/,
    );
    expect(teams).toMatch(/and\(eq\(schema\.teams\.id, id\), eq\(schema\.teams\.orgId, orgId\)\)/);
  });

  it('refuses immutable and unknown fields on PATCH, and accepts only an advisory orgId on create', async () => {
    for (const field of ['slug', 'orgId', 'isDefault', 'status', 'id']) {
      expect(await errorsFor(UpdateWorkspaceDto, { [field]: 'x' })).toContain(field);
    }
    for (const field of ['workspaceId', 'orgId', 'status', 'id']) {
      expect(await errorsFor(UpdateTeamDto, { [field]: 'x' })).toContain(field);
    }
    expect(await errorsFor(CreateWorkspaceDto, { name: 'n', slug: 'ok', orgId: 'x' })).toEqual([]);
    expect(await errorsFor(CreateWorkspaceDto, { name: 'n', slug: 'Bad Slug' })).toContain('slug');
    expect(
      await errorsFor(CreateWorkspaceDto, { name: 'n', slug: 'ok', isDefault: true }),
    ).toContain('isDefault');
    expect(await errorsFor(CreateTeamDto, { name: 'n', workspaceId: 'not-a-uuid' })).toContain(
      'workspaceId',
    );
    expect(await errorsFor(ListTeamsDto, { teamId: 'x' })).toContain('teamId');
    expect(await errorsFor(ListTeamsDto, { status: 'deleted' })).toContain('status');
  });

  it('classifies workspace and team lifecycle as security-sensitive audit actions', () => {
    for (const action of [
      AUDIT_ACTIONS.WORKSPACE_ARCHIVED,
      AUDIT_ACTIONS.WORKSPACE_RESTORED,
      AUDIT_ACTIONS.TEAM_ARCHIVED,
      AUDIT_ACTIONS.TEAM_RESTORED,
    ]) {
      expect(isSecuritySensitiveAction(action)).toBe(true);
    }
  });
});
