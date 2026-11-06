import { CHANNEL_CODES, DISPATCHABLE_CHANNEL_CODES } from '@acc/contracts';

import { mapMessageForSubmission, resolveChannelCode } from './submission-mapping';

const DLT = {
  entityId: '1201159123456789012',
  templateId: '1207161234567890123',
  headerId: 'ALENDE',
};

describe('resolveChannelCode', () => {
  it('accepts every published channel code and nothing else', () => {
    for (const code of CHANNEL_CODES) expect(resolveChannelCode(code)).toBe(code);
    for (const code of ['SMS', ' sms', 'fax', '', null, undefined]) {
      expect(resolveChannelCode(code as string | null | undefined)).toBeNull();
    }
  });
});

describe('mapMessageForSubmission — non-SMS channels keep the Phase 3 mapping', () => {
  it('whatsapp: payload.text becomes the content, with no SMS metadata', () => {
    expect(mapMessageForSubmission('whatsapp', { type: 'text', text: 'Hello' })).toEqual({
      ok: true,
      content: { text: 'Hello' },
    });
  });

  it('whatsapp: a payload without text is sent as its JSON, exactly as before', () => {
    const payload = { type: 'template', name: 'welcome' };
    expect(mapMessageForSubmission('whatsapp', payload)).toEqual({
      ok: true,
      content: { text: JSON.stringify(payload) },
    });
  });

  it('whatsapp ignores a dlt field: only SMS carries SMS metadata', () => {
    const mapped = mapMessageForSubmission('whatsapp', { text: 'Hi', dlt: DLT });
    expect(mapped).toEqual({ ok: true, content: { text: 'Hi' } });
  });
});

describe('mapMessageForSubmission — channels with no send path fail closed (Phase 4.3)', () => {
  it.each(['email', 'voice'] as const)('%s: refused, whatever the payload holds', (channel) => {
    for (const payload of [{ text: 'Hello' }, { subject: 'Hi', body: 'x' }, {}, null]) {
      expect(mapMessageForSubmission(channel, payload)).toEqual({
        ok: false,
        reason: `CHANNEL_UNSUPPORTED: ${channel}`,
      });
    }
  });

  it('only whatsapp, rcs and sms are dispatchable; every other catalogued channel is refused', () => {
    expect([...DISPATCHABLE_CHANNEL_CODES].sort()).toEqual(['rcs', 'sms', 'whatsapp']);
    const refused = CHANNEL_CODES.filter((code) => {
      const mapped = mapMessageForSubmission(code, {});
      return !mapped.ok && mapped.reason.startsWith('CHANNEL_UNSUPPORTED');
    });
    expect(refused).toEqual(['email', 'voice']);
  });
});

describe('mapMessageForSubmission — RCS (Phase 4.2)', () => {
  const reply = { type: 'reply', text: 'Yes', postbackData: 'yes' } as const;
  const openUrl = {
    type: 'action_open_url',
    text: 'Open',
    postbackData: 'open',
    url: 'https://example.com/offer',
  } as const;

  it('text: the full payload as rcs, its text as content', () => {
    const payload = { messageType: 'text', text: 'Hello RCS', suggestions: [reply] };
    expect(mapMessageForSubmission('rcs', payload)).toEqual({
      ok: true,
      content: { text: 'Hello RCS' },
      rcs: payload,
    });
  });

  it('media: the full payload as rcs, empty text content', () => {
    const payload = {
      messageType: 'media',
      media: { url: 'https://example.com/a.png', mimeType: 'image/png', height: 'MEDIUM' },
    };
    expect(mapMessageForSubmission('rcs', payload)).toEqual({
      ok: true,
      content: { text: '' },
      rcs: payload,
    });
  });

  it('rich_card: the full payload as rcs, title and description as content', () => {
    const payload = {
      messageType: 'rich_card',
      card: {
        title: 'Offer',
        description: '20% off today',
        media: { url: 'https://example.com/card.jpg' },
        suggestions: [openUrl],
      },
      suggestions: [reply],
    };
    expect(mapMessageForSubmission('rcs', payload)).toEqual({
      ok: true,
      content: { text: 'Offer\n20% off today' },
      rcs: payload,
    });
    const titleOnly = { messageType: 'rich_card', card: { title: 'Only a title' } };
    const mapped = mapMessageForSubmission('rcs', titleOnly);
    expect(mapped.ok && mapped.content.text).toBe('Only a title');
  });

  it('submits a copy: changing the stored object afterwards cannot change the submission', () => {
    const payload = { messageType: 'text', text: 'Original' };
    const mapped = mapMessageForSubmission('rcs', payload);
    payload.text = 'Tampered';
    expect(mapped.ok && mapped.rcs).toEqual({ messageType: 'text', text: 'Original' });
  });

  it.each([
    ['no messageType', { text: 'Hi' }],
    ['an unknown messageType', { messageType: 'carousel', cards: [] }],
    ['an empty text', { messageType: 'text', text: '  ' }],
    ['a field not allowed for the type', { messageType: 'text', text: 'Hi', media: {} }],
    ['media without media', { messageType: 'media' }],
    [
      'an unsafe action URL',
      {
        messageType: 'text',
        text: 'Hi',
        suggestions: [{ ...openUrl, url: 'javascript:alert(1)' }],
      },
    ],
    ['a non-object payload', 'text'],
  ])('refuses a stored RCS payload with %s', (_label, payload) => {
    const mapped = mapMessageForSubmission('rcs', payload);
    expect(mapped.ok).toBe(false);
    expect(!mapped.ok && mapped.reason).toMatch(/^RCS_PAYLOAD_INVALID: /);
  });
});

