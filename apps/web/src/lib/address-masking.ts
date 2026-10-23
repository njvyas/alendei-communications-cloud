/**
 * Utility for masking sensitive recipient addresses (phone numbers and emails)
 * by default to protect personal data in internal operator interfaces.
 * Re-exports canonical contract implementation from @acc/contracts (F2).
 */
export {
  maskRecipientAddress,
  sanitizeRecipientContent,
  sanitizeRecipientData,
} from '@acc/contracts';
