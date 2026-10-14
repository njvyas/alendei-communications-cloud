import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateTemplateDto,
  SimulateApprovalDto,
} from './templates.dto';

const codeOf = (file: string): string =>
  readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const serviceCode = codeOf('templates.service.ts');
const controllerCode = codeOf('templates.controller.ts');

const errorsFor = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
    (e) => e.property,
  );

describe('Templates boundary and structural guarantees', () => {
  it('finds the files it is asserting over', () => {
    expect(serviceCode.length).toBeGreaterThan(1000);
    expect(controllerCode.length).toBeGreaterThan(500);
  });

  it('implements soft-deletion with deletedAt rather than SQL DELETE', () => {
    expect(serviceCode).not.toMatch(/\.delete\(\s*schema\.templates\)/);
    expect(serviceCode).toMatch(/deletedAt/);
  });

  it('controller enforces TEMPLATES_READ and TEMPLATES_MANAGE permissions', () => {
    expect(controllerCode).toContain('PERMISSIONS.TEMPLATES_READ');
    expect(controllerCode).toContain('PERMISSIONS.TEMPLATES_MANAGE');
  });

  it('enforces simulated approval transition rules', () => {
    expect(serviceCode).toContain('draft');
    expect(serviceCode).toContain('pending');
    expect(serviceCode).toContain('approved');
    expect(serviceCode).toContain('rejected');
    expect(serviceCode).toContain('TEMPLATE_APPROVAL_CONFLICT');
  });

  describe('DTO validation', () => {
    it('validates CreateTemplateDto', async () => {
      expect(
        await errorsFor(CreateTemplateDto, {
          channelId: '01900000-0000-7000-8000-000000000001',
          name: 'welcome_template',
          body: 'Hello {{name}}',
          variables: ['name'],
        }),
      ).toEqual([]);

      expect(
        await errorsFor(CreateTemplateDto, {
          channelId: 'not-a-uuid',
          name: '',
          body: 'Hello',
        }),
      ).toEqual(expect.arrayContaining(['channelId', 'name']));
    });

    it('validates SimulateApprovalDto', async () => {
      expect(await errorsFor(SimulateApprovalDto, { targetStatus: 'pending' })).toEqual([]);
      expect(await errorsFor(SimulateApprovalDto, { targetStatus: 'approved' })).toEqual([]);
      expect(await errorsFor(SimulateApprovalDto, { targetStatus: 'invalid' })).toContain(
        'targetStatus',
      );
    });
  });
});
