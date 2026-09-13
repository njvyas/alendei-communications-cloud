/**
 * Unit tests for what `AuditWriter` puts on the wire.
 *
 * The integration suite proves the end-to-end invariant — smuggled tenancy is
 * ignored — but it proves it via `fn_validate_audit_scope`, which overwrites the
 * columns regardless of what was sent. That is the defence-in-depth working, and
 * it means an integration test alone cannot tell whether the *writer* is also
 * behaving. These tests pin the writer's own output, so a change that started
 * forwarding caller tenancy fails here even though the database would still have
 * saved it.
 */
import {
  AUDIT_ACTIONS,
  ANONYMOUS_LOGIN_ACTOR_LABEL,
  AUTH_ROLE_AUDIT_ACTIONS,
  SECURITY_SENSITIVE_AUDIT_ACTIONS,
  isAuthRoleAuditAction,
} from '@acc/contracts';

import { RequestContext } from '../common/context/request-context';
import { AuditWriter, type AuditWriteInput } from './audit-writer.service';

/** Captures the row handed to drizzle without touching a database. */
function captor() {
  const captured: Record<string, unknown>[] = [];
  const target = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        captured.push(row);
        return Promise.resolve();
      },
    }),
  };
  return { captured, target };
}

function writerWith(target: unknown) {
  const db = {
    auth: target,
    withRequestTenant: (work: (tx: unknown) => Promise<void>) => work(target),
  };
  return new AuditWriter(db as never);
}

const base: AuditWriteInput = {
  scopeType: 'organization',
  scopeId: 'org-1',
  actorType: 'system',
  actorUserId: null,
  actorApiKeyId: null,
  actorLabel: 'unit',
  action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
  resourceType: 'organization',
  resourceId: null,
  outcome: 'success',
  before: null,
  after: null,
  metadata: {},
  correlationId: '00000000-0000-7000-8000-000000000001',
  causationId: null,
  ip: null,
  userAgent: null,
};

