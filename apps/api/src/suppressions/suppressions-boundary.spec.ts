import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSuppressionDto, LiftSuppressionDto } from './suppressions.dto';

const codeOf = (file: string): string =>
  readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const serviceCode = codeOf('suppressions.service.ts');
const controllerCode = codeOf('suppressions.controller.ts');

const errorsFor = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
    (e) => e.property,
  );

describe('Suppressions boundary and structural guarantees', () => {
  it('finds the files it is asserting over', () => {
    expect(serviceCode.length).toBeGreaterThan(1000);
    expect(controllerCode.length).toBeGreaterThan(500);
  });

  it('implements savepoint isolation for suppression conflict handling', () => {
    expect(serviceCode).toMatch(/SAVEPOINT suppression_insert/);
    expect(serviceCode).toMatch(/ROLLBACK TO SAVEPOINT suppression_insert/);
    expect(serviceCode).toMatch(/SUPPRESSION_ALREADY_ACTIVE/);
  });

  it('never deletes a suppression row (lifting sets status to cleared)', () => {
    expect(serviceCode).not.toMatch(/\.delete\(\s*schema\.suppressions\)/);
    expect(controllerCode).not.toMatch(/@Delete/);
    expect(serviceCode).toMatch(/status:\s*['"]cleared['"]/);
  });

  it('controller enforces SUPPRESSIONS_READ and SUPPRESSIONS_MANAGE permissions', () => {
    expect(controllerCode).toContain('PERMISSIONS.SUPPRESSIONS_READ');
    expect(controllerCode).toContain('PERMISSIONS.SUPPRESSIONS_MANAGE');
  });

  describe('DTO validation', () => {
    it('validates CreateSuppressionDto', async () => {
      // Channel-specific suppression
      expect(
        await errorsFor(CreateSuppressionDto, {
          channelId: '01900000-0000-7000-8000-000000000001',
          rawAddress: '+12025550123',
          reason: 'Recipient complaint',
        }),
      ).toEqual([]);

      // Org-wide suppression (channelId omitted or null)
      expect(
        await errorsFor(CreateSuppressionDto, {
          rawAddress: '+12025550123',
          reason: 'Global unsubscribe',
        }),
      ).toEqual([]);

      expect(
        await errorsFor(CreateSuppressionDto, {
          rawAddress: '',
          reason: '',
        }),
      ).toEqual(expect.arrayContaining(['rawAddress', 'reason']));
    });

    it('validates LiftSuppressionDto', async () => {
      expect(await errorsFor(LiftSuppressionDto, { reason: 'User requested opt-in' })).toEqual([]);
      expect(await errorsFor(LiftSuppressionDto, { reason: '' })).toContain('reason');
    });
  });
});
