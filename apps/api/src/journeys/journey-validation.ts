import { Injectable } from '@nestjs/common';
import {
  renderTemplate,
  validateJourneyGraph,
  type JourneyGraph,
  type JourneyGraphIssue,
  type JourneyGraphValidationReport,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

/** Graph checks that refuse even a draft save: the value must be a v1 graph object of bounded size. */
export const SAVE_BLOCKING: readonly string[] = [
  'GRAPH_NOT_OBJECT',
  'GRAPH_TOO_LARGE',
  'SCHEMA_VERSION_UNSUPPORTED',
];

/**
 * The full validation report of a journey graph (8C-1; moved here in 8C-2 so activation can
 * re-run it): structural validation plus the organisation's data — templates (exist,
 * approved, channel, every placeholder mapped) and segments (exist in this workspace).
 * Read-only.
 */
@Injectable()
export class JourneyValidation {
  async fullReport(
    tx: Transaction,
    orgId: string,
    workspaceId: string,
    graph: unknown,
  ): Promise<JourneyGraphValidationReport> {
    const base = validateJourneyGraph(graph);
    if (base.errors.some((e) => SAVE_BLOCKING.includes(e.code) || e.code === 'NODE_INVALID'))
      return base;
    const errors: JourneyGraphIssue[] = [...base.errors];
    const warnings: JourneyGraphIssue[] = [...base.warnings];
    const nodes = Object.entries((graph as JourneyGraph).nodes ?? {});

    const templateRefs = nodes.filter(
      ([, n]) => n?.type === 'send_message' && typeof n.templateId === 'string',
    ) as [string, Extract<JourneyGraph['nodes'][string], { type: 'send_message' }>][];
    const segmentRefs: [string, string, string][] = [];
    for (const [key, n] of nodes) {
      if (n?.type === 'entry' && n.trigger?.kind === 'schedule')
        segmentRefs.push([key, 'trigger.segmentId', n.trigger.segmentId]);
      if (n?.type === 'condition' && n.rule?.kind === 'segment')
        segmentRefs.push([key, 'rule.segmentId', n.rule.segmentId]);
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const templateIds = [...new Set(templateRefs.map(([, n]) => n.templateId))].filter((id) =>
      uuid.test(id),
    );
    const templates =
      templateIds.length === 0
        ? []
        : await tx
            .select({
              id: schema.templates.id,
              body: schema.templates.body,
              approvalStatus: schema.templates.approvalStatus,
              channelCode: sql<string>`app_channel_code(${schema.templates.channelId})`,
            })
            .from(schema.templates)
            .where(
              and(
                eq(schema.templates.orgId, orgId),
                inArray(schema.templates.id, templateIds),
                isNull(schema.templates.deletedAt),
              ),
            );
    const byId = new Map(templates.map((t) => [t.id, t]));
    for (const [key, n] of templateRefs) {
      if (!uuid.test(n.templateId)) continue; // already a FIELD_INVALID
      const t = byId.get(n.templateId);
      if (!t) {
        errors.push({
          code: 'TEMPLATE_NOT_FOUND',
          nodeKey: key,
          path: 'templateId',
          message: 'template not found',
        });
        continue;
      }
      if (t.approvalStatus !== 'approved')
        errors.push({
          code: 'TEMPLATE_NOT_APPROVED',
          nodeKey: key,
          path: 'templateId',
          message: `template approval status is '${t.approvalStatus}'`,
        });
      if (t.channelCode !== n.channel)
        errors.push({
          code: 'TEMPLATE_CHANNEL_MISMATCH',
          nodeKey: key,
          path: 'channel',
          message: `template channel is '${t.channelCode}'`,
        });
      const placeholders = [...new Set(renderTemplate(t.body, {}).missingVariables)];
      const mapped = Object.keys(n.variables ?? {});
      for (const p of placeholders)
        if (!mapped.includes(p))
          errors.push({
            code: 'TEMPLATE_VARIABLE_UNMAPPED',
            nodeKey: key,
            path: `variables.${p}`,
            message: `template variable '${p}' has no value`,
          });
      for (const m of mapped)
        if (!placeholders.includes(m))
          warnings.push({
            code: 'TEMPLATE_VARIABLE_UNKNOWN',
            nodeKey: key,
            path: `variables.${m}`,
            message: `the template has no variable '${m}'`,
          });
    }

    const segmentIds = [...new Set(segmentRefs.map(([, , id]) => id))].filter(
      (id) => typeof id === 'string' && uuid.test(id),
    );
    const segments =
      segmentIds.length === 0
        ? []
        : await tx
            .select({ id: schema.segments.id })
            .from(schema.segments)
            .where(
              and(
                eq(schema.segments.orgId, orgId),
                eq(schema.segments.workspaceId, workspaceId),
                inArray(schema.segments.id, segmentIds),
                isNull(schema.segments.deletedAt),
              ),
            );
    const found = new Set(segments.map((s) => s.id));
    for (const [key, path, id] of segmentRefs)
      if (typeof id === 'string' && uuid.test(id) && !found.has(id))
        errors.push({
          code: 'SEGMENT_NOT_FOUND',
          nodeKey: key,
          path,
          message: 'segment not found in this workspace',
        });

    return { valid: errors.length === 0, errors, warnings };
  }
}
