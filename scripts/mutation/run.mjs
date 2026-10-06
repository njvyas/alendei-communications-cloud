#!/usr/bin/env node
/**
 * Mutation runner (TESTING.md §6q): proves each intended defect is caught.
 *
 *   node scripts/mutation/run.mjs scripts/mutation/catalogue/<step>.json \
 *     [--only M1,M2] [--out <dir>] [--skip-baseline]
 *
 * A catalogue names test commands and mutants. Each mutant is one or more exact
 * edits — file, search string (which must occur exactly once), replacement —
 * and the commands expected to FAIL with it applied. For every mutant the
 * runner
 *   1. adds a detached git worktree of HEAD under <out>/worktrees, so the main
 *      working tree is never touched (removed again on exit or interrupt),
 *   2. links the main tree's node_modules into it,
 *   3. applies the edits and runs each command there — a command marked `db`
 *      through scripts/with-db-clone.mjs, so it runs on a disposable clone of
 *      the database the caller's DATABASE_* variables name,
 *   4. records "caught" when at least one command fails, with the failing test
 *      names and the first assertion lines, and "survived" otherwise,
 *   5. removes the worktree.
 * The unmutated baseline is run first, the same way, and every command must
 * pass on it. The run exits non-zero if the baseline fails, a mutant is
 * malformed, or any mutant survives. DB commands run one at a time: a clone is
 * created from the template database, which must have no other connections.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE_MODULES = ['node_modules', 'apps/api/node_modules', 'apps/web/node_modules'];
const DB_VARIABLES = [
  'DATABASE_URL',
  'DATABASE_AUTH_URL',
  'DATABASE_ADMIN_URL',
  'DATABASE_RELAY_URL',
];

function fail(message) {
  console.error(`mutation: ${message}`);
  process.exit(2);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const cataloguePath = process.argv[2];
if (!cataloguePath || cataloguePath.startsWith('--')) {
  fail('usage: node scripts/mutation/run.mjs <catalogue.json> [--only M1,M2] [--out dir]');
}
const catalogue = JSON.parse(readFileSync(resolve(cataloguePath), 'utf8'));
const only = argument('--only')
  ?.split(',')
  .map((id) => id.trim());
const outDir = resolve(argument('--out') ?? mkdtempSync(join(tmpdir(), 'acc-mutation-')));
const skipBaseline = process.argv.includes('--skip-baseline');
mkdirSync(outDir, { recursive: true });

const git = (args, cwd = ROOT) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
};

const mainStatusBefore = git(['status', '--porcelain']);
const head = git(['rev-parse', 'HEAD']).trim();

const commands = catalogue.commands ?? {};
const mutants = (catalogue.mutants ?? []).filter((m) => !only || only.includes(m.id));
if (mutants.length === 0) fail('no mutants selected');
for (const m of mutants) {
  for (const key of m.commands ?? []) if (!commands[key]) fail(`${m.id}: unknown command ${key}`);
  if (!m.commands?.length) fail(`${m.id}: no command expected to fail`);
  if (!m.edits?.length) fail(`${m.id}: no edits`);
}
const needsDb = Object.values(commands).some((c) => c.db);
if (needsDb) for (const name of DB_VARIABLES) if (!process.env[name]) fail(`${name} is not set`);

/** A detached worktree of HEAD, with the main tree's dependencies linked in. */
const worktreeRoot = join(outDir, 'worktrees');
mkdirSync(worktreeRoot, { recursive: true });
let activeWorktree = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (activeWorktree) removeWorktree(activeWorktree);
    process.exit(130);
  });
}

function createWorktree(label) {
  const dir = mkdtempSync(join(worktreeRoot, `${label}-`));
  rmSync(dir, { recursive: true, force: true });
  git(['worktree', 'add', '--detach', '--quiet', dir, head]);
  for (const relative of NODE_MODULES) {
    const source = join(ROOT, relative);
    if (existsSync(source) && !existsSync(join(dir, relative)))
      symlinkSync(source, join(dir, relative));
  }
  return dir;
}

function removeWorktree(dir) {
  activeWorktree = null;
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT });
  rmSync(dir, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
}

