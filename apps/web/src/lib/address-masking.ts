/**
 * Utility for masking sensitive recipient addresses (phone numbers and emails)
 * by default to protect personal data in internal operator interfaces.
 */

const TWO_DIGIT_CC = new Set([
  '20',
  '27',
  '28',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
]);

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
      if (digits.startsWith('1') || digits.startsWith('7')) {
        cc = `+${digits[0]}`;
      } else if (TWO_DIGIT_CC.has(digits.slice(0, 2))) {
        cc = `+${digits.slice(0, 2)}`;
      } else if (digits.length >= 8) {
        cc = `+${digits.slice(0, 3)}`;
      } else {
        cc = `+${digits.slice(0, 2)}`;
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
