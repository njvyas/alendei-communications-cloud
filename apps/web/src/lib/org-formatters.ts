/**
 * Organization Option Formatting Utilities (U1)
 *
 * Provides shared, consistent formatting and fallback labels for organization
 * picker and switcher components across the console.
 *
 * Invariants:
 * 1. Resolved organizations display human-readable `${org.name} (${org.slug})`.
 * 2. Unresolved organizations (missing from lookup, unprivileged caller, or
 *    lookup failure) fall back to `Organization ${id.slice(0, 8)}…`.
 * 3. Complete UUID is always preserved in the option value and title/tooltip
 *    for accessibility, traceability, and audit verification.
 */

export interface OrganizationNameSource {
  readonly name?: string | null;
  readonly slug?: string | null;
}

/**
 * Formats the human-readable display label for an organization option or badge.
 *
 * - When resolved with name and slug: `${org.name} (${org.slug})`
 * - When unresolved: `Organization ${id.slice(0, 8)}…`
 */
export function formatOrgOptionLabel(
  id: string,
  org?: OrganizationNameSource | null,
): string {
  if (org?.name && org?.slug) {
    return `${org.name} (${org.slug})`;
  }
  return `Organization ${id.slice(0, 8)}…`;
}

/**
 * Formats the tooltip / title attribute for an organization option or badge.
 *
 * - When resolved: `${org.name} (${org.slug})`
 * - When unresolved: `Organization ID: ${id}` (preserving the full UUID)
 */
export function formatOrgTooltip(
  id: string,
  org?: OrganizationNameSource | null,
): string {
  if (org?.name && org?.slug) {
    return `${org.name} (${org.slug})`;
  }
  return `Organization ID: ${id}`;
}
