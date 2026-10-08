import { PgDialect } from 'drizzle-orm/pg-core';

import { SESSION_VARS } from './constants';
import { EMPTY_TENANT_SESSION, tenantContextStatements } from './tenant-context';

const dialect = new PgDialect();

describe('tenantContextStatements', () => {
  it('writes every context variable on every transaction', () => {
    // Absent values are written as empty strings rather than skipped, so a
    // pooled connection can never inherit context from the work before it.
    expect(tenantContextStatements({ orgId: 'org-1' })).toHaveLength(7);
    expect(tenantContextStatements(EMPTY_TENANT_SESSION)).toHaveLength(7);
  });

  it('writes the seventh claim, app.current_api_key_id, on every transaction (ADR-015 R-7)', () => {
    const written = (session: Parameters<typeof tenantContextStatements>[0]) =>
      Object.fromEntries(
        tenantContextStatements(session).map((statement) => {
          const { params } = dialect.sqlToQuery(statement);
          return [params[0], params[1]];
        }),
      );
    // Every one of the seven names, each exactly once.
    expect(Object.keys(written({})).sort()).toEqual(Object.values(SESSION_VARS).sort());
    // Absent (a session principal) → the empty string, never skipped …
    expect(written({ userId: 'user-1' })[SESSION_VARS.API_KEY_ID]).toBe('');
    expect(written(EMPTY_TENANT_SESSION)[SESSION_VARS.API_KEY_ID]).toBe('');
    // … present (an API-key principal) → the key id.
    expect(written({ apiKeyId: 'key-1' })[SESSION_VARS.API_KEY_ID]).toBe('key-1');
  });

  it('binds values as parameters rather than inlining them into SQL', () => {
    const hostile = "org'; DROP TABLE users; --";
    const [first] = tenantContextStatements({ orgId: hostile });
    const query = dialect.sqlToQuery(first!);

    expect(query.sql).not.toContain('DROP TABLE');
    expect(query.sql).toContain('$1');
    expect(query.params).toContain(hostile);
  });

  it('marks every setting transaction-local', () => {
    for (const statement of tenantContextStatements(EMPTY_TENANT_SESSION)) {
      const { sql: text } = dialect.sqlToQuery(statement);
      expect(text).toContain('set_config');
      // The literal third argument is what makes this SET LOCAL rather than a
      // connection-level SET (DATABASE.md §14a).
      expect(text).toMatch(/,\s*true\)/);
    }
  });

  it('maps platform-admin and provisioning flags to on/off', () => {
    const enabled = tenantContextStatements({ isPlatformAdmin: true, provisioning: true });
    const disabled = tenantContextStatements({});

    const paramsOf = (statements: typeof enabled): unknown[] =>
      statements.flatMap((statement) => dialect.sqlToQuery(statement).params);

    expect(paramsOf(enabled)).toContain('on');
    expect(paramsOf(disabled)).not.toContain('on');
    expect(paramsOf(disabled)).toContain('off');
  });
});
