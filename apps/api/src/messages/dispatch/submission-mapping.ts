import {
  CHANNEL_CODES,
  isDispatchableChannel,
  validateDltMetadata,
  validateRcsPayload,
  type ChannelCode,
  type ProviderSmsSubmission,
  type RcsBasicPayload,
  type SmsDltMetadata,
} from '@acc/contracts';

/**
 * What the dispatcher hands the provider for one stored message (Phase 4.2).
 *
 * The send path (`MessagesService.send`) is the only writer of `messages.payload`
 * and has already validated it; for SMS it persisted only server-derived content:
 * the rendered approved template as `text` and the template's own DLT metadata
 * as `dlt`. This mapping re-checks that shape rather than trusting it, because a
 * row written before Phase 4.1 or outside the API must not reach a provider
 * without its regulatory metadata.
 */
export type SubmissionMapping =
  | {
      readonly ok: true;
      readonly content: { readonly text: string };
      readonly sms?: ProviderSmsSubmission;
      readonly rcs?: RcsBasicPayload;
    }
  | { readonly ok: false; readonly reason: string };

/** The channel code of a `channels` row, or `null` when it is not one ACC dispatches. */
export function resolveChannelCode(code: string | null | undefined): ChannelCode | null {
  return (CHANNEL_CODES as readonly string[]).includes(code ?? '') ? (code as ChannelCode) : null;
}

export function mapMessageForSubmission(channel: ChannelCode, payload: unknown): SubmissionMapping {
  const payloadObj =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  // Fail closed (Phase 4.3): a message on a channel with no authorized send path
  // — one stored before the send path refused it, or written outside the API —
  // never reaches an adapter.
  if (!isDispatchableChannel(channel)) {
    return { ok: false, reason: `CHANNEL_UNSUPPORTED: ${channel}` };
  }

  if (channel === 'rcs') return mapRcs(payload);

  if (channel === 'whatsapp') {
    // Unchanged from Phase 3: `text` when present, otherwise the payload itself.
    const text = 'text' in payloadObj ? String(payloadObj.text) : JSON.stringify(payload);
    return { ok: true, content: { text } };
  }

  const invalid = (detail: string): SubmissionMapping => ({
    ok: false,
    reason: `SMS_PAYLOAD_INVALID: ${detail}`,
  });

  const text = payloadObj.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return invalid('stored SMS payload has no rendered text');
  }

  const dltCheck = validateDltMetadata(payloadObj.dlt);
  if (!dltCheck.valid) {
    return invalid(`stored SMS payload has no valid DLT metadata (${dltCheck.errors.join('; ')})`);
  }
  const stored = payloadObj.dlt as SmsDltMetadata;
  const dlt: SmsDltMetadata = {
    entityId: stored.entityId,
    templateId: stored.templateId,
    ...(stored.headerId !== undefined ? { headerId: stored.headerId } : {}),
  };

  const maxSegments = payloadObj.maxSegments;
  if (
    maxSegments !== undefined &&
    (typeof maxSegments !== 'number' || !Number.isInteger(maxSegments) || maxSegments <= 0)
  ) {
    return invalid('stored SMS payload maxSegments is not a positive integer');
  }

  return {
    ok: true,
    content: { text },
    sms: { dlt, ...(maxSegments !== undefined ? { maxSegments } : {}) },
  };
}

/**
 * RCS (Phase 4.2): the stored payload, re-validated under ADR-016 D-4/D-5, goes
 * to the provider whole; `content.text` is its plain-text rendering — the text
 * of a text message, a rich card's title and description, nothing for media.
 */
function mapRcs(payload: unknown): SubmissionMapping {
  const check = validateRcsPayload(payload);
  if (!check.valid) {
    return {
      ok: false,
      reason: `RCS_PAYLOAD_INVALID: stored RCS payload is not valid (${check.errors.join('; ')})`,
    };
  }
  // A copy: what is submitted cannot be changed through the row it came from.
  const rcs = structuredClone(payload) as RcsBasicPayload;
  let text = '';
  if (rcs.messageType === 'text') {
    text = rcs.text ?? '';
  } else if (rcs.messageType === 'rich_card') {
    text = [rcs.card?.title, rcs.card?.description]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n');
  }
  return { ok: true, content: { text }, rcs };
}
