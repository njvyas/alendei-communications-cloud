/**
 * Phase 8B PR 8B-3a: the organisation automation controls and the owner-run CLI — command surface,
 * environment guard, and the structural guarantees of C-1 (organisation-scope authority, user
 * sessions only) and C-5 (no journey or send path here).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertAutomationControlEnvironment,
  AutomationControlRefusal,
  parseAutomationControlCommandLine,
} from '../cli/automation-control';
import { CommandLineError } from '../cli/platform-support';

const SRC = join(__dirname, '..');
const code = (path: string): string =>
  readFileSync(join(SRC, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const ORG = '01934f2e-0000-7000-8000-000000000001';

describe('Phase 8B-3a: automation:control command line', () => {
  it('parses a state change with every required flag, and status with --org only', () => {
    expect(
      parseAutomationControlCommandLine([
        'pause',
        '--org',
        ORG,
        '--operator',
        'op@example.test',
        '--password-stdin',
        '--confirm-environment',
        'staging',
        '--reason',
        'incident',
      ]),
    ).toEqual({
      command: 'pause',
      orgId: ORG,
      operator: 'op@example.test',
      reason: 'incident',
      confirmEnvironment: 'staging',
    });
    expect(parseAutomationControlCommandLine(['status', '--org', ORG])).toMatchObject({
      command: 'status',
      operator: null,
    });
  });

  it.each([
    [['enable', '--org', ORG]],
    [
      [
        'pause',
        '--org',
        'not-a-uuid',
        '--operator',
        'a',
        '--password-stdin',
        '--confirm-environment',
        'test',
      ],
    ],
    [['pause', '--org', ORG, '--password-stdin', '--confirm-environment', 'test']],
    [['pause', '--org', ORG, '--operator', 'a', '--confirm-environment', 'test']],
    [['pause', '--org', ORG, '--operator', 'a', '--password-stdin']],
    [['status', '--org', ORG, '--operator', 'a']],
    [
      [
        'revoke',
        '--org',
        ORG,
        '--operator',
        'a',
        '--password-stdin',
        '--confirm-environment',
        'test',
        '--password',
        'x',
      ],
    ],
    [
      [
        'pause',
        '--org',
        ORG,
        '--org',
        ORG,
        '--operator',
        'a',
        '--password-stdin',
        '--confirm-environment',
        'test',
      ],
    ],
  ])('refuses %j', (argv) => {
    expect(() => parseAutomationControlCommandLine(argv)).toThrow(CommandLineError);
  });

  it('the environment guard fails closed: unset, production, unknown, unconfirmed', () => {
    expect(() => assertAutomationControlEnvironment(undefined, null, false)).toThrow(
      AutomationControlRefusal,
    );
    expect(() => assertAutomationControlEnvironment('production', 'production', true)).toThrow(
      /production/,
    );
    expect(() => assertAutomationControlEnvironment('qa-prod', 'qa-prod', true)).toThrow(
      AutomationControlRefusal,
    );
    expect(() => assertAutomationControlEnvironment('staging', 'test', true)).toThrow(
      /confirm-environment/,
    );
    expect(assertAutomationControlEnvironment('staging', 'staging', true)).toBe('staging');
    expect(assertAutomationControlEnvironment('test', null, false)).toBe('test');
  });
});

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
