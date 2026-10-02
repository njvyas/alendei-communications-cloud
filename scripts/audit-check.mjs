#!/usr/bin/env node
/**
 * Blocking dependency-vulnerability gate (DEPLOYMENT.md §4, SECURITY.md §6).
 *
 * Fails the build when a high/critical advisory is present and not explicitly
 * accepted in `security/audit-exceptions.json`, and also when an accepted
 * exception has expired — so an accepted risk is always re-reviewed on a date.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKING = new Set(['high', 'critical']);

function runAudit() {
  try {
    // `npm audit` exits non-zero when findings exist; the JSON is still on stdout.
    return execFileSync('npm', ['audit', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout;
    throw error;
  }
}

const report = JSON.parse(runAudit());
const { exceptions } = JSON.parse(
  readFileSync(join(repoRoot, 'security', 'audit-exceptions.json'), 'utf8'),
);

const today = new Date().toISOString().slice(0, 10);
const expired = exceptions.filter((entry) => entry.expires < today);
const exceptionFor = new Map(exceptions.map((entry) => [entry.package, entry]));

/** The GitHub advisory id of an `npm audit` advisory object (`…/advisories/GHSA-…`). */
const advisoryId = (advisory) =>
  /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.exec(advisory.url ?? '')?.[0];

/**
 * `npm audit` records a vulnerability for every package on the path to a root
 * cause, and those records form cycles (`@nestjs/core` <-> `@nestjs/platform-express`),
 * so "accepted if every `via` is accepted" cannot be evaluated directly.
 *
 * Instead: a package is a ROOT CAUSE when it carries an advisory object of its
 * own. Everything else is flagged purely by propagation. So take the root causes
 * that are NOT accepted and walk `effects` forward — whatever that reaches is
 * genuinely unaccepted; everything else is downstream of an accepted risk only.
 */
const vulnerabilities = report.vulnerabilities ?? {};

/**
 * An exception accepts advisories, not packages: a root cause is accepted only
 * when EVERY advisory npm reports against it is listed, by id, in its
 * exception. A new advisory on an excepted package is therefore unaccepted until
 * someone reviews it and adds its id — the package name alone never covers it.
 */
const unreviewed = new Map();
const unacceptedRoots = Object.entries(vulnerabilities)
  .filter(([name, vulnerability]) => {
    const advisories = (vulnerability.via ?? []).filter((entry) => typeof entry === 'object');
    if (advisories.length === 0) return false;
    const exception = exceptionFor.get(name);
    if (!exception) return true;
    const listed = new Set(exception.advisories ?? []);
    const missing = advisories
      .map((a) => advisoryId(a) ?? a.url ?? a.title)
      .filter((id) => !listed.has(id));
    if (missing.length > 0) unreviewed.set(name, [...new Set(missing)]);
    return missing.length > 0;
  })
  .map(([name]) => name);

const tainted = new Set(unacceptedRoots);
const queue = [...unacceptedRoots];
while (queue.length > 0) {
  const current = queue.shift();
  for (const effect of vulnerabilities[current]?.effects ?? []) {
    if (tainted.has(effect)) continue;
    tainted.add(effect);
    queue.push(effect);
  }
}

const unaccepted = [];
for (const name of tainted) {
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !BLOCKING.has(vulnerability.severity)) continue;
  const causes = (vulnerability.via ?? []).filter((entry) => typeof entry === 'object');
  unaccepted.push({ name, severity: vulnerability.severity, causes });
}
unaccepted.sort((a, b) => a.name.localeCompare(b.name));

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `npm audit: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
    `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`,
);
console.log(
  `accepted exceptions: ${
    exceptions.map((e) => `${e.package} [${(e.advisories ?? []).join(', ')}]`).join('; ') || 'none'
  }`,
);

let failed = false;

for (const entry of expired) {
  console.error(`EXPIRED EXCEPTION: ${entry.package} (expired ${entry.expires}) — re-review it`);
  failed = true;
}

for (const { name, severity, causes } of unaccepted) {
  const titles = causes.map((c) => c.title).join('; ') || '(propagated)';
  console.error(`UNACCEPTED ${severity.toUpperCase()}: ${name} — ${titles}`);
  failed = true;
}

for (const [name, ids] of unreviewed) {
  console.error(`UNREVIEWED ADVISORIES on excepted package ${name}: ${ids.join(', ')}`);
}

if (failed) {
  console.error(
    '\nFix the dependency, or add a justified, dated entry to security/audit-exceptions.json.',
  );
  process.exit(1);
}

console.log('OK — no unaccepted high/critical advisories.');
