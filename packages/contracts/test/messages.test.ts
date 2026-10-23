import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskRecipientAddress,
  sanitizeRecipientContent,
  sanitizeRecipientData,
} from '../src/messages';

describe('Contracts — Recipient Masking & Context-Aware Sanitization Tests', () => {
  const RECIPIENT_PHONE = '+12025550199';
  const MASKED_PHONE = '+1 •••• 0199';
  const RECIPIENT_EMAIL = 'customer@acme-corp.com';
  const MASKED_EMAIL = 'c••••r@acme-corp.com';

  // 1. maskRecipientAddress tests
  describe('maskRecipientAddress', () => {
    it('masks canonical E.164 phone numbers with CC context', () => {
      assert.equal(maskRecipientAddress('+12025550199'), '+1 •••• 0199');
      assert.equal(maskRecipientAddress('+447911123456'), '+44 •••• 3456');
      assert.equal(maskRecipientAddress('+919876543210'), '+91 •••• 3210');
      assert.equal(maskRecipientAddress('+353871234567'), '+353 •••• 4567');
    });

    it('masks standard and short email addresses', () => {
      assert.equal(maskRecipientAddress('user@example.com'), 'u••••r@example.com');
      assert.equal(maskRecipientAddress('ab@domain.com'), 'a•••@domain.com');
      assert.equal(maskRecipientAddress('customer@acme-corp.com'), 'c••••r@acme-corp.com');
    });

    it('idempotently preserves already-masked values', () => {
      assert.equal(maskRecipientAddress('+1 •••• 0199'), '+1 •••• 0199');
      assert.equal(maskRecipientAddress('u••••r@example.com'), 'u••••r@example.com');
      assert.equal(maskRecipientAddress('••••••'), '••••••');
    });

    it('fails safely without returning raw values for malformed or short addresses', () => {
      assert.equal(maskRecipientAddress(''), '');
      assert.equal(maskRecipientAddress(null), '');
      assert.equal(maskRecipientAddress(undefined), '');
      assert.equal(maskRecipientAddress('+123'), '••••••');
      assert.equal(maskRecipientAddress('bad-email@'), '••••••');
      assert.equal(maskRecipientAddress('@no-local.com'), '••••••');
    });
  });

  // 2. sanitizeRecipientContent & sanitizeRecipientData tests
  describe('sanitizeRecipientContent & sanitizeRecipientData (Context-Aware Sanitization)', () => {
    it('1. sanitizes recipient when present in nested payload', () => {
      const payload = {
        orderId: 'ORD-9988',
        recipient: RECIPIENT_PHONE,
        metadata: {
          destination: RECIPIENT_PHONE,
          tags: ['important', RECIPIENT_PHONE],
        },
      };

      const sanitized = sanitizeRecipientData(payload, RECIPIENT_PHONE);

      assert.deepEqual(sanitized, {
        orderId: 'ORD-9988',
        recipient: MASKED_PHONE,
        metadata: {
          destination: MASKED_PHONE,
          tags: ['important', MASKED_PHONE],
        },
      });
    });

    it('2. sanitizes recipient in free-text failure reasons', () => {
      const reason1 = 'Failed to deliver to +12025550199: upstream provider timeout';
      const reason2 = 'Provider response: destination=+12025550199 error=UNREACHABLE';

      assert.equal(
        sanitizeRecipientContent(reason1, RECIPIENT_PHONE),
        'Failed to deliver to +1 •••• 0199: upstream provider timeout',
      );
      assert.equal(
        sanitizeRecipientContent(reason2, RECIPIENT_PHONE),
        'Provider response: destination=+1 •••• 0199 error=UNREACHABLE',
      );
    });

    it('3. sanitizes no-plus equivalent digits without corrupting longer numbers', () => {
      // Recipient is +12025550199, no-plus equivalent is 12025550199
      const text = 'Upstream rejected 12025550199 due to throttling';
      assert.equal(
        sanitizeRecipientContent(text, RECIPIENT_PHONE),
        'Upstream rejected +1 •••• 0199 due to throttling',
      );

      // Verify it does NOT match when digits are part of a longer unrelated number
      const longerNumber = 'Reference code REF-9912025550199000-XYZ';
      assert.equal(
        sanitizeRecipientContent(longerNumber, RECIPIENT_PHONE),
        'Reference code REF-9912025550199000-XYZ',
      );
    });

    it('4. strictly preserves unrelated phone and business numbers', () => {
      const payload = {
        supportPhone: '+18005551234',
        emergencyHotline: '18005551234',
        providerSupport: '+44800111222',
        intendedRecipient: RECIPIENT_PHONE,
      };

      const sanitized = sanitizeRecipientData(payload, RECIPIENT_PHONE);

      // Support numbers must NOT be redacted or masked!
      assert.equal(sanitized.supportPhone, '+18005551234');
      assert.equal(sanitized.emergencyHotline, '18005551234');
      assert.equal(sanitized.providerSupport, '+44800111222');
      assert.equal(sanitized.intendedRecipient, MASKED_PHONE);
    });

    it('5. strictly preserves URLs and replaces only recipient inside query/path', () => {
      const payload = {
        webhookUrl: 'https://company.internal/webhooks/sms-delivery',
        trackingUrl: 'https://orders.acme.com/track?ref=ORD-1234&channel=whatsapp',
        userLookupUrl: 'https://api.crm.internal/v1/contacts/+12025550199/profile',
        encodedUrl: 'https://api.crm.internal/v1/search?q=%2B12025550199',
      };

      const sanitized = sanitizeRecipientData(payload, RECIPIENT_PHONE);

      // Plain URLs without recipient must remain completely untouched
      assert.equal(sanitized.webhookUrl, 'https://company.internal/webhooks/sms-delivery');
      assert.equal(
        sanitized.trackingUrl,
        'https://orders.acme.com/track?ref=ORD-1234&channel=whatsapp',
      );

      // URLs containing recipient must preserve structure and only mask the recipient digits
      assert.equal(
        sanitized.userLookupUrl,
        'https://api.crm.internal/v1/contacts/+1 •••• 0199/profile',
      );
      assert.equal(sanitized.encodedUrl, 'https://api.crm.internal/v1/search?q=+1 •••• 0199');
    });

    it('6. strictly preserves queue names and routing keys', () => {
      const payload = {
        queue: 'queue://sms-outbound-priority',
        dlq: 'amqp://broker.internal/queues/dlq.messages.v1',
        routingKey: 'comms.dispatch.whatsapp.high_priority',
      };

      const sanitized = sanitizeRecipientData(payload, RECIPIENT_PHONE);

      assert.equal(sanitized.queue, 'queue://sms-outbound-priority');
      assert.equal(sanitized.dlq, 'amqp://broker.internal/queues/dlq.messages.v1');
      assert.equal(sanitized.routingKey, 'comms.dispatch.whatsapp.high_priority');
    });

    it('7. sanitizes email recipients while preserving unrelated emails and content', () => {
      const payload = {
        to: RECIPIENT_EMAIL,
        supportEmail: 'support@acme-corp.com',
        auditCc: 'security-audit@acme-corp.com',
        text: 'Notification sent to customer@acme-corp.com regarding order',
      };

      const sanitized = sanitizeRecipientData(payload, RECIPIENT_EMAIL);

      assert.equal(sanitized.to, MASKED_EMAIL);
      assert.equal(sanitized.supportEmail, 'support@acme-corp.com');
      assert.equal(sanitized.auditCc, 'security-audit@acme-corp.com');
      assert.equal(sanitized.text, 'Notification sent to c••••r@acme-corp.com regarding order');
    });

    it('8. idempotently handles already-masked values', () => {
      const text = 'Recipient is already masked: +1 •••• 0199';
      assert.equal(sanitizeRecipientContent(text, RECIPIENT_PHONE), text);
      assert.equal(sanitizeRecipientContent(text, MASKED_PHONE), text);
    });

    it('9. verifies complete serialized response contains zero raw recipient leaks while keeping payload intact', () => {
      const mockResponse = {
        id: 'msg-001',
        orgId: 'org-001',
        recipientAddress: maskRecipientAddress(RECIPIENT_PHONE),
        failureReason: sanitizeRecipientContent(
          'Failed dispatch to +12025550199 after 1 attempt',
          RECIPIENT_PHONE,
        ),
        payload: sanitizeRecipientData(
          {
            phone: RECIPIENT_PHONE,
            noPlus: '12025550199',
            businessLine: '+18005551234',
            queue: 'queue://high-priority',
            url: 'https://company.com/webhook',
          },
          RECIPIENT_PHONE,
        ),
      };

      const serialized = JSON.stringify(mockResponse);

      // Assert ZERO occurrence of raw recipient in any form
      assert.ok(
        !serialized.includes('+12025550199'),
        'Serialized response must NOT contain +12025550199',
      );
      assert.ok(
        !serialized.includes('12025550199'),
        'Serialized response must NOT contain 12025550199',
      );

      // Assert presence of masked recipient
      assert.ok(
        serialized.includes('+1 •••• 0199'),
        'Serialized response must contain masked recipient',
      );

      // Assert complete preservation of unrelated fields
      assert.ok(serialized.includes('+18005551234'), 'Business line must remain intact');
      assert.ok(serialized.includes('queue://high-priority'), 'Queue name must remain intact');
      assert.ok(serialized.includes('https://company.com/webhook'), 'URL must remain intact');
    });
  });
});
