/**
 * Failure reason formatting and actionable guidance (U5).
 * Translates technical orchestrator rejection codes and provider error strings
 * into clear, user-friendly titles, explanations, and actionable next steps.
 */

export type FailureSeverity = 'error' | 'warning' | 'info';

export interface FailureReasonDetails {
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly severity: FailureSeverity;
  readonly rawReason: string;
}

export interface EmptyAttemptsDetails {
  readonly message: string;
  readonly action?: string;
}

const KNOWN_REASONS: Record<
  string,
  { title: string; description: string; action: string; severity: FailureSeverity }
> = {
  NO_ELIGIBLE_PROVIDER: {
    title: 'No Available Provider',
    description:
      'Every provider assigned to this channel was unavailable because it was disabled, draining, or its circuit breaker was open after repeated delivery errors.',
    action:
      'Check provider assignments in Organization Settings, verify provider health, or retry after the circuit cooldown period.',
    severity: 'warning',
  },
  RECIPIENT_SUPPRESSED: {
    title: 'Recipient Suppressed',
    description:
      'The recipient address is on the organization suppression list for this channel (e.g. unsubscribed or blocked).',
    action:
      'Review the Suppressions list in the console to inspect or lift this suppression if appropriate.',
    severity: 'warning',
  },
  CONSENT_REVOKED: {
    title: 'Consent Revoked',
    description:
      'Recipient consent for this channel has expired or was revoked. Outbound messages require active consent.',
    action: 'Obtain and record fresh recipient consent before sending messages to this contact.',
    severity: 'warning',
  },
  CHANNEL_NOT_SUPPORTED: {
    title: 'Channel Not Supported',
    description: 'The requested communication channel does not support outbound message dispatch.',
    action: 'Select a supported messaging channel such as WhatsApp, SMS, or RCS.',
    severity: 'error',
  },
  TEMPLATE_NOT_APPROVED: {
    title: 'Template Not Approved',
    description:
      'The selected template has not been approved for messaging. Outbound messages require an approved template.',
    action: 'Submit the template for provider approval or choose an approved template.',
    severity: 'warning',
  },
  TEMPLATE_NOT_FOUND: {
    title: 'Template Not Found',
    description: 'The requested message template could not be found in the current organization.',
    action: 'Verify that the template exists and belongs to the selected organization.',
    severity: 'error',
  },
  TEMPLATE_CHANNEL_MISMATCH: {
    title: 'Template Channel Mismatch',
    description: 'The selected template was configured for a different communication channel.',
    action: 'Choose a template designed specifically for this channel.',
    severity: 'error',
  },
  SMS_DLT_METADATA_REQUIRED: {
    title: 'DLT Metadata Required',
    description:
      'SMS regulatory requirements require approved Distributed Ledger Technology (DLT) Entity ID and Template ID registration.',
    action: 'Ensure the SMS template contains valid, registered DLT metadata.',
    severity: 'error',
  },
  SMS_PAYLOAD_INVALID: {
    title: 'SMS Payload Invalid',
    description: 'The message payload does not conform to the approved SMS template structure.',
    action: 'Check that all required template variables are provided without invalid extra fields.',
    severity: 'error',
  },
  SMS_TEMPLATE_VARIABLE_INVALID: {
    title: 'Template Variable Invalid',
    description: 'One or more required template variables are missing or incorrectly formatted.',
    action: 'Provide all required numbered template variables in the message payload.',
    severity: 'error',
  },
  RCS_UNSAFE_ACTION_URL: {
    title: 'Unsafe Action URL',
    description:
      'An interactive RCS action button specifies an insecure or unapproved URL protocol.',
    action: 'Use a valid HTTPS URL for all interactive RCS action buttons.',
    severity: 'error',
  },
  RCS_PAYLOAD_INVALID: {
    title: 'RCS Payload Invalid',
    description: 'The RCS card or carousel structure is invalid according to RCS formatting rules.',
    action: 'Verify card components, media formats, and suggestions before resending.',
    severity: 'error',
  },
  ALL_PROVIDERS_FAILED: {
    title: 'All Providers Failed',
    description:
      'Every attempted provider in the fallback chain encountered an error during submission.',
    action:
      'Inspect individual attempt error details below or verify provider adapter connectivity.',
    severity: 'error',
  },
  ORGANIZATION_SUSPENDED: {
    title: 'Organization Suspended',
    description: 'The organization is currently suspended. Outbound message dispatch is blocked.',
    action: 'Contact a platform administrator to restore active organization status.',
    severity: 'error',
  },
  ORGANIZATION_CLOSED: {
    title: 'Organization Closed',
    description:
      'The organization has been permanently closed. Outbound message dispatch is disabled.',
    action: 'Dispatch messages under an active organization context.',
    severity: 'error',
  },
};

