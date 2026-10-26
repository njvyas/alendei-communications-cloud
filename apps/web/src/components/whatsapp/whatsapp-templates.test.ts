import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TemplateResponse } from '@acc/contracts';

import { approvedWhatsAppTemplates, findWhatsAppChannelId } from './whatsapp-templates';

// QAF-018 (#28): the WhatsApp send form may offer only approved WhatsApp templates.
describe('QAF-018: WhatsApp template filtering', () => {
  const ORG = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const WHATSAPP = '01955b0a-7b3b-7411-9a4f-9e67d4f9c001';
  const SMS = '01955b0a-7b3b-7411-9a4f-9e67d4f9c002';
  const RCS = '01955b0a-7b3b-7411-9a4f-9e67d4f9c003';
  const OTHER = '01955b0a-7b3b-7411-9a4f-9e67d4f9c0ff';

  const template = (
    id: string,
    channelId: string,
    approvalStatus: TemplateResponse['approvalStatus'],
  ): TemplateResponse => ({
    id,
    orgId: ORG,
    channelId,
    name: id,
    body: 'Hello {{1}}',
    variables: ['1'],
    approvalStatus,
    createdAt: '2026-10-26T09:00:00.000Z',
    updatedAt: '2026-10-26T09:00:00.000Z',
  });

  const mixed = [
    template('wa-approved-1', WHATSAPP, 'approved'),
    template('sms-approved', SMS, 'approved'),
    template('rcs-approved', RCS, 'approved'),
    template('wa-draft', WHATSAPP, 'draft'),
    template('wa-pending', WHATSAPP, 'pending'),
    template('wa-rejected', WHATSAPP, 'rejected'),
    template('other-channel-approved', OTHER, 'approved'),
    template('wa-approved-2', WHATSAPP, 'approved'),
  ];

  it('1. finds the WhatsApp channel by code', () => {
    const channels = [
      { id: SMS, code: 'sms' as const },
      { id: WHATSAPP, code: 'whatsapp' as const },
      { id: RCS, code: 'rcs' as const },
    ];
    assert.equal(findWhatsAppChannelId(channels), WHATSAPP);
  });

  it('2. reports no channel when the catalogue has no WhatsApp entry or is empty', () => {
    assert.equal(findWhatsAppChannelId([{ id: SMS, code: 'sms' as const }]), '');
    assert.equal(findWhatsAppChannelId([]), '');
  });

  it('3. keeps only approved WhatsApp templates, in order', () => {
    assert.deepEqual(
      approvedWhatsAppTemplates(mixed, WHATSAPP).map((t) => t.id),
      ['wa-approved-1', 'wa-approved-2'],
    );
  });

  it('4. excludes SMS, RCS, other-channel, draft, pending and rejected templates', () => {
    const ids = approvedWhatsAppTemplates(mixed, WHATSAPP).map((t) => t.id);
    for (const excluded of [
      'sms-approved',
      'rcs-approved',
      'other-channel-approved',
      'wa-draft',
      'wa-pending',
      'wa-rejected',
    ]) {
      assert.ok(!ids.includes(excluded), `${excluded} must not be offered`);
    }
  });

  it('5. offers nothing while the WhatsApp channel is unknown', () => {
    assert.deepEqual(approvedWhatsAppTemplates(mixed, ''), []);
  });
});
