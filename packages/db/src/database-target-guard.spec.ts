import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DATABASE_URL_VARIABLES,
  assertDisposableTestDatabase,
  databaseTargetProblem,
} from './test/database-target-guard';

const url = (user: string, database: string, host = 'localhost') =>
  `postgres://${user}:s3cret-not-printed@${host}:5432/${database}`;

/** The four variables every harness reads, all aimed at one database. */
const env = (database: string, extra: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: url('acc_app', database),
  DATABASE_ADMIN_URL: url('postgres', database),
  DATABASE_AUTH_URL: url('acc_auth', database),
  DATABASE_RELAY_URL: url('acc_relay', database),
  ...extra,
});

const CI = { CI: 'true', GITHUB_ACTIONS: 'true' };
/** What `with-db-clone.mjs` passes to its child: the name of the copy it created. */
const approvedBy = (database: string) => ({ ACC_TEST_CLONE: database });
const EVIDENCE = 'acc_clone_436072f90852';
const problem = (e: Record<string, string | undefined>, envFilePresent = true) =>
  databaseTargetProblem({ env: e, envFilePresent });

describe('database test guard', () => {
  describe('permits', () => {
    it.each(['acc_clone_1a2b3c4d5e6f', 'acc_r015_base_clone_0a42da22bb49'])(
      'the copy the current with-db-clone.mjs run created (%s)',
      (database) => {
        expect(problem(env(database, approvedBy(database)))).toBeNull();
      },
    );

    it('the current run’s copy with the dispatch URL set to the same copy', () => {
      const db = 'acc_clone_1a2b3c4d5e6f';
      expect(
        problem(env(db, { ...approvedBy(db), DATABASE_DISPATCH_URL: url('acc_dispatch', db) })),
      ).toBeNull();
    });

    it('the CI service container: CI and GITHUB_ACTIONS set, loopback host, no .env file', () => {
      expect(problem(env('acc', CI), false)).toBeNull();
    });
  });

  describe('refuses', () => {
    it('a clone-shaped database with no runner approval (ACC_TEST_CLONE unset or empty)', () => {
      const db = 'acc_clone_1a2b3c4d5e6f';
      expect(problem(env(db))).toMatch(/not the copy created by this run.*ACC_TEST_CLONE is unset/);
      expect(problem(env(db, { ACC_TEST_CLONE: '' }))).toMatch(/ACC_TEST_CLONE is unset/);
    });

    it('a clone-shaped database other than the one the current run created', () => {
      expect(problem(env('acc_clone_1a2b3c4d5e6f', approvedBy('acc_clone_aaaaaaaaaaaa')))).toMatch(
        /not the copy created by this run of scripts\/with-db-clone\.mjs/,
      );
    });

    it('the evidence database acc_clone_436072f90852, unapproved or approved for another copy', () => {
      expect(problem(env(EVIDENCE))).toMatch(/refusing database "acc_clone_436072f90852"/);
      expect(problem(env(EVIDENCE, approvedBy('acc_r015_base_clone_0a42da22bb49')))).toMatch(
        /refusing database "acc_clone_436072f90852"/,
      );
      expect(
        problem(env(EVIDENCE, { ...CI, ...approvedBy('acc_clone_aaaaaaaaaaaa') }), false),
      ).toMatch(/refusing database "acc_clone_436072f90852"/);
    });

    it.each([
      ['whitespace', ' acc_clone_1a2b3c4d5e6f '],
      ['not a clone name', 'acc'],
      ['uppercase hex', 'acc_clone_1A2B3C4D5E6F'],
      ['blank', '   '],
    ])('malformed runner approval: %s', (_label, value) => {
      expect(problem(env('acc_clone_1a2b3c4d5e6f', { ACC_TEST_CLONE: value }))).toMatch(
        /ACC_TEST_CLONE is not a with-db-clone\.mjs copy name/,
      );
    });

    it('a non-clone database even when ACC_TEST_CLONE names it', () => {
      expect(problem(env('acc', { ACC_TEST_CLONE: 'acc' }))).toMatch(/refusing database "acc"/);
    });

    it('the shared development database acc', () => {
      expect(problem(env('acc'))).toMatch(/refusing database "acc"/);
    });

    it.each(['acc_r015_base', 'acc_gateb', 'acc_tmp_fresh', 'acc_clone', 'acc_clone_XYZ123456789'])(
      'a persistent or reference database that is not a with-db-clone copy (%s)',
      (database) => {
        expect(problem(env(database))).toMatch(/refusing database/);
      },
    );

    it('acc with CI=true alone', () => {
      expect(problem(env('acc', { CI: 'true' }), false)).toMatch(/refusing database "acc"/);
    });

    it('acc with both CI flags while a .env file exists (a workstation)', () => {
      expect(problem(env('acc', CI), true)).toMatch(/refusing database "acc"/);
    });

    it('acc with both CI flags on a non-loopback host', () => {
      const e = Object.fromEntries(
        Object.entries(env('acc', CI)).map(([k, v]) => [
          k,
          k.startsWith('DATABASE_') ? v!.replace('localhost', 'db.internal') : v,
        ]),
      );
      expect(problem(e, false)).toMatch(/refusing database "acc"/);
    });

    it('a copy for some connections but the shared database for another', () => {
      const db = 'acc_clone_1a2b3c4d5e6f';
      expect(problem(env(db, { DATABASE_DISPATCH_URL: url('acc_dispatch', 'acc') }))).toMatch(
        /name different databases/,
      );
      expect(problem(env(db, { DATABASE_ADMIN_URL: url('postgres', 'acc') }))).toMatch(
        /name different databases/,
      );
    });

    it.each(['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_AUTH_URL'])(
      'missing configuration (%s unset or blank)',
      (name) => {
        expect(problem(env('acc_clone_1a2b3c4d5e6f', { [name]: undefined }))).toMatch(
          /not configured/,
        );
        expect(problem(env('acc_clone_1a2b3c4d5e6f', { [name]: '  ' }))).toMatch(/not configured/);
      },
    );

    it.each([
      ['not a URL', 'not a url', /not a valid connection URL/],
      ['another protocol', 'mysql://u:p@localhost/acc_clone_1a2b3c4d5e6f', /not a postgres/],
      ['no database name', 'postgres://u:p@localhost:5432/', /names no database/],
    ])('malformed configuration: %s', (_label, value, expected) => {
      expect(problem(env('acc_clone_1a2b3c4d5e6f', { DATABASE_ADMIN_URL: value }))).toMatch(
        expected,
      );
    });
  });

  describe('assertDisposableTestDatabase', () => {
    const saved = Object.fromEntries(
      [...DATABASE_URL_VARIABLES, 'CI', 'GITHUB_ACTIONS', 'ACC_TEST_CLONE'].map((k) => [
        k,
        process.env[k],
      ]),
    );
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'acc-guard-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const apply = (e: Record<string, string | undefined>) => {
      for (const k of [...DATABASE_URL_VARIABLES, 'CI', 'GITHUB_ACTIONS', 'ACC_TEST_CLONE'])
        delete process.env[k];
      Object.assign(process.env, e);
    };

    it('throws a message naming with-db-clone.mjs and never the password', () => {
      apply(env('acc'));
      const envFile = join(dir, '.env');
      writeFileSync(envFile, '');
      expect(() => assertDisposableTestDatabase([envFile])).toThrow(
        /^Database test guard: refusing database "acc".*node scripts\/with-db-clone\.mjs -- <command>/,
      );
      try {
        assertDisposableTestDatabase([envFile]);
      } catch (error) {
        expect(String(error)).not.toContain('s3cret-not-printed');
      }
    });

    it('never prints a credential or connection string, for any refusal', () => {
      const db = 'acc_clone_1a2b3c4d5e6f';
      for (const e of [
        env('acc'),
        env(db),
        env(db, approvedBy('acc_clone_aaaaaaaaaaaa')),
        env(EVIDENCE),
      ]) {
        apply(e);
        let message = '';
        try {
          assertDisposableTestDatabase([]);
        } catch (error) {
          message = String(error);
        }
        expect(message).toMatch(/^Error: Database test guard: /);
        expect(message).not.toMatch(/s3cret-not-printed|postgres:\/\/|acc_app|@localhost/);
      }
    });

    it('detects the .env file on disk: CI flags pass only when no listed file exists', () => {
      apply(env('acc', CI));
      expect(() => assertDisposableTestDatabase([join(dir, 'absent.env')])).not.toThrow();
      const envFile = join(dir, '.env');
      writeFileSync(envFile, '');
      expect(() => assertDisposableTestDatabase([envFile])).toThrow(/refusing database "acc"/);
    });
  });
});
