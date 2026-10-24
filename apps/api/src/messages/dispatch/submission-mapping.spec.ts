import { CHANNEL_CODES } from '@acc/contracts';

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
      sms: { dlt: DLT },
    });
  });

  it('keeps an absent headerId absent and carries a stored maxSegments', () => {
    const noHeader = { entityId: DLT.entityId, templateId: DLT.templateId };
    expect(
      mapMessageForSubmission('sms', { text: 'Code 1', dlt: noHeader, maxSegments: 2 }),
    ).toEqual({ ok: true, content: { text: 'Code 1' }, sms: { dlt: noHeader, maxSegments: 2 } });
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
