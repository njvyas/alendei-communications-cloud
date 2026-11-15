/**
 * Phase 8B PR 8B-3a: the owner-run automation:control CLI — the fixed command surface and the
 * fail-closed environment guard.
 */
import {
  assertAutomationControlEnvironment,
  AutomationControlRefusal,
  parseAutomationControlCommandLine,
} from './automation-control';
import { CommandLineError } from './platform-support';

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
