import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { AUDIT_ACTIONS, PERMISSIONS, isSecuritySensitiveAction } from '@acc/contracts';

/**
 * Structural guarantees for user administration (Phase 1B.6.1).
 *
 * These are source-level because the properties are structural: they are about
 * which module may do what, not about any runtime value. Each one is a mistake
 * that would look entirely reasonable in review — writing a `user_roles` row
 * from the user service, adding `status` to the update DTO, selecting the whole
 * `users` row — and that no behavioural test would necessarily catch, because
 * the wrong version would still pass every case that exists today.
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/** A file's code with comments removed — the prose here describes the rules. */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const service = codeOf(join(__dirname, 'user-administration.service.ts'));
const dto = codeOf(join(__dirname, 'user.dto.ts'));
const controller = codeOf(join(__dirname, 'users.controller.ts'));

describe('user administration boundary', () => {
  it('finds the files it is asserting over', () => {
    // Guards the guard: an empty read would make everything below vacuous.
    expect(service.length).toBeGreaterThan(500);
    expect(dto.length).toBeGreaterThan(200);
    expect(controller.length).toBeGreaterThan(200);
  });

  it('never writes a role grant itself', () => {
    // Role assignment is `RoleAssignmentService`'s, guards included. A second
    // writer of `user_roles` would be a second, unguarded way to confer
    // privilege (`RBAC.md` §8b).
    expect(service).not.toMatch(/insert\(\s*schema\.userRoles/);
    expect(service).not.toMatch(/update\(\s*schema\.userRoles/);
    expect(service).not.toMatch(/delete\(\s*schema\.userRoles/);
    expect(service).toMatch(/this\.assignments\.grant\(/);
  });

  it('never deletes a user', () => {
    // `acc_app` has no such grant, but the absence is asserted here too: a
    // `DELETE` written against a table the role cannot delete from would fail at
    // runtime rather than in review, and only for whoever tried it.
    expect(service).not.toMatch(/delete\(\s*schema\.users/);
    expect(controller).not.toMatch(/@Delete/);
  });

  it('never reads the whole users row', () => {
    // `select()` with no projection returns `password_hash` and
    // `mfa_secret_ref`. Every read goes through the one column list.
    expect(service).not.toMatch(/\.select\(\)\s*\n?\s*\.from\(\s*schema\.users/);
    const projection = /private columns\(\) \{([\s\S]*?)\n {2}\}/.exec(service);
    expect(projection).not.toBeNull();
    for (const forbidden of ['passwordHash', 'mfaSecretRef', 'mfaEnabled', 'passwordUpdatedAt']) {
      expect(projection![1]).not.toContain(forbidden);
    }
  });

  it('never returns a credential column from any statement', () => {
    // Including the `returning(...)` clauses, which are a separate projection
    // the column list above does not cover by itself.
    expect(service).not.toMatch(/returning\(\{[^}]*password/i);
    // `mfaSecretRef` appears exactly once, and only inside the existence test
    // reactivation needs — never as a selected value.
    expect(service.match(/mfaSecretRef/g) ?? []).toHaveLength(1);
    expect(service).toMatch(/mfaSecretRef\} IS NOT NULL/);
  });

  it('reads the password digest only to ask whether one exists', () => {
    // The reactivation branch needs to know *whether* a credential survives, and
    // nothing more. It must never select the digest into a value the service
    // could return or log.
    const occurrences = service.match(/passwordHash/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(service).toMatch(/passwordHash\} IS NOT NULL/);
  });

  it('exposes no lifecycle or authorization field on the update DTO', () => {
    const body = /export class UpdateUserDto \{([\s\S]*?)\n\}/.exec(dto);
    expect(body).not.toBeNull();
    for (const forbidden of [
      'status',
      'email',
      'roleId',
      'role',
      'scopeType',
      'scopeId',
      'orgId',
      'password',
      'isPlatformAdmin',
    ]) {
      expect(body![1]).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    // The one field there is.
    expect(body![1]).toMatch(/\bphone\b/);
  });

  it('accepts no credential material on creation', () => {
    const body = /export class CreateUserDto \{([\s\S]*?)\n\}/.exec(dto);
    expect(body).not.toBeNull();
    for (const forbidden of ['password', 'passwordHash', 'status', 'token', 'secret']) {
      expect(body![1]!.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('leaves `platform` unrepresentable as an initial grant scope', () => {
    const grantable = /GRANTABLE_SCOPE_TYPES: readonly ScopeType\[\] = \[([\s\S]*?)\];/.exec(dto);
    expect(grantable).not.toBeNull();
    expect(grantable![1]).not.toMatch(/'platform'/);
  });

  it('authorizes through the boundary and never against a flattened union', () => {
    expect(service).toMatch(/this\.authorization\.assert\(/);
    // The two shapes ADR-005 D-3 removed from the decision path.
    expect(service).not.toMatch(/principal\.permissions/);
    expect(service).not.toMatch(/principal\.roles\b/);
    // And no hand-rolled tenant comparison standing in for a decision.
    expect(service).not.toMatch(/principal\.tenant\.orgId\s*===/);
  });

  it('is the only production caller of the just-created grant relaxation', () => {
    const callers = sourceFiles(SRC)
      .filter((f) => /targetCreatedInThisTransaction/.test(codeOf(f)))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      // The option's own declaration.
      .filter((f) => f !== 'rbac/role-assignment.service.ts');

    expect(callers).toEqual(['users/user-administration.service.ts']);
  });

  it('does not expose the relaxation through any request shape', () => {
    // Only an in-process caller can reach it: no DTO carries the field, so no
    // HTTP request can set it.
    expect(dto).not.toMatch(/targetCreatedInThisTransaction/);
    expect(controller).not.toMatch(/targetCreatedInThisTransaction/);
  });

  it('declares the permissions the catalogue publishes', () => {
    for (const permission of [
      PERMISSIONS.USERS_READ,
      PERMISSIONS.USERS_INVITE,
      PERMISSIONS.USERS_UPDATE,
      PERMISSIONS.USERS_DISABLE,
      PERMISSIONS.USERS_REACTIVATE,
    ]) {
      expect(service).toContain(`'${permission}'`);
    }
  });

  it('classifies the lifecycle actions as security-sensitive', () => {
    // Which is what forces them to be written inside the transaction that
    // performs the mutation — `AuditWriter` throws otherwise.
    expect(isSecuritySensitiveAction(AUDIT_ACTIONS.USER_INVITED)).toBe(true);
    expect(isSecuritySensitiveAction(AUDIT_ACTIONS.USER_DISABLED)).toBe(true);
    expect(isSecuritySensitiveAction(AUDIT_ACTIONS.USER_REACTIVATED)).toBe(true);
  });

  it('records every audit row inside the caller’s transaction', () => {
    // `record(input, tx)`, never `record(input)`. The second form would commit
    // separately and could survive a rolled-back mutation.
    const writes = service.match(/this\.audit\.record\(/g) ?? [];
    // create, update, disable, reactivate.
    expect(writes).toHaveLength(4);
    // Each one closes with the caller's transaction as its second argument.
    const transactional = service.match(/\n {6}tx,\n {4}\);/g) ?? [];
    expect(transactional).toHaveLength(writes.length);
  });
});