describe('AuditWriter row construction', () => {
  it('never puts a tenancy column on the wire', async () => {
    const { captured, target } = captor();
    await writerWith(target).record(base, target as never);

    const row = captured[0]!;
    for (const forbidden of ['orgId', 'workspaceId', 'teamId', 'resellerId']) {
      expect(Object.keys(row)).not.toContain(forbidden);
    }
    expect(row.scopeType).toBe('organization');
    expect(row.scopeId).toBe('org-1');
  });

  it('drops tenancy smuggled past the type system rather than forwarding it', async () => {
    const { captured, target } = captor();
    const smuggled = {
      ...base,
      orgId: 'other-org',
      workspaceId: 'other-ws',
      teamId: 'other-team',
      resellerId: 'other-reseller',
    } as AuditWriteInput;

    await writerWith(target).record(smuggled, target as never);

    const row = captured[0]!;
    expect(Object.keys(row)).not.toContain('orgId');
    expect(Object.values(row)).not.toContain('other-org');
    expect(Object.values(row)).not.toContain('other-reseller');
  });

  it('redacts before, after and metadata on the way out', async () => {
    const { captured, target } = captor();
    await writerWith(target).record(
      {
        ...base,
        before: { password_hash: 'secret-before', email: 'a@b.test' },
        after: { nested: { refreshToken: 'secret-after' } },
        metadata: { keys: [{ key_hash: 'secret-meta' }] },
      },
      target as never,
    );

    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain('secret-before');
    expect(serialized).not.toContain('secret-after');
    expect(serialized).not.toContain('secret-meta');
    expect(serialized).toContain('a@b.test');
  });

  it('preserves an explicit null before/after rather than redacting it into an object', async () => {
    const { captured, target } = captor();
    await writerWith(target).record(base, target as never);
    expect(captured[0]!.before).toBeNull();
    expect(captured[0]!.after).toBeNull();
  });

  it('fills correlation, causation, ip and user-agent from the ambient request', async () => {
    const { captured, target } = captor();
    const writer = writerWith(target);

    await RequestContext.run(
      {
        correlationId: '00000000-0000-7000-8000-0000000000aa',
        requestId: 'r1',
        causationId: '00000000-0000-7000-8000-0000000000bb',
        traceId: null,
        principal: null,
        ip: '203.0.113.9',
        userAgent: 'unit/1.0',
      },
      async () => {
        const { correlationId, causationId, ip, userAgent, ...withoutContext } = base;
        void correlationId;
        void causationId;
        void ip;
        void userAgent;
        await writer.record(withoutContext as AuditWriteInput, target as never);
      },
    );

    const row = captured[0]!;
    expect(row.correlationId).toBe('00000000-0000-7000-8000-0000000000aa');
    expect(row.causationId).toBe('00000000-0000-7000-8000-0000000000bb');
    expect(row.ip).toBe('203.0.113.9');
    expect(row.userAgent).toBe('unit/1.0');
  });

  it('prefers an explicit correlation id over the ambient one', async () => {
    const { captured, target } = captor();
    const writer = writerWith(target);
    await RequestContext.run(
      {
        correlationId: 'ambient',
        requestId: 'r1',
        causationId: null,
        traceId: null,
        principal: null,
        ip: null,
        userAgent: null,
      },
      async () => {
        await writer.record(base, target as never);
      },
    );
    expect(captured[0]!.correlationId).toBe(base.correlationId);
  });

  it('throws rather than inventing a correlation id when there is none', async () => {
    const { target } = captor();
    const { correlationId, ...withoutCorrelation } = base;
    void correlationId;

    await expect(
      writerWith(target).record(withoutCorrelation as AuditWriteInput, target as never),
    ).rejects.toThrow(/no correlationId/);
  });

  it('routes an auth action to the acc_auth handle when no transaction is supplied', async () => {
    const authCaptor = captor();
    const writer = writerWith(authCaptor.target);

    await writer.record({
      ...base,
      scopeType: 'platform',
      scopeId: null,
      action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      actorLabel: ANONYMOUS_LOGIN_ACTOR_LABEL,
      resourceType: 'auth',
      outcome: 'failure',
    });

    expect(authCaptor.captured).toHaveLength(1);
    expect(authCaptor.captured[0]!.actorLabel).toBe(ANONYMOUS_LOGIN_ACTOR_LABEL);
  });

  it.each([
    AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
    AUDIT_ACTIONS.AUTH_LOGOUT,
    AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED,
    AUDIT_ACTIONS.API_KEY_AUTHENTICATED,
  ])('joins a supplied transaction for %s rather than writing beside it', async (action) => {
    // Each of these accompanies a business mutation acc_auth performs on
    // `sessions`/`users`/`api_keys`. Writing the audit row on a separate
    // connection would let a rolled-back login leave a record saying it
    // succeeded.
    const authCaptor = captor();
    const txCaptor = captor();
    const writer = writerWith(authCaptor.target);

    await writer.record(
      { ...base, scopeType: 'platform', scopeId: null, action, resourceType: 'auth' },
      txCaptor.target as never,
    );

    expect(txCaptor.captured).toHaveLength(1);
    expect(authCaptor.captured).toHaveLength(0);
  });

  it('refuses a security-sensitive action with no transaction to join', async () => {
    const { target } = captor();
    await expect(
      writerWith(target).record({ ...base, action: AUDIT_ACTIONS.USER_ROLE_GRANTED }),
    ).rejects.toThrow(/security-sensitive/);
  });
});

