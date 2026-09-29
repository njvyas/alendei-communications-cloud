/**
 * Generates the Swagger plugin metadata (`src/metadata.ts`) — the single source
 * of DTO schema metadata for the build, Jest, the generator and CI (Phase 1C.3
 * ADR, G5). The CLI plugin is not part of `nest build`; this file replaces it.
 *
 *   npm run openapi:metadata          write src/metadata.ts
 *   npm run openapi:metadata -- --check   generate into a temporary directory
 *                                     and fail if it differs from the committed
 *                                     file (never writes the committed file)
 *
 * Runs under `tsx`: it only traverses the TypeScript AST and needs no
 * decorator metadata of its own.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PluginMetadataGenerator } from '@nestjs/cli/lib/compiler/plugins/plugin-metadata-generator';
import { ReadonlyVisitor } from '@nestjs/swagger/plugin';

const API_ROOT = resolve(__dirname, '..');
const SOURCE = join(API_ROOT, 'src');
const FILENAME = 'metadata.ts';
const check = process.argv.includes('--check');

function generate(outputDir: string): void {
  process.chdir(API_ROOT);
  new PluginMetadataGenerator().generate({
    visitors: [
      new ReadonlyVisitor({
        pathToSource: SOURCE,
        // Comments stay out of the published contract: descriptions are
        // written deliberately, never lifted from implementation notes.
        introspectComments: false,
        classValidatorShim: true,
      }),
    ],
    outputDir,
    tsconfigPath: 'tsconfig.json',
    filename: FILENAME,
    printDiagnostics: false,
  });
}

if (check) {
  const temp = mkdtempSync(join(tmpdir(), 'acc-openapi-metadata-'));
  try {
    generate(temp);
    const fresh = readFileSync(join(temp, FILENAME), 'utf8');
    const committed = readFileSync(join(SOURCE, FILENAME), 'utf8');
    if (fresh !== committed) {
      console.error(
        `apps/api/src/${FILENAME} is stale: regenerate it with \`npm run openapi:metadata\` and commit the result.`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`apps/api/src/${FILENAME} is current.\n`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  if (process.env.CI) {
    console.error('openapi:metadata refuses to write in CI; run the --check mode instead.');
    process.exit(1);
  }
  generate(SOURCE);
  process.stdout.write(`wrote apps/api/src/${FILENAME}\n`);
}
