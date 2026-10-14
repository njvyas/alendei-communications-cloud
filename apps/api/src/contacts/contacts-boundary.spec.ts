import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateContactDto,
  CreateContactIdentityDto,
  CreateConsentEventDto,
} from './contacts.dto';

const codeOf = (file: string): string =>
  readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const serviceCode = codeOf('contacts.service.ts');
const controllerCode = codeOf('contacts.controller.ts');

const errorsFor = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
    (e) => e.property,
  );

describe('Contacts boundary and structural guarantees', () => {
  it('finds the files it is asserting over', () => {
    expect(serviceCode.length).toBeGreaterThan(1000);
    expect(controllerCode.length).toBeGreaterThan(500);
  });

  it('never deletes a contact (no DELETE endpoint or delete query)', () => {
    expect(serviceCode).not.toMatch(/\.delete\(\s*schema\.contacts\)/);
    expect(controllerCode).not.toMatch(/@Delete/);
  });

  it('never takes an organization from the request body or path', () => {
    expect(serviceCode).not.toMatch(/dto\.orgId/);
    expect(serviceCode).not.toMatch(/query\.orgId/);
  });

  it('acquires contact row lock for update on consent event write', () => {
    expect(serviceCode).toMatch(/\.for\(\s*['"]update['"]\s*\)/);
    expect(serviceCode).toMatch(/schema\.contacts/);
  });

  it('enforces 5-minute future timestamp guard for consent events', () => {
    expect(serviceCode).toMatch(/5 \* 60 \* 1000/);
    expect(serviceCode).toMatch(/CONSENT_FUTURE_TIMESTAMP/);
  });

  it('controller enforces CONTACTS_READ and CONTACTS_MANAGE permissions', () => {
    expect(controllerCode).toContain('PERMISSIONS.CONTACTS_READ');
    expect(controllerCode).toContain('PERMISSIONS.CONTACTS_MANAGE');
  });

  describe('DTO validation', () => {
    it('validates CreateContactDto', async () => {
      expect(await errorsFor(CreateContactDto, { firstName: 'Alice', lastName: 'Smith' })).toEqual(
        [],
      );
      expect(
        await errorsFor(CreateContactDto, { firstName: 123 as unknown as string }),
      ).toContain('firstName');
    });

    it('validates CreateContactIdentityDto', async () => {
      expect(
        await errorsFor(CreateContactIdentityDto, {
          channelId: '01900000-0000-7000-8000-000000000001',
          rawAddress: '+12025550123',
        }),
      ).toEqual([]);

      expect(
        await errorsFor(CreateContactIdentityDto, {
          channelId: 'not-a-uuid',
          rawAddress: '+12025550123',
        }),
      ).toContain('channelId');
    });

    it('validates CreateConsentEventDto', async () => {
      expect(
        await errorsFor(CreateConsentEventDto, {
          channelId: '01900000-0000-7000-8000-000000000001',
          consentType: 'marketing',
          event: 'grant',
          occurredAt: '2026-10-13T12:00:00Z',
          source: 'web_form',
        }),
      ).toEqual([]);

      expect(
        await errorsFor(CreateConsentEventDto, {
          channelId: '01900000-0000-7000-8000-000000000001',
          consentType: 'marketing',
          event: 'invalid_event',
          occurredAt: 'not-a-date',
          source: 'web_form',
        }),
      ).toEqual(expect.arrayContaining(['event', 'occurredAt']));
    });
  });
});