describe('AuditWriter transaction ownership', () => {
  /**
   * A transaction proxy that records every property touched. Anything beyond
   * `insert` — `transaction`, `commit`, `rollback`, `release`, `end` — would
   * mean the writer is managing a lifecycle it does not own.
   */
  function watchedTx() {
    const touched: string[] = [];
    const rows: Record<string, unknown>[] = [];
    const proxy = new Proxy(
      {},
      {
        get(_target, property: string | symbol) {
          if (typeof property !== 'string') return undefined;
          touched.push(property);
          if (property === 'insert') {
            return () => ({
              values: (row: Record<string, unknown>) => {
                rows.push(row);
                return Promise.resolve();
              },
            });
          }
          // Any other member resolves to a throwing function, so a call the
          // writer should never make fails loudly instead of silently no-oping.
          return () => {
            throw new Error(`AuditWriter must not call tx.${property}()`);
          };
        },
      },
    );
    return { touched, rows, proxy };
  }

  it.each([
    ['tenant action', AUDIT_ACTIONS.ORGANIZATION_UPDATED],
    ['security-sensitive action', AUDIT_ACTIONS.USER_ROLE_GRANTED],
    ['auth action', AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED],
  ])('touches only insert on a supplied transaction for a %s', async (_label, action) => {
    const { touched, rows, proxy } = watchedTx();
    const writer = writerWith(captor().target);

    await writer.record({ ...base, action, resourceType: 'r' }, proxy as never);

    expect(rows).toHaveLength(1);
    const lifecycle = touched.filter((name) =>
      ['transaction', 'begin', 'commit', 'rollback', 'release', 'end', 'destroy'].includes(name),
    );
    expect(lifecycle).toEqual([]);
    expect(new Set(touched)).toEqual(new Set(['insert']));
  });

  it('never opens a transaction of its own when one is supplied', async () => {
    const { proxy } = watchedTx();
    let openedOwn = false;
    const db = {
      auth: {
        transaction: () => {
          openedOwn = true;
          return Promise.resolve();
        },
        insert: () => ({ values: () => Promise.resolve() }),
      },
      withRequestTenant: () => {
        openedOwn = true;
        return Promise.resolve();
      },
    };

    await new AuditWriter(db as never).record(base, proxy as never);
    expect(openedOwn).toBe(false);
  });

  it('owns a transaction itself only when none is supplied', async () => {
    // The sanctioned path: `withRequestTenant`, which establishes tenant context
    // with SET LOCAL and fails closed without a resolved principal.
    let usedSanctionedPath = false;
    const db = {
      auth: { insert: () => ({ values: () => Promise.resolve() }) },
      withRequestTenant: async (work: (tx: unknown) => Promise<void>) => {
        usedSanctionedPath = true;
        await work({ insert: () => ({ values: () => Promise.resolve() }) });
      },
    };

    await new AuditWriter(db as never).record(base);
    expect(usedSanctionedPath).toBe(true);
  });
});

describe('audit action classification', () => {
  it('shares no action between the acc_auth vocabulary and the sensitive set', () => {
    // If a security-sensitive action were ever added to AUTH_ROLE_AUDIT_ACTIONS,
    // it would route through acc_auth, where a caller that passed no transaction
    // would get an independently-committing audit row for a privileged mutation.
    const authRole = new Set<string>(AUTH_ROLE_AUDIT_ACTIONS);
    const overlap = SECURITY_SENSITIVE_AUDIT_ACTIONS.filter((action) => authRole.has(action));
    expect(overlap).toEqual([]);
  });

  it('routes every role and credential mutation through acc_app, not acc_auth', () => {
    for (const action of [
      AUDIT_ACTIONS.ROLE_CREATED,
      AUDIT_ACTIONS.ROLE_UPDATED,
      AUDIT_ACTIONS.ROLE_DELETED,
      AUDIT_ACTIONS.USER_ROLE_GRANTED,
      AUDIT_ACTIONS.USER_ROLE_REVOKED,
      AUDIT_ACTIONS.API_KEY_CREATED,
      AUDIT_ACTIONS.API_KEY_REVOKED,
      AUDIT_ACTIONS.USER_DISABLED,
      AUDIT_ACTIONS.SESSION_REVOKED,
      AUDIT_ACTIONS.SESSION_REVOKED_ALL,
    ]) {
      expect(isAuthRoleAuditAction(action)).toBe(false);
    }
  });
});
