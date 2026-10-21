/**
 * Utility for masking sensitive recipient addresses (phone numbers and emails)
 * by default to protect personal data in internal operator interfaces.
 */

/**
 * Masks a recipient address (phone or email) while preserving prefix/suffix context.
 *
 * Examples:
 * - Phone: `+12025550199` -> `+1 202 •••• 0199`
 * - Phone: `+447911123456` -> `+44 •••• 3456`
 * - Email: `user@example.com` -> `u••••r@example.com`
 * - Short email: `ab@c.com` -> `a•••@c.com`
 */
export function maskRecipientAddress(address: string | null | undefined): string {
  if (!address) return '';
  const trimmed = address.trim();
  if (!trimmed) return '';

  // Email masking: user@example.com -> u••••r@example.com
  if (trimmed.includes('@')) {
    const atIndex = trimmed.indexOf('@');
    const local = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex + 1);

    if (!domain) return trimmed;

    const maskedLocal =
      local.length <= 2 ? `${local[0] ?? ''}•••` : `${local[0]}••••${local[local.length - 1]}`;

    return `${maskedLocal}@${domain}`;
  }

  // E.164 phone or raw numeric address:
  // E.164: + followed by 7-15 digits
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1);
    if (digits.length >= 7) {
      let cc = '+1';
      if (!trimmed.startsWith('+1')) {
        const countryCodeLen = digits.length >= 13 ? 3 : 2;
        cc = trimmed.slice(0, 1 + countryCodeLen);
      }
      const suffix = trimmed.slice(-4);
      return `${cc} •••• ${suffix}`;
    }
  }

  if (trimmed.length > 6) {
    const prefix = trimmed.slice(0, 3);
    const suffix = trimmed.slice(-4);
    return `${prefix} •••• ${suffix}`;
  }

  return '••••••';
}