function applyEdits(dir, mutant) {
  for (const edit of mutant.edits) {
    const path = join(dir, edit.file);
    const text = readFileSync(path, 'utf8');
    const count = text.split(edit.search).length - 1;
    if (count !== 1) {
      throw new Error(`${mutant.id}: search string occurs ${count} times in ${edit.file}`);
    }
    writeFileSync(
      path,
      text.replace(edit.search, () => edit.replace),
    );
  }
}

function runCommand(dir, key) {
  const spec = commands[key];
  const cwd = join(dir, spec.cwd ?? '.');
  const argv = spec.db
    ? ['node', join(dir, 'scripts', 'with-db-clone.mjs'), '--', ...spec.argv]
    : spec.argv;
  const env = { ...process.env };
  delete env.NODE_ENV;
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), (spec.timeoutSeconds ?? 900) * 1000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ key, status: code ?? (signal ? 1 : 0), output });
    });
  });
}

/** The failing test names and the first lines of each failure, from Jest's output. */
function failures(output) {
  const lines = output.split('\n');
  const summary = lines.indexOf('Summary of all failing tests');
  const from = summary === -1 ? 0 : summary;
  const found = [];
  for (let i = from; i < lines.length && found.length < 6; i += 1) {
    if (!/^\s*● /.test(lines[i])) continue;
    const detail = lines
      .slice(i + 1, i + 14)
      .map((line) => line.trim())
      .filter((line) => line && !/^at |^\d+ \||^>? ?\d+ \||^\|/.test(line))
      .slice(0, 4);
    found.push({ test: lines[i].trim().replace(/^● /, ''), detail });
  }
  const totals = lines.filter((line) => /^Tests:|^Test Suites:/.test(line)).map((l) => l.trim());
  return { found, totals };
}

const report = {
  catalogue: cataloguePath,
  head,
  startedAt: new Date().toISOString(),
  baseline: [],
  mutants: [],
};
const log = (line) => {
  console.log(line);
  writeFileSync(join(outDir, 'progress.log'), `${line}\n`, { flag: 'a' });
};

let exitStatus = 0;

if (!skipBaseline) {
  const keys = [...new Set(mutants.flatMap((m) => m.commands))];
  const dir = createWorktree('baseline');
  try {
    for (const key of keys) {
      const result = await runCommand(dir, key);
      writeFileSync(join(outDir, `baseline-${key}.log`), result.output);
      const { totals } = failures(result.output);
      report.baseline.push({ command: key, status: result.status, totals });
      log(`baseline ${key}: ${result.status === 0 ? 'PASS' : 'FAIL'} ${totals.join(' | ')}`);
      if (result.status !== 0) exitStatus = 1;
    }
  } finally {
    removeWorktree(dir);
  }
  if (exitStatus !== 0)
    log('baseline failed — mutant results would be meaningless; continuing for the record');
}

for (const mutant of mutants) {
  const dir = createWorktree(mutant.id);
  const entry = { id: mutant.id, title: mutant.title, verdict: 'survived', commands: [] };
  try {
    applyEdits(dir, mutant);
    for (const key of mutant.commands) {
      const result = await runCommand(dir, key);
      writeFileSync(join(outDir, `${mutant.id}-${key}.log`), result.output);
      const { found, totals } = failures(result.output);
      entry.commands.push({ command: key, status: result.status, totals, failures: found });
      if (result.status !== 0) entry.verdict = 'caught';
    }
  } catch (error) {
    entry.verdict = 'invalid';
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    removeWorktree(dir);
  }
  if (entry.verdict !== 'caught') exitStatus = 1;
  report.mutants.push(entry);
  const by = entry.commands
    .filter((c) => c.status !== 0)
    .map(
      (c) =>
        `${c.command}: ${
          c.failures
            .map((f) => f.test)
            .slice(0, 2)
            .join('; ') || c.totals.join(' ')
        }`,
    )
    .join(' || ');
  log(
    `${mutant.id} ${entry.verdict.toUpperCase()} — ${mutant.title}${by ? ` — ${by}` : ''}${entry.error ? ` — ${entry.error}` : ''}`,
  );
}

report.finishedAt = new Date().toISOString();
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

if (git(['status', '--porcelain']) !== mainStatusBefore) {
  log('the main working tree changed during the run');
  exitStatus = 1;
}
const caught = report.mutants.filter((m) => m.verdict === 'caught').length;
log(`${caught}/${report.mutants.length} mutants caught; report: ${join(outDir, 'report.json')}`);
process.exit(exitStatus);
