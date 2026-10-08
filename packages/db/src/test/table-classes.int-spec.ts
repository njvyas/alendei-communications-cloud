/**
 * Table classes and the tenant-content catalogue rule (ADR-015 R-7, R-10;
 * ADR-014 §17.1; `table-classes.ts`).
 *
 * 1. Completeness: every public table with an `org_id` column is in exactly
 *    one of `TENANCY_RECORD_TABLES`, `CONTENT_TABLES` or `ORG_ID_EXEMPT_TABLES`,
 *    so a new table cannot fall into a class — and so into a predicate — by
 *    default. Proven to bite with a disposable unclassified table.
 * 2. Catalogue: every table in `CONTENT_TABLES` passes `contentTableViolations`.
 *    The registry is empty today (no content table exists before Phase 3.1),
 *    so the same checker is proven against disposable fixtures created and
 *    rolled back inside one owner transaction: the exact §17.1 shape passes,
 *    and every bad variant is rejected.
 */
import type { PoolClient } from 'pg';

import { CONTENT_TABLES, ORG_ID_EXEMPT_TABLES, TENANCY_RECORD_TABLES } from '../table-classes';
import { contentFixtureDdl, contentTableViolations, CONTENT_PREDICATE } from './content-tables';
import { connect, loadTestEnv, type Principals } from './harness';

