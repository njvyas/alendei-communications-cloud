/**
 * Templates contracts (Phase 3.1, ADR-014 §6, §11, D21).
 *
 * Organization-owned resource under `/templates`.
 * approval_status is an internal, simulated state moved by templates.manage.
 */

import type { SmsDltMetadata } from './sms';

export const TEMPLATE_APPROVAL_STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const;
export type TemplateApprovalStatus = (typeof TEMPLATE_APPROVAL_STATUSES)[number];

export interface TemplateResponse {
  readonly id: string;
  readonly orgId: string;
  readonly channelId: string;
  readonly name: string;
  readonly body: string;
  readonly variables: readonly string[];
  readonly dlt?: SmsDltMetadata;
  readonly approvalStatus: TemplateApprovalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Deterministically renders template body by replacing `{{key}}` placeholders with variable values.
 * Supports both dictionary mapping (`{ "1": "123456" }` or `{ "name": "Alice" }`)
 * and 1-indexed array mapping (`["123456"]`).
 */
export function renderTemplate(
  body: string,
  variables?: Record<string, unknown> | readonly unknown[],
): { readonly text: string; readonly missingVariables: readonly string[] } {
  const missing: string[] = [];
  const rendered = body.replace(/\{\{([^{}]+)\}\}/g, (match, keyRaw) => {
    const key = keyRaw.trim();
    if (!variables) {
      missing.push(key);
      return match;
    }
    if (Array.isArray(variables)) {
      const idx = Number(key);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= variables.length) {
        const val = variables[idx - 1];
        if (typeof val === 'string' || typeof val === 'number') return String(val);
      }
      missing.push(key);
      return match;
    }
    if (typeof variables === 'object') {
      const dict = variables as Record<string, unknown>;
      if (key in dict) {
        const val = dict[key];
        if (typeof val === 'string' || typeof val === 'number') return String(val);
      }
      missing.push(key);
      return match;
    }
    missing.push(key);
    return match;
  });
  return { text: rendered, missingVariables: missing };
}
