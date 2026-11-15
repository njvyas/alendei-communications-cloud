/**
 * Phase 8B PR 8B-3a: the organisation automation controls — the structural guarantees of C-1 (organisation-scope authority, user
 * sessions only) and C-5 (no journey or send path here).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const code = (path: string): string =>
  readFileSync(join(SRC, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('Phase 8B-3a: automation controls — structure', () => {
  const service = code('automation/automation-controls.service.ts');
  const controller = code('automation/automation-controls.controller.ts');

  it('asserts campaigns.manage with the ORGANIZATION as the target, and refuses API keys (C-1)', () => {
    expect(service).toMatch(
      /permission: PERMISSIONS\.CAMPAIGNS_MANAGE,\s*target: \{ scopeType: 'organization', scopeId: orgId \}/,
    );
    expect(service).not.toMatch(/scopeType: 'workspace'/);
    expect(service).toMatch(/if \(principal\.apiKeyId\) throw forbidden\(\);/);
    expect(service).toMatch(/app_automation_control\(/);
  });

  it('every route declares campaigns.manage and accepts user sessions only', () => {
    expect(controller.match(/@RequiresPermission\(PERMISSIONS\.CAMPAIGNS_MANAGE/g)).toHaveLength(4);
    expect(controller.match(/@AcceptedCredentials\('userSession'\)/g)).toHaveLength(4);
    expect(controller).not.toMatch(/'apiKey'/);
  });

  it('reaches no send path, journey code or submission core', () => {
    for (const source of [service, controller, code('cli/automation-control.ts')]) {
      expect(source).not.toMatch(
        /MessageSubmissionCore|messages\/submission|journeys\/|SubmissionOrigin|provider-adapters|dispatch\//,
      );
    }
  });
});