describe('mapMessageForSubmission — SMS', () => {
  it('maps the rendered text and the bound DLT metadata', () => {
    expect(
      mapMessageForSubmission('sms', {
        text: 'Your verification code is 654321.',
        dlt: DLT,
        variables: { '1': '654321' },
      }),
    ).toEqual({
      ok: true,
      content: { text: 'Your verification code is 654321.' },
      sms: { dlt: DLT, encoding: 'GSM-7', segments: 1 },
    });
  });

  it('keeps an absent headerId absent and carries a stored maxSegments', () => {
    const noHeader = { entityId: DLT.entityId, templateId: DLT.templateId };
    expect(
      mapMessageForSubmission('sms', { text: 'Code 1', dlt: noHeader, maxSegments: 2 }),
    ).toEqual({
      ok: true,
      content: { text: 'Code 1' },
      sms: { dlt: noHeader, encoding: 'GSM-7', segments: 1, maxSegments: 2 },
    });
  });

  it('copies only the three DLT fields, never anything else from the stored object', () => {
    const mapped = mapMessageForSubmission('sms', { text: 'x', dlt: { ...DLT } });
    expect(mapped.ok && mapped.sms?.dlt).toEqual(DLT);
    expect(mapped.ok && Object.keys(mapped.sms!.dlt).sort()).toEqual([
      'entityId',
      'headerId',
      'templateId',
    ]);
  });

  it.each([
    ['no text', { dlt: DLT }],
    ['blank text', { text: '   ', dlt: DLT }],
    ['non-string text', { text: 42, dlt: DLT }],
    ['no dlt', { text: 'Code 1' }],
    ['null dlt', { text: 'Code 1', dlt: null }],
    ['malformed entityId', { text: 'Code 1', dlt: { ...DLT, entityId: 'abc' } }],
    ['unknown dlt field', { text: 'Code 1', dlt: { ...DLT, sender: 'X' } }],
    ['zero maxSegments', { text: 'Code 1', dlt: DLT, maxSegments: 0 }],
    ['fractional maxSegments', { text: 'Code 1', dlt: DLT, maxSegments: 1.5 }],
    ['string maxSegments', { text: 'Code 1', dlt: DLT, maxSegments: '2' }],
  ])('refuses a stored SMS payload with %s', (_label, payload) => {
    const mapped = mapMessageForSubmission('sms', payload);
    expect(mapped.ok).toBe(false);
    expect(!mapped.ok && mapped.reason).toMatch(/^SMS_PAYLOAD_INVALID: /);
  });

  it.each([null, 'text', ['a'], 7])('refuses a non-object SMS payload (%p)', (payload) => {
    expect(mapMessageForSubmission('sms', payload).ok).toBe(false);
  });
});

describe('mapMessageForSubmission — SMS encoding, segments and the ceiling (Gate F.2 scope F.2.2)', () => {
  const sms = (text: string, extra: Record<string, unknown> = {}) =>
    mapMessageForSubmission('sms', { text, dlt: DLT, ...extra });

  it('carries GSM-7 and the segment count of the rendered text', () => {
    const single = sms('a'.repeat(160));
    expect(single.ok && single.sms).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    const concatenated = sms('a'.repeat(161));
    expect(concatenated.ok && concatenated.sms).toMatchObject({ encoding: 'GSM-7', segments: 2 });
  });

  it('carries UCS-2 when the text holds a character outside GSM-7', () => {
    const single = sms('नमस्ते');
    expect(single.ok && single.sms).toMatchObject({ encoding: 'UCS-2', segments: 1 });
    const concatenated = sms('ক'.repeat(71));
    expect(concatenated.ok && concatenated.sms).toMatchObject({ encoding: 'UCS-2', segments: 2 });
  });

  it('counts a GSM-7 extended character as two units', () => {
    const mapped = sms('€'.repeat(80));
    expect(mapped.ok && mapped.sms).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    const over = sms('€'.repeat(81));
    expect(over.ok && over.sms).toMatchObject({ encoding: 'GSM-7', segments: 2 });
  });

  it('accepts a text at the server ceiling of 10 segments', () => {
    const mapped = sms('a'.repeat(153 * 10));
    expect(mapped.ok && mapped.sms).toMatchObject({ encoding: 'GSM-7', segments: 10 });
  });

  it('refuses a stored text above the server ceiling: tampered or written outside the send path', () => {
    const mapped = sms('a'.repeat(153 * 10 + 1));
    expect(mapped).toEqual({
      ok: false,
      reason: 'SMS_PAYLOAD_INVALID: stored SMS text needs 11 segments, above the ceiling of 10',
    });
  });

  it('refuses a stored text above a lower stored maxSegments', () => {
    expect(sms('a'.repeat(306), { maxSegments: 2 }).ok).toBe(true);
    const mapped = sms('a'.repeat(307), { maxSegments: 2 });
    expect(mapped).toEqual({
      ok: false,
      reason: 'SMS_PAYLOAD_INVALID: stored SMS text needs 3 segments, above the ceiling of 2',
    });
  });

  it('a stored maxSegments above 10 never raises the server ceiling', () => {
    const mapped = sms('a'.repeat(153 * 10 + 1), { maxSegments: 50 });
    expect(!mapped.ok && mapped.reason).toMatch(/above the ceiling of 10$/);
  });
});