/** The classification problems of the current catalogue; all empty when complete. */
async function classification(client: PoolClient): Promise<{
  unclassified: string[];
  multiplyClassified: string[];
  unknown: string[];
}> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'
     ORDER BY 1`,
  );
  const { rows: all } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const existing = new Set(all.map((r) => r.tablename));
  const lists: readonly (readonly string[])[] = [
    TENANCY_RECORD_TABLES,
    CONTENT_TABLES,
    ORG_ID_EXEMPT_TABLES,
  ];
  const count = (t: string) => lists.filter((l) => l.includes(t)).length;
  const listed = [...new Set(lists.flat())];
  return {
    unclassified: rows.map((r) => r.table_name).filter((t) => count(t) === 0),
    multiplyClassified: listed.filter((t) => count(t) > 1).sort(),
    unknown: listed.filter((t) => !existing.has(t)).sort(),
  };
}

describe('table classes — tenancy records, tenant content, exemptions', () => {
  let db: Principals;

  beforeAll(() => {
    loadTestEnv();
    db = connect();
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs `work` in an owner transaction that is always rolled back. */
  async function rolledBack<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.adminPool.connect();
    try {
      await client.query('BEGIN');
      return await work(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  async function create(client: PoolClient, statements: readonly string[]): Promise<void> {
    for (const statement of statements) await client.query(statement);
  }

  describe('completeness', () => {
    it('every public table with an org_id column is in exactly one class, and every listed table exists', async () => {
      const result = await rolledBack(classification);
      expect(result).toEqual({ unclassified: [], multiplyClassified: [], unknown: [] });
    });

    it('CONTENT_TABLES is empty before Phase 3.1, and no exemption is granted', () => {
      expect(CONTENT_TABLES).toEqual([]);
      expect(ORG_ID_EXEMPT_TABLES).toEqual([]);
    });

    it('a new table with an org_id column is reported unclassified — it cannot default silently', async () => {
      const result = await rolledBack(async (c) => {
        await c.query(`CREATE TABLE s4_unclassified (id uuid PRIMARY KEY, org_id uuid NOT NULL)`);
        return classification(c);
      });
      expect(result.unclassified).toEqual(['s4_unclassified']);
    });
  });

  describe('catalogue rule', () => {
    it('every registered content table conforms (none registered yet)', async () => {
      const violations = await rolledBack(async (c) => {
        const out: string[] = [];
        for (const table of CONTENT_TABLES) out.push(...(await contentTableViolations(c, table)));
        return out;
      });
      expect(violations).toEqual([]);
    });

    it('the exact §17.1 shape passes, and PostgreSQL renders P as the checker expects', async () => {
      const result = await rolledBack(async (c) => {
        await create(c, contentFixtureDdl('s4_good'));
        const { rows } = await c.query<{
          policyname: string;
          qual: string | null;
          wc: string | null;
        }>(
          `SELECT policyname, qual, with_check AS wc FROM pg_policies
           WHERE tablename = 's4_good' ORDER BY policyname`,
        );
        return { violations: await contentTableViolations(c, 's4_good'), rows };
      });
      expect(result.violations).toEqual([]);
      expect(result.rows).toEqual([
        { policyname: 's4_good_insert', qual: null, wc: CONTENT_PREDICATE },
        { policyname: 's4_good_select', qual: CONTENT_PREDICATE, wc: null },
        { policyname: 's4_good_update', qual: CONTENT_PREDICATE, wc: CONTENT_PREDICATE },
      ]);
    });

    /** Each bad variant: the good fixture plus one defect, and the violation it must raise. */
    const BAD: readonly { name: string; defect: string[]; expect: RegExp }[] = [
      {
        name: 'tenancy predicate (app_org_in_scope)',
        defect: [
          `DROP POLICY s4_bad_select ON s4_bad`,
          `CREATE POLICY s4_bad_select ON s4_bad FOR SELECT TO acc_app
             USING (app_org_in_scope(org_id) AND (SELECT app_content_context_valid()))`,
        ],
        expect: /s4_bad_select: references a reseller\/platform helper/,
      },
      {
        name: 'platform arm',
        defect: [
          `CREATE POLICY s4_bad_platform ON s4_bad FOR SELECT TO acc_app USING (app_is_platform_admin())`,
        ],
        expect: /s4_bad_platform: references a reseller\/platform helper/,
      },
      {
        name: 'reseller arm',
        defect: [
          `CREATE POLICY s4_bad_reseller ON s4_bad FOR SELECT TO acc_app
             USING (app_org_reseller(org_id) = app_current_reseller_id())`,
        ],
        expect: /s4_bad_reseller: references a reseller\/platform helper/,
      },
      {
        name: 'platform-scope helper',
        defect: [
          `CREATE POLICY s4_bad_scope ON s4_bad FOR SELECT TO acc_app USING (app_has_platform_scope())`,
        ],
        expect: /s4_bad_scope: references a reseller\/platform helper/,
      },
      {
        name: 'OR instead of AND',
        defect: [
          `DROP POLICY s4_bad_select ON s4_bad`,
          `CREATE POLICY s4_bad_select ON s4_bad FOR SELECT TO acc_app
             USING (org_id = app_current_org_id() OR (SELECT app_content_context_valid()))`,
        ],
        expect: /s4_bad_select: permissive acc_app expression is not exactly P/,
      },
      {
        name: 'org term only (Model A)',
        defect: [
          `DROP POLICY s4_bad_select ON s4_bad`,
          `CREATE POLICY s4_bad_select ON s4_bad FOR SELECT TO acc_app USING (org_id = app_current_org_id())`,
        ],
        expect: /s4_bad_select: permissive acc_app expression is not exactly P/,
      },
      {
        name: 'a true policy',
        defect: [`CREATE POLICY s4_bad_true ON s4_bad FOR SELECT TO acc_app USING (true)`],
        expect: /s4_bad_true: has a true expression/,
      },
      {
        name: 'an acc_auth policy',
        defect: [
          `CREATE POLICY s4_bad_auth ON s4_bad FOR SELECT TO acc_auth
             USING (org_id = app_current_org_id())`,
        ],
        expect: /s4_bad_auth: targets acc_auth/,
      },
      {
        name: 'an acc_relay policy',
        defect: [
          `CREATE POLICY s4_bad_relay ON s4_bad FOR SELECT TO acc_relay
             USING (org_id = app_current_org_id())`,
        ],
        expect: /s4_bad_relay: targets acc_relay/,
      },
      {
        name: 'a PUBLIC policy',
        defect: [
          `CREATE POLICY s4_bad_public ON s4_bad FOR SELECT
             USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))`,
        ],
        expect: /s4_bad_public: targets public/,
      },
      {
        name: 'a DELETE grant',
        defect: [`GRANT DELETE ON s4_bad TO acc_app`],
        expect: /s4_bad: DELETE granted to acc_app/,
      },
      {
        name: 'an acc_auth table grant',
        defect: [`GRANT SELECT ON s4_bad TO acc_auth`],
        expect: /s4_bad: SELECT granted to acc_auth/,
      },
      {
        name: 'an acc_relay column grant',
        defect: [`GRANT SELECT (id) ON s4_bad TO acc_relay`],
        expect: /s4_bad: SELECT granted to acc_relay/,
      },
      {
        name: 'RLS disabled',
        defect: [`ALTER TABLE s4_bad DISABLE ROW LEVEL SECURITY`],
        expect: /s4_bad: row-level security is not enabled/,
      },
    ];

    it.each(BAD)('rejects a content table with $name', async ({ defect, expect: pattern }) => {
      const violations = await rolledBack(async (c) => {
        await create(c, contentFixtureDdl('s4_bad'));
        expect(await contentTableViolations(c, 's4_bad')).toEqual([]);
        await create(c, defect);
        return contentTableViolations(c, 's4_bad');
      });
      expect(violations.some((v) => pattern.test(v))).toBe(true);
    });
  });
});
