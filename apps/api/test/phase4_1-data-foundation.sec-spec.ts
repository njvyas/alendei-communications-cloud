/**
 * Phase 4.1 Security Specification Suite (Gate F.1, ADR-016)
 *
 * Verifies the Data and Regulatory Foundation for SMS and RCS:
 * 1. Recipient Address Normalization & E.164 Enforcement (fixing RCS bypass).
 * 2. SMS DLT Regulatory Metadata & Approved-Template Binding (entityId, templateId, headerId).
 * 3. SMS Segmentation & Segment Limit Enforcement (GSM-7 basic/extended, UCS-2, configurable ceilings).
 * 4. RCS Payload Validation & Action URL Safety (safe protocols: http/https, script blocking: javascript:/data:).
 * 5. Channel Integrity, Tenancy Isolation & Regulatory Safeguards (consent, suppression, anti-enumeration).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, type SmsDltMetadata } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

describe('Phase 4.1 Data & Regulatory Foundation Security Suite (Gate F.1, ADR-016)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  let channelSmsId: string;
  let channelRcsId: string;
  let channelWhatsappId: string;

  let providerSmsId: string;
  let providerRcsId: string;

  let userAToken: string;
  let userBToken: string;

  const createdRoleIds: string[] = [];

  let approvedSmsTemplateId: string;
  let approvedLongSmsTemplateId: string;
  let approvedNoHeaderSmsTemplateId: string;
  let approvedTwoSegmentSmsTemplateId: string;
  let approvedUnicodeSmsTemplateId: string;
  let approvedOversizeSmsTemplateId: string;
  let approvedPlaceholderOnlySmsTemplateId: string;
  let draftSmsTemplateId: string;
  const templateDlt: SmsDltMetadata = {
    entityId: '1201159123456789012',
    templateId: '1207161234567890123',
    headerId: 'ALENDE',
  };
  const templateDltNoHeader: SmsDltMetadata = {
    entityId: '1201159123456789012',
    templateId: '1207161234567890123',
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);

    tenantA = await createTenant(h.admin, 'p41-a', credentials);
    tenantB = await createTenant(h.admin, 'p41-b', credentials);

    // Grant messages permissions to both tenants
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [
          PERMISSIONS.MESSAGES_SEND,
          PERMISSIONS.MESSAGES_READ,
          PERMISSIONS.TEMPLATES_READ,
          PERMISSIONS.TEMPLATES_MANAGE,
          PERMISSIONS.CONTACTS_READ,
          PERMISSIONS.CONTACTS_MANAGE,
        ]),
      );

    for (const t of [tenantA, tenantB]) {
      const roleId = uuidv7();
      createdRoleIds.push(roleId);
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: t.orgId,
        key: `p41_role_${randomBytes(4).toString('hex')}`,
        name: 'Phase 4.1 Test Role',
        description: 'Grants messages, templates, and contacts access',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      });

      for (const p of perms) {
        await h.admin.insert(schema.rolePermissions).values({
          roleId,
          permissionId: p.id,
          orgId: t.orgId,
        });
      }

      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx.insert(schema.userRoles).values({
          userId: t.userId,
          roleId,
          scopeType: 'organization',
          scopeId: t.orgId,
        });
      });
    }

    // Resolve channel IDs
    const allChannels = await h.admin.select().from(schema.channels);
    for (const c of allChannels) {
      if (c.code === 'sms') channelSmsId = c.id;
      if (c.code === 'rcs') channelRcsId = c.id;
      if (c.code === 'whatsapp') channelWhatsappId = c.id;
    }

    // Setup simulator providers for SMS and RCS
    const [smsProv] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelSmsId,
        adapterKey: 'simulator',
        name: 'SMS Simulator Provider',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providerSmsId = smsProv!.id;

    const [rcsProv] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelRcsId,
        adapterKey: 'simulator',
        name: 'RCS Simulator Provider',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providerRcsId = rcsProv!.id;

    // Create active provider assignments for tenantA on SMS and RCS
    await h.admin.insert(schema.organizationProviderAssignments).values([
      {
        orgId: tenantA.orgId,
        channelId: channelSmsId,
        providerId: providerSmsId,
        priority: 1,
        status: 'active',
      },
      {
        orgId: tenantA.orgId,
        channelId: channelRcsId,
        providerId: providerRcsId,
        priority: 1,
        status: 'active',
      },
    ]);

    // Authenticate users
    await h.clearRateLimits();
    const loginA = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantA.email, password: PASSWORD })
      .expect(200);
    userAToken = loginA.body.data.accessToken;

    await h.clearRateLimits();
    const loginB = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantB.email, password: PASSWORD })
      .expect(200);
    userBToken = loginB.body.data.accessToken;

    // Create approved SMS templates with bound DLT metadata
    const [tmpl] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: channelSmsId,
        name: 'sms_otp_template',
        body: 'Your verification code is {{1}}.',
        variables: { names: ['1'], dlt: templateDlt },
        approvalStatus: 'approved',
      })
      .returning();
    approvedSmsTemplateId = tmpl!.id;

    const [longTmpl] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: channelSmsId,
        name: 'sms_long_template',
        body: 'Notice: {{msg}}',
        variables: { names: ['msg'], dlt: templateDlt },
        approvalStatus: 'approved',
      })
      .returning();
    approvedLongSmsTemplateId = longTmpl!.id;

    const [noHeaderTmpl] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: channelSmsId,
        name: 'sms_no_header_template',
        body: 'Your code is {{1}}.',
        variables: { names: ['1'], dlt: templateDltNoHeader },
        approvalStatus: 'approved',
      })
      .returning();
    approvedNoHeaderSmsTemplateId = noHeaderTmpl!.id;

    const insertSmsTemplate = async (
      name: string,
      body: string,
      approvalStatus: 'approved' | 'draft' = 'approved',
    ) => {
      const [row] = await h.admin
        .insert(schema.templates)
        .values({
          id: uuidv7(),
          orgId: tenantA.orgId,
          channelId: channelSmsId,
          name,
          body,
          variables: { names: ['msg'], dlt: templateDlt },
          approvalStatus,
        })
        .returning();
      return row!.id;
    };
    // 150 fixed GSM-7 characters: any variable pushes the message past one segment.
    approvedTwoSegmentSmsTemplateId = await insertSmsTemplate(
      'sms_two_segment_template',
      `${'A'.repeat(150)} {{msg}}`,
    );
    // 100 astral characters (200 UTF-16 units): 4 concatenated UCS-2 segments.
    approvedUnicodeSmsTemplateId = await insertSmsTemplate(
      'sms_unicode_template',
      `${'🌟'.repeat(100)} {{msg}}`,
    );
    // 1600 fixed characters: 11 concatenated GSM-7 segments, over the server ceiling.
    approvedOversizeSmsTemplateId = await insertSmsTemplate(
      'sms_oversize_template',
      `${'A'.repeat(1600)} {{msg}}`,
    );
    // A placeholder-only body written outside the API, as a pre-remediation row could be.
    approvedPlaceholderOnlySmsTemplateId = await insertSmsTemplate(
      'sms_placeholder_only_template',
      '{{msg}}',
    );
    draftSmsTemplateId = await insertSmsTemplate(
      'sms_draft_dlt_template',
      'Draft {{msg}}',
      'draft',
    );
  }, 60_000);

  afterAll(async () => {
    try {
      if (h?.admin) {
        const orgIds = [tenantA?.orgId, tenantB?.orgId].filter(Boolean);
        if (orgIds.length > 0) {
          await h.admin
            .delete(schema.messageDispatchQueue)
            .where(inArray(schema.messageDispatchQueue.orgId, orgIds))
            .catch(() => {});
          await purgeMessageEvents(h.admin, inArray(schema.messageEvents.orgId, orgIds)).catch(
            () => {},
          );
          await h.admin
            .delete(schema.messageAttempts)
            .where(inArray(schema.messageAttempts.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.messages)
            .where(inArray(schema.messages.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.organizationProviderAssignments)
            .where(inArray(schema.organizationProviderAssignments.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.templates)
            .where(inArray(schema.templates.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.suppressions)
            .where(inArray(schema.suppressions.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.consentEvents)
            .where(inArray(schema.consentEvents.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.contactIdentities)
            .where(inArray(schema.contactIdentities.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.contacts)
            .where(inArray(schema.contacts.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.userRoles)
            .where(inArray(schema.userRoles.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.rolePermissions)
            .where(inArray(schema.rolePermissions.orgId, orgIds))
            .catch(() => {});
          await h.admin
            .delete(schema.roles)
            .where(inArray(schema.roles.orgId, orgIds))
            .catch(() => {});
        }
        await h.admin
          .delete(schema.providers)
          .where(inArray(schema.providers.id, [providerSmsId, providerRcsId].filter(Boolean)))
          .catch(() => {});
        await destroyTenant(h.admin, tenantA).catch(() => {});
        await destroyTenant(h.admin, tenantB).catch(() => {});
      }
    } finally {
      if (h) await h.close();
    }
  });

  describe('1. Recipient Address Normalization & E.164 Enforcement', () => {
    it('normalizes valid RCS phone numbers to E.164 and queues message (202)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+1 (202) 555-0198',
          payload: { messageType: 'text', text: 'Hello via RCS' },
        });

      expect(res.status).toBe(202);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.status).toBe('queued');

      const getRes = await request(h.app.getHttpServer())
        .get(url(`/messages/${res.body.data.id}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.recipientAddress).toBe('+12025550198');
    });

    it('rejects RCS recipient without leading + with 400 PHONE_MISSING_COUNTRY_CODE', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '2025550198',
          payload: { messageType: 'text', text: 'Missing country code' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.PHONE_MISSING_COUNTRY_CODE);
    });

    it('rejects RCS recipient with invalid phone format with 400 INVALID_PHONE_NUMBER', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+1234', // too short (< 7 digits)
          payload: { messageType: 'text', text: 'Too short' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_PHONE_NUMBER);
    });

    it('normalizes valid SMS phone numbers to E.164 and queues message (202)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+91 98765-43210',
          templateId: approvedSmsTemplateId,
          payload: { variables: { '1': '123456' } },
        });

      expect(res.status).toBe(202);
      expect(res.body.data.id).toBeDefined();

      const getRes = await request(h.app.getHttpServer())
        .get(url(`/messages/${res.body.data.id}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.recipientAddress).toBe('+919876543210');
    });

    it('rejects SMS recipient without leading + with 400 PHONE_MISSING_COUNTRY_CODE', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '9876543210',
          templateId: approvedSmsTemplateId,
          payload: { variables: { '1': '123456' } },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.PHONE_MISSING_COUNTRY_CODE);
    });

    it('rejects SMS dispatch without an approved registered template with 422 SMS_DLT_METADATA_REQUIRED', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          payload: { text: 'Direct untemplated SMS' },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_METADATA_REQUIRED);
    });
  });

  describe('2. SMS DLT Regulatory Metadata & Approved-Template Binding', () => {
    it('successfully dispatches SMS with approved template using bound DLT metadata (202)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: { variables: { '1': '654321' } },
        });

      expect(res.status).toBe(202);
      expect(res.body.data.id).toBeDefined();

      const getRes = await request(h.app.getHttpServer())
        .get(url(`/messages/${res.body.data.id}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.templateId).toBe(approvedSmsTemplateId);
    });

    it('successfully dispatches SMS with approved template when payload DLT exactly matches template DLT (202)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: {
            variables: { '1': '654321' },
            dlt: templateDlt,
          },
        });

      expect(res.status).toBe(202);
    });

    it('rejects SMS when payload DLT has mismatching entityId with 422 SMS_DLT_TEMPLATE_MISMATCH', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: {
            variables: { '1': '654321' },
            dlt: {
              entityId: '9999999999999999999', // Mismatched entityId
              templateId: templateDlt.templateId,
              headerId: templateDlt.headerId,
            },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_TEMPLATE_MISMATCH);
    });

    it('rejects SMS when payload DLT has mismatching templateId with 422 SMS_DLT_TEMPLATE_MISMATCH', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: {
            variables: { '1': '654321' },
            dlt: {
              entityId: templateDlt.entityId,
              templateId: '9999999999999999999', // Mismatched templateId
              headerId: templateDlt.headerId,
            },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_TEMPLATE_MISMATCH);
    });

    it('rejects SMS when template defines headerId but payload omits it with 422 SMS_DLT_TEMPLATE_MISMATCH', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: {
            variables: { '1': '654321' },
            dlt: {
              entityId: templateDlt.entityId,
              templateId: templateDlt.templateId,
            },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_TEMPLATE_MISMATCH);
    });

    it('rejects SMS when template omits headerId but payload specifies headerId with 422 SMS_DLT_TEMPLATE_MISMATCH', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedNoHeaderSmsTemplateId,
          payload: {
            variables: { '1': '654321' },
            dlt: {
              entityId: templateDltNoHeader.entityId,
              templateId: templateDltNoHeader.templateId,
              headerId: 'ALENDE',
            },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_TEMPLATE_MISMATCH);
    });

    it('rejects SMS payload with dlt: null with 422 SMS_DLT_METADATA_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: {
            variables: { '1': '654321' },
            dlt: null,
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_METADATA_INVALID);
    });

    it('rejects SMS template lacking DLT on both template and payload with 422 SMS_DLT_METADATA_REQUIRED', async () => {
      // Create approved template WITHOUT DLT metadata
      const [noDltTmpl] = await h.admin
        .insert(schema.templates)
        .values({
          id: uuidv7(),
          orgId: tenantA.orgId,
          channelId: channelSmsId,
          name: 'sms_no_dlt_template',
          body: 'Plain SMS template without DLT.',
          variables: [],
          approvalStatus: 'approved',
        })
        .returning();

      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: noDltTmpl!.id,
          payload: {},
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_METADATA_REQUIRED);
    });

    it('rejects SMS payload with malformed DLT metadata with 422 SMS_DLT_METADATA_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: {
            variables: { '1': '123456' },
            dlt: {
              entityId: 'short', // non-digit, too short
              templateId: '123',
            },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_METADATA_INVALID);
    });

    it('rejects SMS payload.text attempting to override approved template body with 422 SMS_PAYLOAD_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: {
            variables: { '1': '123456' },
            text: 'Overriding template body',
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_PAYLOAD_INVALID);
    });

    it('rejects SMS when required template variable is missing with 422 SMS_TEMPLATE_VARIABLE_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+919876543210',
          templateId: approvedSmsTemplateId,
          payload: {
            variables: {},
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID);
    });

    it('rejects attaching DLT metadata to non-SMS template via POST /templates with 422 VALIDATION_FAILED', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/templates'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelId: channelWhatsappId,
          name: `whatsapp_dlt_forbidden_${randomBytes(3).toString('hex')}`,
          body: 'Hello WhatsApp',
          variables: ['1'],
          dlt: templateDlt,
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('rejects updating non-SMS template to include DLT metadata via PATCH /templates/:id with 422 VALIDATION_FAILED', async () => {
      const [waTmpl] = await h.admin
        .insert(schema.templates)
        .values({
          id: uuidv7(),
          orgId: tenantA.orgId,
          channelId: channelWhatsappId,
          name: `wa_tmpl_${randomBytes(3).toString('hex')}`,
          body: 'WhatsApp plain',
          variables: [],
          approvalStatus: 'draft',
        })
        .returning();

      const res = await request(h.app.getHttpServer())
        .patch(url(`/templates/${waTmpl!.id}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          dlt: templateDlt,
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('rejects simulating approval for SMS template lacking DLT with 422 SMS_DLT_METADATA_REQUIRED', async () => {
      const [smsDraftTmpl] = await h.admin
        .insert(schema.templates)
        .values({
          id: uuidv7(),
          orgId: tenantA.orgId,
          channelId: channelSmsId,
          name: `sms_draft_no_dlt_${randomBytes(3).toString('hex')}`,
          body: 'Plain SMS draft',
          variables: [],
          approvalStatus: 'pending',
        })
        .returning();

      const res = await request(h.app.getHttpServer())
        .post(url(`/templates/${smsDraftTmpl!.id}/simulate-approval`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({ targetStatus: 'approved' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_METADATA_REQUIRED);
    });

    it('successfully creates and approves SMS template with valid DLT metadata via API', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url('/templates'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelId: channelSmsId,
          name: `sms_api_valid_${randomBytes(3).toString('hex')}`,
          body: 'API verification code {{code}}.',
          variables: ['code'],
          dlt: templateDlt,
        });

      expect(createRes.status).toBe(201);
      const createdId = createRes.body.data.id;
      expect(createdId).toBeDefined();

      const pendingRes = await request(h.app.getHttpServer())
        .post(url(`/templates/${createdId}/simulate-approval`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({ targetStatus: 'pending' });
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.data.approvalStatus).toBe('pending');

      const approveRes = await request(h.app.getHttpServer())
        .post(url(`/templates/${createdId}/simulate-approval`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({ targetStatus: 'approved' });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.data.approvalStatus).toBe('approved');
    });
  });

  describe('3. SMS Segmentation & Segment Limit Enforcement', () => {
    it('successfully queues SMS message within segment limit (202)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+12025550198',
          templateId: approvedLongSmsTemplateId,
          payload: {
            variables: { msg: 'Short message within limit.' },
            maxSegments: 1,
          },
        });

      expect(res.status).toBe(202);
    });

    it('rejects SMS message exceeding custom maxSegments with 422 SMS_MAX_SEGMENTS_EXCEEDED', async () => {
      // 150 fixed + space + 15 = 166 characters: 2 concatenated segments
      const longText = 'B'.repeat(15);
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+12025550198',
          templateId: approvedTwoSegmentSmsTemplateId,
          payload: {
            variables: { msg: longText },
            maxSegments: 1, // Enforce strict 1-segment limit
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_MAX_SEGMENTS_EXCEEDED);
      expect(res.body.error.message).toContain('exceeding maximum allowed limit of 1');
    });

    it('rejects multi-segment UCS-2 Unicode message exceeding custom limit with 422 SMS_MAX_SEGMENTS_EXCEEDED', async () => {
      // 100 fixed astral characters + space + 1 = 202 UTF-16 units: 4 segments
      const unicodeText = 'x';
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+12025550198',
          templateId: approvedUnicodeSmsTemplateId,
          payload: {
            variables: { msg: unicodeText },
            maxSegments: 2, // Allow max 2 segments
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_MAX_SEGMENTS_EXCEEDED);
    });

    it('rejects SMS message exceeding default ceiling of 10 segments with 422 SMS_MAX_SEGMENTS_EXCEEDED', async () => {
      // 1600 fixed + space + 1 = 1602 characters: 11 segments > default 10
      const massiveText = 'A';
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+12025550198',
          templateId: approvedOversizeSmsTemplateId,
          payload: {
            variables: { msg: massiveText },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_MAX_SEGMENTS_EXCEEDED);
      expect(res.body.error.message).toContain('exceeding maximum allowed limit of 10');
    });

    it('enforces server ceiling: client maxSegments > 10 cannot weaken server ceiling (still rejected with 422)', async () => {
      const massiveText = 'A';
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+12025550198',
          templateId: approvedOversizeSmsTemplateId,
          payload: {
            variables: { msg: massiveText },
            maxSegments: 50, // Client tries to allow up to 50 segments
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_MAX_SEGMENTS_EXCEEDED);
      expect(res.body.error.message).toContain('exceeding maximum allowed limit of 10');
    });

    it('rejects non-positive or non-integer maxSegments with 422 SMS_PAYLOAD_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+12025550198',
          templateId: approvedLongSmsTemplateId,
          payload: {
            variables: { msg: 'Test message' },
            maxSegments: -1,
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_PAYLOAD_INVALID);
    });
  });

  describe('3b. SMS Template Variable Limits & Payload Allowlist', () => {
    const sendSms = (templateId: string, payload: Record<string, unknown>) =>
      request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({ channelCode: 'sms', recipient: '+919812345678', templateId, payload });

    it('accepts a variable exactly at the 30-character default maximum (202)', async () => {
      const res = await sendSms(approvedLongSmsTemplateId, { variables: { msg: 'v'.repeat(30) } });
      expect(res.status).toBe(202);
    });

    it('rejects a variable one character over the maximum with 422 SMS_TEMPLATE_VARIABLE_INVALID', async () => {
      const res = await sendSms(approvedLongSmsTemplateId, { variables: { msg: 'v'.repeat(31) } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID);
    });

    it('rejects an oversized variable that would otherwise carry free-form content', async () => {
      const res = await sendSms(approvedLongSmsTemplateId, {
        variables: { msg: 'Unregistered promotional content '.repeat(20) },
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID);
    });

    it.each([
      ['object', { nested: 'x' }],
      ['array', ['x']],
      ['boolean', true],
      ['null', null],
    ])('rejects a %s variable value with 422 SMS_TEMPLATE_VARIABLE_INVALID', async (_l, value) => {
      const res = await sendSms(approvedLongSmsTemplateId, { variables: { msg: value } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID);
    });

    it('rejects an undeclared variable name with 422 SMS_TEMPLATE_VARIABLE_INVALID', async () => {
      const res = await sendSms(approvedLongSmsTemplateId, {
        variables: { msg: 'ok', injected: 'extra' },
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID);
    });

    it('rejects non-object variables with 422 SMS_TEMPLATE_VARIABLE_INVALID', async () => {
      const res = await sendSms(approvedLongSmsTemplateId, { variables: 'msg' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID);
    });

    it('refuses to dispatch an approved placeholder-only template with 422 SMS_TEMPLATE_INVALID', async () => {
      const res = await sendSms(approvedPlaceholderOnlySmsTemplateId, {
        variables: { msg: 'Free text' },
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_INVALID);
    });

    it('rejects an unknown SMS payload field with 422 SMS_PAYLOAD_INVALID', async () => {
      const res = await sendSms(approvedLongSmsTemplateId, {
        variables: { msg: 'ok' },
        senderOverride: 'SPOOFD',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_PAYLOAD_INVALID);
    });

    it('rejects an oversized SMS payload with 422 SMS_PAYLOAD_INVALID', async () => {
      const res = await sendSms(approvedLongSmsTemplateId, {
        variables: { msg: 'x'.repeat(9000) },
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_PAYLOAD_INVALID);
    });

    it('rejects non-string payload.text with 422 SMS_PAYLOAD_INVALID', async () => {
      const res = await sendSms(approvedLongSmsTemplateId, { variables: { msg: 'ok' }, text: 123 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_PAYLOAD_INVALID);
    });

    it('persists only server-rendered text and the template DLT, regardless of payload restatement', async () => {
      const res = await sendSms(approvedSmsTemplateId, {
        variables: { '1': '424242' },
        text: 'Your verification code is 424242.',
        dlt: { ...templateDlt },
      });
      expect(res.status).toBe(202);
      const [row] = await h.admin
        .select({ payload: schema.messages.payload })
        .from(schema.messages)
        .where(eq(schema.messages.id, res.body.data.id));
      expect(row!.payload).toEqual({
        text: 'Your verification code is 424242.',
        dlt: templateDlt,
        variables: { '1': '424242' },
      });
    });

    it('rejects creating a placeholder-only SMS template with 422 SMS_TEMPLATE_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/templates'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelId: channelSmsId,
          name: `sms_placeholder_only_${randomBytes(3).toString('hex')}`,
          body: ' {{1}}  {{2}} ',
          variables: ['1', '2'],
          dlt: templateDlt,
        });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_INVALID);
    });

    it('rejects updating an SMS template body to placeholders only with 422 SMS_TEMPLATE_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/templates/${draftSmsTemplateId}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({ body: '{{msg}}' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_INVALID);
    });

    it('refuses to approve a placeholder-only SMS template with 422 SMS_TEMPLATE_INVALID', async () => {
      const [pending] = await h.admin
        .insert(schema.templates)
        .values({
          id: uuidv7(),
          orgId: tenantA.orgId,
          channelId: channelSmsId,
          name: `sms_pending_placeholder_${randomBytes(3).toString('hex')}`,
          body: '{{msg}}',
          variables: { names: ['msg'], dlt: templateDlt },
          approvalStatus: 'pending',
        })
        .returning();
      const res = await request(h.app.getHttpServer())
        .post(url(`/templates/${pending!.id}/simulate-approval`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({ targetStatus: 'approved' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_TEMPLATE_INVALID);
    });
  });

  describe('3c. SMS Template DLT PATCH Semantics', () => {
    const patch = (id: string, body: Record<string, unknown>) =>
      request(h.app.getHttpServer())
        .patch(url(`/templates/${id}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send(body);
    const storedDlt = async (id: string) => {
      const [row] = await h.admin
        .select({ variables: schema.templates.variables })
        .from(schema.templates)
        .where(eq(schema.templates.id, id));
      return (row!.variables as { dlt?: SmsDltMetadata }).dlt;
    };

    it('rejects { dlt: null } with 422 SMS_DLT_METADATA_INVALID and keeps the stored DLT', async () => {
      const res = await patch(draftSmsTemplateId, { dlt: null });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_METADATA_INVALID);
      expect(await storedDlt(draftSmsTemplateId)).toEqual(templateDlt);
    });

    it('preserves DLT when the field is omitted', async () => {
      const res = await patch(draftSmsTemplateId, {
        name: `sms_renamed_${randomBytes(3).toString('hex')}`,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.dlt).toEqual(templateDlt);
      expect(await storedDlt(draftSmsTemplateId)).toEqual(templateDlt);
    });

    it('rejects malformed DLT at the DTO boundary with 400 VALIDATION_FAILED and keeps the stored DLT', async () => {
      const res = await patch(draftSmsTemplateId, {
        dlt: { entityId: 'not-numeric', templateId: '1207161234567890123' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(await storedDlt(draftSmsTemplateId)).toEqual(templateDlt);
    });

    it('replaces DLT with valid metadata (200)', async () => {
      const next: SmsDltMetadata = {
        entityId: '1201159000000000001',
        templateId: '1207161000000000001',
        headerId: 'ALNDEI',
      };
      const res = await patch(draftSmsTemplateId, { dlt: next });
      expect(res.status).toBe(200);
      expect(res.body.data.dlt).toEqual(next);
      expect(await storedDlt(draftSmsTemplateId)).toEqual(next);
    });

    it('rejects { dlt: null } on create with 422 SMS_DLT_METADATA_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/templates'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelId: channelSmsId,
          name: `sms_null_dlt_${randomBytes(3).toString('hex')}`,
          body: 'Code {{1}}',
          variables: ['1'],
          dlt: null,
        });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.SMS_DLT_METADATA_INVALID);
    });
  });

  describe('4. RCS Payload Validation & Action URL Safety', () => {
    it('successfully queues RCS basic text message (202)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'text',
            text: 'Your delivery is scheduled between 2 PM and 4 PM.',
          },
        });

      expect(res.status).toBe(202);
    });

    it('successfully queues RCS single rich card with safe actions and media (202)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'rich_card',
            card: {
              title: 'Package Arrived',
              description: 'Your package is ready for pickup at locker 4B.',
              media: {
                url: 'https://cdn.example.com/locker.jpg',
                height: 'MEDIUM',
              },
              suggestions: [
                {
                  type: 'action_open_url',
                  text: 'Open Locker',
                  postbackData: 'action=open_locker',
                  url: 'https://lockers.example.com/unlock/4B',
                },
                {
                  type: 'reply',
                  text: 'Need Help',
                  postbackData: 'action=help',
                },
              ],
            },
          },
        });

      expect(res.status).toBe(202);
    });

    it('rejects RCS message with invalid messageType with 422 RCS_PAYLOAD_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'carousel', // Deferred to Phase 8E per ADR-016
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RCS_PAYLOAD_INVALID);
    });

    it('rejects RCS message with empty text with 422 RCS_PAYLOAD_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'text',
            text: '   ',
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RCS_PAYLOAD_INVALID);
    });

    it('rejects RCS rich card containing unsafe action URL (javascript:) with 422 RCS_UNSAFE_ACTION_URL', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'rich_card',
            card: {
              title: 'Exploit Attempt',
              suggestions: [
                {
                  type: 'action_open_url',
                  text: 'Claim Prize',
                  postbackData: 'data',
                  url: 'javascript:alert(document.cookie)',
                },
              ],
            },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RCS_UNSAFE_ACTION_URL);
    });

    it('rejects RCS rich card containing unsafe media URL (data:) with 422 RCS_UNSAFE_ACTION_URL', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'rich_card',
            card: {
              title: 'Data URL Attempt',
              media: {
                url: 'data:text/html,<script>alert(1)</script>',
              },
            },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RCS_UNSAFE_ACTION_URL);
    });

    it('rejects empty RCS rich card lacking title, description, and media with 422 RCS_PAYLOAD_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'rich_card',
            card: {
              suggestions: [{ type: 'reply', text: 'Hi', postbackData: 'hi' }],
            },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RCS_PAYLOAD_INVALID);
    });

    it('rejects RCS text message containing unknown or forbidden field with 422 RCS_PAYLOAD_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'text',
            text: 'Hello RCS',
            forbiddenField: 'injected',
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RCS_PAYLOAD_INVALID);
    });

    it('rejects RCS text message containing card or media fields with 422 RCS_PAYLOAD_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'text',
            text: 'Hello RCS',
            card: { title: 'Not allowed in text message' },
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RCS_PAYLOAD_INVALID);
    });

    it('rejects oversized RCS payload with 422 RCS_PAYLOAD_INVALID', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          payload: {
            messageType: 'text',
            text: 'A'.repeat(70_000),
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RCS_PAYLOAD_INVALID);
    });
  });

  describe('5. Channel Integrity, Tenancy Isolation & Regulatory Safeguards', () => {
    it('enforces channel matching: using an SMS template for an RCS message fails with 422 VALIDATION_FAILED', async () => {
      const [smsTemplate] = await h.admin
        .insert(schema.templates)
        .values({
          id: uuidv7(),
          orgId: tenantA.orgId,
          channelId: channelSmsId,
          name: 'sms_only_template',
          body: 'SMS template body',
          variables: [],
          approvalStatus: 'approved',
        })
        .returning();

      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+12025550198',
          templateId: smsTemplate!.id,
          payload: { messageType: 'text', text: 'Template mismatch test' },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(res.body.error.message).toContain('Template does not match requested channel');
    });

    it('enforces approval status: using a draft template fails with 422 TEMPLATE_NOT_APPROVED', async () => {
      const [draftTemplate] = await h.admin
        .insert(schema.templates)
        .values({
          id: uuidv7(),
          orgId: tenantA.orgId,
          channelId: channelSmsId,
          name: 'sms_draft_template',
          body: 'Draft body',
          variables: [],
          approvalStatus: 'draft',
        })
        .returning();

      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+12025550198',
          templateId: draftTemplate!.id,
          payload: { text: 'Draft send' },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.TEMPLATE_NOT_APPROVED);
    });

    it('enforces org-wide suppression (channelId IS NULL) across SMS and RCS with 422 RECIPIENT_SUPPRESSED', async () => {
      const suppressedAddress = '+12025550999';

      await h.admin.insert(schema.suppressions).values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: null, // Org-wide suppression
        rawAddress: suppressedAddress,
        normalizedAddress: suppressedAddress,
        reason: 'opt_out',
        status: 'active',
      });

      // Assert SMS dispatch to suppressed recipient fails
      const smsRes = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: suppressedAddress,
          payload: { text: 'Should be suppressed' },
        });
      expect(smsRes.status).toBe(422);
      expect(smsRes.body.error.code).toBe(ERROR_CODES.RECIPIENT_SUPPRESSED);

      // Assert RCS dispatch to suppressed recipient fails
      const rcsRes = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: suppressedAddress,
          payload: { messageType: 'text', text: 'Should also be suppressed' },
        });
      expect(rcsRes.status).toBe(422);
      expect(rcsRes.body.error.code).toBe(ERROR_CODES.RECIPIENT_SUPPRESSED);

      // WhatsApp is covered too (DATABASE.md: channel_id NULL = all channels). The
      // suppression check runs before the provider-assignment check, so no
      // WhatsApp assignment is needed to observe it.
      const waRes = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'whatsapp',
          recipient: suppressedAddress,
          payload: { text: 'Should be suppressed on WhatsApp' },
        });
      expect(waRes.status).toBe(422);
      expect(waRes.body.error.code).toBe(ERROR_CODES.RECIPIENT_SUPPRESSED);

      // A formatted RCS recipient normalizes to the stored E.164 form, so spacing
      // cannot step around the suppression (trim-only normalization could).
      const rcsFormatted = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'rcs',
          recipient: '+1 202 555 0999',
          payload: { messageType: 'text', text: 'Formatted recipient' },
        });
      expect(rcsFormatted.status).toBe(422);
      expect(rcsFormatted.body.error.code).toBe(ERROR_CODES.RECIPIENT_SUPPRESSED);
    });

    it('channel-specific suppression for WhatsApp does NOT block SMS to the same recipient', async () => {
      const channelSuppressedAddress = '+12025550888';

      await h.admin.insert(schema.suppressions).values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: channelWhatsappId, // WhatsApp-only suppression
        rawAddress: channelSuppressedAddress,
        normalizedAddress: channelSuppressedAddress,
        reason: 'opt_out',
        status: 'active',
      });

      const smsRes = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: channelSuppressedAddress,
          templateId: approvedSmsTemplateId,
          payload: { variables: { '1': '123456' } },
        });

      expect(smsRes.status).toBe(202);
    });

    it('enforces consent revocation on SMS channel with 422 CONSENT_REVOKED', async () => {
      const revokedContactAddress = '+12025550777';

      // First create contact by sending an SMS message
      const firstRes = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: revokedContactAddress,
          templateId: approvedSmsTemplateId,
          payload: { variables: { '1': '123456' } },
        });
      expect(firstRes.status).toBe(202);

      // Resolve contactId and workspaceId
      const [identity] = await h.admin
        .select({
          contactId: schema.contactIdentities.contactId,
          workspaceId: schema.contactIdentities.workspaceId,
        })
        .from(schema.contactIdentities)
        .where(
          and(
            eq(schema.contactIdentities.orgId, tenantA.orgId),
            eq(schema.contactIdentities.normalizedAddress, revokedContactAddress),
          ),
        )
        .limit(1);

      // Record consent revoke event
      await h.admin.insert(schema.consentEvents).values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        workspaceId: identity!.workspaceId,
        contactId: identity!.contactId,
        channelId: channelSmsId,
        consentType: 'opt_in',
        event: 'revoke',
        occurredAt: new Date(),
        source: 'user_opt_out',
      });

      // Second message to same recipient fails
      const secondRes = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'sms',
          recipient: revokedContactAddress,
          templateId: approvedSmsTemplateId,
          payload: { variables: { '1': '123456' } },
        });

      expect(secondRes.status).toBe(422);
      expect(secondRes.body.error.code).toBe(ERROR_CODES.CONSENT_REVOKED);
    });

    it('enforces cross-tenant isolation: Tenant B cannot use Tenant A template (404 RESOURCE_NOT_FOUND)', async () => {
      const [tenantATemplate] = await h.admin
        .insert(schema.templates)
        .values({
          id: uuidv7(),
          orgId: tenantA.orgId,
          channelId: channelSmsId,
          name: 'isolated_sms_template',
          body: 'Tenant A isolated template',
          variables: [],
          approvalStatus: 'approved',
        })
        .returning();

      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userBToken}`)
        .set('X-Acc-Organization', tenantB.orgId)
        .send({
          channelCode: 'sms',
          recipient: '+12025550198',
          templateId: tenantATemplate!.id,
          payload: { text: 'Cross-tenant probe' },
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('enforces idempotency on SMS dispatch: replay returns identical 202 without duplicate queue row', async () => {
      const idempotencyKey = randomUUID();
      const body = {
        channelCode: 'sms',
        recipient: '+12025550198',
        templateId: approvedSmsTemplateId,
        payload: { variables: { '1': '123456' } },
      };

      const res1 = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .set('Idempotency-Key', idempotencyKey)
        .send(body);

      expect(res1.status).toBe(202);
      const messageId = res1.body.data.id;

      const res2 = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .set('Idempotency-Key', idempotencyKey)
        .send(body);

      expect(res2.status).toBe(202);
      expect(res2.body.data.id).toBe(messageId);

      // Verify only 1 row in message_dispatch_queue
      const queueRows = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRows.length).toBe(1);
    });
  });
});
