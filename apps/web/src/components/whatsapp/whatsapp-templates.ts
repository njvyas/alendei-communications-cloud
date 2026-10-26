import type { ChannelView } from '@/lib/api-client';
import type { TemplateResponse } from '@acc/contracts';

/** The WhatsApp channel's id in the channel catalogue, or '' when it is not there. */
export function findWhatsAppChannelId(
  channels: readonly Pick<ChannelView, 'id' | 'code'>[],
): string {
  return channels.find((c) => c.code === 'whatsapp')?.id ?? '';
}

/**
 * The templates the WhatsApp send form may offer: approved and on the WhatsApp
 * channel (QAF-018, #28). The list request already asks the API for exactly
 * these; this keeps any other template out of the form even if a response
 * contains one. With no known WhatsApp channel nothing is offered.
 */
export function approvedWhatsAppTemplates(
  templates: readonly TemplateResponse[],
  whatsappChannelId: string,
): TemplateResponse[] {
  if (!whatsappChannelId) return [];
  return templates.filter(
    (t) => t.approvalStatus === 'approved' && t.channelId === whatsappChannelId,
  );
}
