import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CampaignAudiencePreviewDto,
  CreateCampaignDto,
  ListCampaignRecipientsDto,
  ScheduleCampaignDto,
  UpdateCampaignDto,
} from './campaigns.dto';

const codeOf = (file: string): string =>
  readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const serviceCode = codeOf('campaigns.service.ts');
const controllerCode = codeOf('campaigns.controller.ts');

const errorsFor = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
    (e) => e.property,
  );

describe('Campaigns boundary and structural guarantees', () => {
  it('finds the files it is asserting over', () => {
    expect(serviceCode.length).toBeGreaterThan(1000);
    expect(controllerCode.length).toBeGreaterThan(500);
  });

  it('implements soft-deletion with deletedAt rather than SQL DELETE', () => {
    expect(serviceCode).not.toMatch(/\.delete\(\s*schema\.campaigns\)/);
    expect(serviceCode).toMatch(/deletedAt/);
  });

  it('controller enforces CAMPAIGNS_READ and CAMPAIGNS_MANAGE permissions', () => {
    expect(controllerCode).toContain('PERMISSIONS.CAMPAIGNS_READ');
    expect(controllerCode).toContain('PERMISSIONS.CAMPAIGNS_MANAGE');
  });

  it('dispatch endpoint is disabled by default and fails with explicit notice', () => {
    expect(serviceCode).toContain('ERROR_CODES.CAMPAIGN_DISPATCH_DISABLED');
    expect(serviceCode).toContain('Campaign dispatch remains disabled');
  });

  describe('Phase 8B PR 8B-3b: dispatch, scheduling and the executor boundary', () => {
    const method = (name: string): string => {
      const start = serviceCode.indexOf(`  async ${name}(`);
      expect(start).toBeGreaterThan(0);
      const next = serviceCode.indexOf('\n  async ', start + 10);
      return serviceCode.slice(start, next === -1 ? undefined : next);
    };
    const executorCode = codeOf('dispatch/campaign-dispatch.service.ts');

    it('dispatch refuses (CAMPAIGN_DISPATCH_DISABLED) before any state change unless the flag is on', () => {
      const dispatch = method('dispatch');
      const gate = dispatch.indexOf('if (!this.config.campaigns.dispatchEnabled)');
      expect(gate).toBeGreaterThan(0);
      expect(dispatch.indexOf('ERROR_CODES.CAMPAIGN_DISPATCH_DISABLED')).toBeGreaterThan(gate);
      for (const write of [
        '.update(schema.campaigns)',
        '.insert(schema.campaignDispatch)',
        'this.audit.record',
      ])
        expect(dispatch.indexOf(write)).toBeGreaterThan(gate);
    });

    it("dispatch, schedule and resume assert the caller's messages.send; pause and cancel do not need it", () => {
      for (const name of ['dispatch', 'schedule', 'resume'])
        expect(method(name)).toContain('PERMISSIONS.MESSAGES_SEND');
      for (const name of ['pause', 'cancel'])
        expect(method(name)).not.toContain('PERMISSIONS.MESSAGES_SEND');
    });

    it('pause and cancel remove the claim row; cancel skips pending recipients; resume restores the claim', () => {
      for (const name of ['pause', 'cancel'])
        expect(method(name)).toMatch(/\.delete\(schema\.campaignDispatch\)/);
      expect(method('cancel')).toContain('CAMPAIGN_EXECUTOR_CODES.CAMPAIGN_CANCELLED');
      expect(method('resume')).toMatch(/\.insert\(schema\.campaignDispatch\)/);
      expect(method('pause')).toContain("pauseReason: 'operator'");
      expect(method('resume')).toContain('pauseReason: null');
    });

    it('the campaigns service never reaches the submission core; only the executor does', () => {
      expect(serviceCode).not.toMatch(/submission|MessageSubmissionCore|SubmissionOrigin/);
      expect(executorCode).toContain('authorizeAutomationSubmission(');
      expect(executorCode).not.toMatch(/\bauthorizeSubmission\(/);
    });

    it('the executor runs only on the acc_campaign connection and never calls a provider', () => {
      expect(executorCode).toContain('@Inject(CAMPAIGN_DB)');
      expect(executorCode).not.toMatch(/APP_DB|ADMIN|DISPATCH_DB|TenantDatabase/);
      expect(executorCode).not.toMatch(/ProviderAdapter|adapter|providers\//i);
    });
  });

  it('reuses ContactsService.resolveAudience for audience queries', () => {
    expect(serviceCode).toContain('this.contactsService.resolveAudience');
  });

  it('enforces database-level duplicate prevention for recipients', () => {
    expect(serviceCode).toContain('.onConflictDoNothing(');
  });

  it('removes fallback to arbitrary channel identity (member.identities[0])', () => {
    expect(serviceCode).not.toContain('member.identities[0]');
  });

  it('enforces atomic conditional lifecycle transitions with expected status predicates', () => {
    expect(serviceCode).toContain("inArray(schema.campaigns.status, ['draft', 'scheduled'])");
    expect(serviceCode).toContain(
      "inArray(schema.campaigns.status, ['draft', 'scheduled', 'running', 'paused'])",
    );
    expect(serviceCode).toContain("eq(schema.campaigns.status, 'running')");
    expect(serviceCode).toContain("eq(schema.campaigns.status, 'paused')");
  });

  describe('DTO validation', () => {
    it('validates valid CreateCampaignDto', async () => {
      expect(
        await errorsFor(CreateCampaignDto, {
          name: 'Summer Promotion',
          channel: 'whatsapp',
          templateId: '01900000-0000-7000-8000-000000000001',
          recipientSource: {
            type: 'all_contacts',
            contactCount: 150,
          },
          scheduleMode: 'immediate',
        }),
      ).toEqual([]);
    });

    it('rejects invalid CreateCampaignDto missing required fields', async () => {
      const errors = await errorsFor(CreateCampaignDto, {
        description: 'Missing name and template',
      });
      expect(errors).toContain('name');
      expect(errors).toContain('templateId');
      expect(errors).toContain('recipientSource');
    });

    it('validates UpdateCampaignDto', async () => {
      expect(
        await errorsFor(UpdateCampaignDto, {
          name: 'Updated Campaign Name',
          description: 'Updated description',
        }),
      ).toEqual([]);
    });

    it('validates CampaignAudiencePreviewDto', async () => {
      expect(
        await errorsFor(CampaignAudiencePreviewDto, {
          tags: ['vip', 'promo'],
          tagMatchMode: 'all',
          requireOptIn: true,
          limit: 20,
        }),
      ).toEqual([]);

      const invalid = await errorsFor(CampaignAudiencePreviewDto, {
        tagMatchMode: 'invalid_mode',
        requireOptIn: 'not-a-boolean',
      });
      expect(invalid).toContain('tagMatchMode');
      expect(invalid).toContain('requireOptIn');
    });

    it('validates ScheduleCampaignDto', async () => {
      expect(
        await errorsFor(ScheduleCampaignDto, {
          scheduledAt: '2026-12-01T10:00:00.000Z',
        }),
      ).toEqual([]);

      const invalid = await errorsFor(ScheduleCampaignDto, {
        scheduledAt: 'not-an-iso-date',
      });
      expect(invalid).toContain('scheduledAt');
    });

    it('validates ListCampaignRecipientsDto', async () => {
      expect(
        await errorsFor(ListCampaignRecipientsDto, {
          status: 'pending',
          limit: 50,
        }),
      ).toEqual([]);

      const invalid = await errorsFor(ListCampaignRecipientsDto, {
        status: 'not_a_valid_status',
      });
      expect(invalid).toContain('status');
    });
  });
});