/**
 * Parses and formats any technical orchestrator failure reason into user-friendly guidance.
 */
export function formatFailureReason(
  reason: string | null | undefined,
): FailureReasonDetails | null {
  if (!reason || !reason.trim()) {
    return null;
  }

  const raw = reason.trim();

  // 1. Direct match in dictionary
  if (KNOWN_REASONS[raw]) {
    const entry = KNOWN_REASONS[raw]!;
    return {
      code: raw,
      title: entry.title,
      description: entry.description,
      action: entry.action,
      severity: entry.severity,
      rawReason: raw,
    };
  }

  // 2. Prefixed or exact provider errors (e.g. "PROVIDER_ERROR: Simulated provider server error" or "PROVIDER_ERROR")
  if (raw === 'PROVIDER_ERROR' || raw.startsWith('PROVIDER_ERROR:')) {
    const detail = raw.startsWith('PROVIDER_ERROR:')
      ? raw.slice('PROVIDER_ERROR:'.length).trim()
      : '';
    return {
      code: 'PROVIDER_ERROR',
      title: 'Provider Delivery Error',
      description: detail
        ? `The upstream provider rejected or failed to process the message: ${detail}`
        : 'The upstream provider reported an execution or transmission error.',
      action:
        'Verify provider status and credentials in Provider Management, or retry after external service recovery.',
      severity: 'error',
      rawReason: raw,
    };
  }

  // 3. Provider timeout
  if (raw.startsWith('PROVIDER_TIMEOUT') || raw.toLowerCase().includes('timed out')) {
    return {
      code: 'PROVIDER_TIMEOUT',
      title: 'Provider Timeout',
      description: 'The provider failed to respond within the allotted timeout window.',
      action: 'Check external service latency and retry if the provider is recovering.',
      severity: 'error',
      rawReason: raw,
    };
  }

  // 4. Channel unsupported prefix (e.g. "CHANNEL_UNSUPPORTED: voice")
  if (raw.startsWith('CHANNEL_UNSUPPORTED:')) {
    const channel = raw.slice('CHANNEL_UNSUPPORTED:'.length).trim();
    return {
      code: 'CHANNEL_NOT_SUPPORTED',
      title: `Channel '${channel}' Not Supported`,
      description: `Sending messages on the '${channel}' channel is currently unsupported.`,
      action: 'Select a supported messaging channel such as WhatsApp, SMS, or RCS.',
      severity: 'error',
      rawReason: raw,
    };
  }

  // 5. Abandoned / expired lease recovery
  if (
    raw.toLowerCase().includes('lease expired') ||
    raw.toLowerCase().includes('outcome_unknown')
  ) {
    return {
      code: 'OUTCOME_UNKNOWN',
      title: 'Outcome Unknown (Lease Expired)',
      description:
        'The dispatch worker lease expired or was interrupted during submission. External delivery outcome could not be confirmed.',
      action:
        'Confirm delivery status with recipient or provider before resubmitting to prevent duplicate delivery.',
      severity: 'warning',
      rawReason: raw,
    };
  }

  // 6. Generic / Fallback
  return {
    code: raw.split(/[:\s]/)[0] || 'DISPATCH_FAILED',
    title: 'Message Dispatch Failed',
    description: raw,
    action: 'Inspect the attempt records below or check channel and provider configuration.',
    severity: 'error',
    rawReason: raw,
  };
}

/**
 * Formats guidance for the attempts table when zero attempts were recorded.
 * Never describes a terminal (failed/outcome_unknown) message as "queued" (QAF-026).
 */
export function emptyAttemptsGuidance(
  status: string,
  failureReason: string | null | undefined,
): EmptyAttemptsDetails {
  switch (status) {
    case 'queued':
    case 'routing':
      return {
        message: 'No dispatch attempts recorded yet. The message is queued for dispatch.',
      };
    case 'submitting':
      return {
        message: 'No dispatch attempts recorded yet. The message is currently being dispatched.',
      };
    case 'failed': {
      if (failureReason === 'NO_ELIGIBLE_PROVIDER') {
        return {
          message:
            'No provider was attempted: every assigned provider was unavailable (disabled, draining, or its circuit was open).',
          action:
            'Check the organization\u2019s provider assignments, or send the message again later.',
        };
      }
      const formatted = formatFailureReason(failureReason);
      if (formatted) {
        return {
          message: `No provider was attempted before the message failed: ${formatted.title}.`,
          action: formatted.action,
        };
      }
      return {
        message: 'No provider was attempted before the message failed.',
        action: 'See the failure reason above for details.',
      };
    }
    case 'outcome_unknown':
      return {
        message:
          'No provider attempt was recorded, and the dispatch outcome could not be determined.',
        action: 'Confirm delivery status before resending.',
      };
    default:
      return {
        message: 'No provider attempt was recorded for this message.',
      };
  }
}
