import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { AUDIT_ACTIONS, PERMISSIONS, isSecuritySensitiveAction } from '@acc/contracts';

/**
 * Structural guarantees for API-key administration (Phase 1B.6.2, ADR-008).
 *
 * The decisive one is the **secret dataflow**. ADR-008's invariant — that a
 * plaintext API-key secret never reaches the idempotency snapshot, the audit
 * trail, a log or the database — is a property of where one variable is allowed
 * to travel. A behavioural test can show the secret is absent from the places it
 * currently looks; only a static assertion can show there is no *path* by which
 * it could arrive. Both exist, and this is the second.
 *
 * These are mistakes that would read as entirely reasonable in review: adding
 * `key_hash` to a projection, passing the minted secret to the service that
 * writes the audit row, or folding the secret into the object `work()` returns.
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/** A file's code with comments stripped — the prose here describes the rules. */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const service = codeOf(join(__dirname, 'api-key-administration.service.ts'));
const controller = codeOf(join(__dirname, 'api-keys.controller.ts'));
const dto = codeOf(join(__dirname, 'api-key.dto.ts'));
const generator = codeOf(join(__dirname, 'api-key-secret.ts'));

describe('api-key administration boundary', () => {
  it('finds the files it is asserting over', () => {
    for (const source of [service, controller, dto, generator]) {
      expect(source.length).toBeGreaterThan(300);
    }
  });

  // --- ADR-008: the secret dataflow ----------------------------------------

  it('the service hands the secret back and never writes it anywhere', () => {
    // It reaches exactly two places: the Argon2id hash, and the returned object.
    expect(service).toMatch(/this\.credentials\.hash\(minted\.secret\)/);
    expect(service).toMatch(/return \{ view, secret: minted\.secret \}/);

    // And nowhere else. If `minted.secret` ever appears in an insert, an audit
    // payload, a log line or an exception, one of these fails.
    const uses = service.match(/minted\.secret/g) ?? [];
    expect(uses).toHaveLength(2);

    expect(service).not.toMatch(/keyHash: minted\.secret/);
    expect(service).not.toMatch(/logger|console\./);
  });

  it('the audit payload cannot carry the secret or the digest', () => {
    // The whole audit call for creation, checked as a block.
    const block = /action: AUDIT_ACTIONS\.API_KEY_CREATED[\s\S]*?\n {6}tx,/.exec(service);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/secret/);
    expect(block![0]).not.toMatch(/keyHash|key_hash/);
    // What it does carry is public: the prefix.
    expect(block![0]).toMatch(/prefix: view\.prefix/);
  });

  it('the controller keeps the secret out of the idempotency snapshot', () => {
    // `work()` returns the envelope with an explicit null — that object is what
    // `IdempotencyService.finalize` persists.
    expect(controller).toMatch(/return \{ data: \{ \.\.\.view, secret: null \} \};/);
    // The real secret is merged in only after `execute` returns, and only when
    // the execution was fresh.
    expect(controller).toMatch(/outcome\.replayed \|\| minted === null/);
    expect(controller).toMatch(/secret: minted/);

    // The plaintext must not be reachable from inside the idempotency call: the
    // only assignment to `minted` is the capture, and it is never referenced in
    // the `request`/`authorize` inputs the service receives.
    const executeCall = /this\.idempotency\.execute<CreatedApiKeyBody>\(\{[\s\S]*?\n {4}\}\);/.exec(
      controller,
    );
    expect(executeCall).not.toBeNull();
    expect(executeCall![0]).not.toMatch(/secret: minted/);
    expect(executeCall![0]).toMatch(/minted = secret;/);
  });

  it('IdempotencyService itself is not taught about secrets', () => {
    // ADR-008 is implemented at the call site. A redaction hook inside the
    // generic mechanism would apply to every endpoint and would be a change to
    // 1B.5.9 semantics for role and role-assignment creation too.
    const idempotency = codeOf(join(SRC, 'idempotency/idempotency.service.ts'));
    // Word-bounded: `storedActorUserId` contains the letters of "redact".
    expect(idempotency).not.toMatch(/\bsecret\b|\bredact\w*\b|nonPersistable/i);
    const fingerprint = codeOf(join(SRC, 'idempotency/request-fingerprint.ts'));
    expect(fingerprint).not.toMatch(/\bsecret\b/i);
  });

  it('no other module reads the minted secret', () => {
    const importers = sourceFiles(SRC)
      .filter((f) => /mintApiKey/.test(codeOf(f)))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .filter((f) => f !== 'api-keys/api-key-secret.ts' && f !== 'api-keys/index.ts');
    expect(importers).toEqual(['api-keys/api-key-administration.service.ts']);
  });

  // --- the read model -------------------------------------------------------

  it('never selects the key hash', () => {
    // A bare `select()` on `api_keys` returns `key_hash`. Every read goes
    // through the one projection, and that projection does not contain it.
    expect(service).not.toMatch(/\.select\(\)\s*\n?\s*\.from\(\s*schema\.apiKeys/);
    const projection = /private columns\(\) \{([\s\S]*?)\n {2}\}/.exec(service);
    expect(projection).not.toBeNull();
    expect(projection![1]).not.toMatch(/keyHash/);
    expect(service).not.toMatch(/keyHash: schema\.apiKeys\.keyHash/);
  });

  it('exposes no secret field on the read model', () => {
    const view = /export interface ApiKeyView \{([\s\S]*?)\n\}/.exec(service);
    expect(view).not.toBeNull();
    expect(view![1]).not.toMatch(/\bsecret\b/);
    expect(view![1]).not.toMatch(/keyHash/);
  });

  // --- authorization --------------------------------------------------------

  it('authorizes through the boundary, never against a flattened union', () => {
    expect(service).toMatch(/this\.authorization\.assert\(/);
    expect(service).toMatch(/this\.authorization\.unheldPermissions\(/);
    expect(service).not.toMatch(/principal\.permissions/);
    expect(service).not.toMatch(/principal\.roles\b/);
    expect(service).not.toMatch(/principal\.tenant\.orgId\s*===/);
  });

  it('authorizes detail and revoke against the stored binding scope', () => {
    // `bindingScopeOf(row)` derives the target from the loaded row. If either
    // call site ever passed a caller-supplied scope instead, these fail.
    const targets = service.match(/target: this\.bindingScopeOf\(/g) ?? [];
    expect(targets).toHaveLength(2);
    const binding = /private bindingScopeOf\(row: ApiKeyRow\): ScopeRef \{([\s\S]*?)\n {2}\}/.exec(
      service,
    );
    expect(binding).not.toBeNull();
    // Reads the row, and only the row.
    expect(binding![1]).toMatch(/row\.workspaceId/);
    expect(binding![1]).toMatch(/row\.orgId/);
    expect(binding![1]).not.toMatch(/principal|input|dto/);
  });

  it('leaves platform, reseller and team bindings unrepresentable', () => {
    const scopes = /API_KEY_SCOPE_TYPES = \[([\s\S]*?)\] as const;/.exec(dto);
    expect(scopes).not.toBeNull();
    expect(scopes![1]).toMatch(/'organization'/);
    expect(scopes![1]).toMatch(/'workspace'/);
    for (const forbidden of ['platform', 'reseller', 'team']) {
      expect(scopes![1]).not.toContain(`'${forbidden}'`);
    }
  });

  it('never writes user_roles — API keys are not role grants', () => {
    expect(service).not.toMatch(/schema\.userRoles/);
    expect(service).not.toMatch(/PLATFORM_ADMIN_LOCK_KEY/);
  });

  it('declares the permissions the catalogue publishes', () => {
    for (const permission of [
      PERMISSIONS.API_KEYS_READ,
      PERMISSIONS.API_KEYS_CREATE,
      PERMISSIONS.API_KEYS_REVOKE,
    ]) {
      expect(service).toContain(`'${permission}'`);
    }
    // And no permission was invented for this phase.
    expect(service).not.toMatch(/api_keys\.(update|rotate|delete)/);
  });

  // --- lifecycle ------------------------------------------------------------

  it('offers no delete and no un-revoke route', () => {
    expect(controller).not.toMatch(/@Delete/);
    expect(controller).not.toMatch(/reactivate|unrevoke|rotate/i);
    expect(service).not.toMatch(/delete\(\s*schema\.apiKeys/);
  });

  it('revokes conditionally, so concurrent callers cannot both win', () => {
    expect(service).toMatch(/isNull\(schema\.apiKeys\.revokedAt\)/);
    expect(service).toMatch(/eq\(schema\.apiKeys\.id, id\), isNull\(schema\.apiKeys\.revokedAt\)/);
  });

  it('derives status rather than persisting it', () => {
    // No status column is written anywhere, and the derivation reads the two
    // timestamps the authentication path independently checks.
    expect(service).not.toMatch(/set\(\{[^}]*status:/);
    const derive = /private statusOf\([\s\S]*?\n {2}\}/.exec(service);
    expect(derive).not.toBeNull();
    expect(derive![0]).toMatch(/row\.revokedAt/);
    expect(derive![0]).toMatch(/row\.expiresAt/);
  });

  it('records both audit rows inside the caller’s transaction', () => {
    const writes = service.match(/this\.audit\.record\(/g) ?? [];
    expect(writes).toHaveLength(2);
    const transactional = service.match(/\n {6}tx,\n {4}\);/g) ?? [];
    expect(transactional).toHaveLength(writes.length);
  });

  it('classifies both actions as security-sensitive', () => {
    // Which is what forces them to be written inside the mutation's transaction
    // — `AuditWriter` throws otherwise.
    expect(isSecuritySensitiveAction(AUDIT_ACTIONS.API_KEY_CREATED)).toBe(true);
    expect(isSecuritySensitiveAction(AUDIT_ACTIONS.API_KEY_REVOKED)).toBe(true);
  });

  it('does not re-implement API-key authentication', () => {
    // Authentication stays in `AuthGuard` (Phase 1B.3), including the creator
    // intersection and the creator-status check added in 1B.6.1.
    expect(service).not.toMatch(/verify\(|verifyDummy|findApiKeyByPrefix/);
    expect(service).not.toMatch(/creatorAuthority/);
  });
});
