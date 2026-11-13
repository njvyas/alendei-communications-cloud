/**
 * Phase 8C PR 8C-1 — journey graph contract (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §6).
 *
 * Shared by the API (authoritative validation) and the builder in `apps/web` (pre-validation
 * with the same function). Pure TypeScript: no Node, browser or database dependency.
 *
 * A journey version's graph is `{ schemaVersion: 1, entry, nodes }`. Every node names its
 * successors through typed edge fields. Version 1 graphs are acyclic (handover §6), so every
 * path from the entry ends at an `exit` node after a bounded number of steps.
 *
 * 8C-1 defines the vocabulary and validates it. Nothing here executes a journey: the runner
 * (8C-3), triggers (8C-4) and sends (8C-5/8C-6) come later, and the send node stays disabled
 * until the shared automation sending principal exists (owner decisions 1–2, 10-Nov-2026).
 * Webhook/API action nodes are placeholders only (owner decision 3): they never call out.
 */

export const JOURNEY_GRAPH_SCHEMA_VERSION = 1;

/** Structural limits (handover §6, proposed defaults). */
export const JOURNEY_GRAPH_LIMITS = Object.freeze({
  maxNodes: 200,
  /** Serialised graph size in UTF-16 code units (`JSON.stringify(graph).length`). */
  maxSerializedLength: 262_144,
  maxWaitSeconds: 366 * 24 * 60 * 60,
  minWaitSeconds: 60,
  maxUpdateOperations: 20,
  maxVariables: 50,
  maxStringLength: 500,
});

export const JOURNEY_NODE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** A custom field reference: `custom.<key>`; the key follows the contact custom-field rule. */
export const JOURNEY_CUSTOM_FIELD_PATTERN = /^custom\.[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const JOURNEY_STANDARD_FIELDS = Object.freeze(['firstName', 'lastName'] as const);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const JOURNEY_STATUSES = Object.freeze(['draft', 'active', 'paused', 'archived'] as const);
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];
export const JOURNEY_VERSION_STATUSES = Object.freeze(['draft', 'published', 'retired'] as const);
export type JourneyVersionStatus = (typeof JOURNEY_VERSION_STATUSES)[number];

export const JOURNEY_CHANNELS = Object.freeze(['whatsapp', 'sms', 'rcs'] as const);
export type JourneyChannel = (typeof JOURNEY_CHANNELS)[number];

/** Events a trigger may name: only events the platform produces today (handover §2). */
export const JOURNEY_TRIGGER_EVENTS = Object.freeze([
  'contact.created',
  'contact.updated',
  'contact.tag_added',
  'message.delivered',
  'message.read',
  'message.failed',
] as const);
export type JourneyTriggerEvent = (typeof JOURNEY_TRIGGER_EVENTS)[number];

export type JourneyTrigger =
  | { readonly kind: 'api' }
  | { readonly kind: 'event'; readonly event: JourneyTriggerEvent; readonly tag?: string }
  | {
      readonly kind: 'schedule';
      readonly segmentId: string;
      readonly schedule:
        | { readonly type: 'once'; readonly at: string }
        | {
            readonly type: 'recurring';
            readonly frequency: 'daily' | 'weekly';
            /** `HH:MM`, interpreted in `timeZone`. */
            readonly time: string;
            /** ISO weekdays 1 (Monday) to 7, required for `weekly`. */
            readonly daysOfWeek?: readonly number[];
            readonly timeZone: string;
          };
    };

/** A value for a template variable, or for an attribute write. */
export type JourneyValueSource =
  | { readonly source: 'contact_field'; readonly field: string }
  | { readonly source: 'literal'; readonly value: string };

export type JourneyConditionRule =
  | {
      readonly kind: 'attribute';
      readonly field: string;
      readonly op: 'eq' | 'neq' | 'exists' | 'not_exists';
      readonly value?: string;
    }
  | { readonly kind: 'tag'; readonly tag: string; readonly present: boolean }
  | { readonly kind: 'segment'; readonly segmentId: string; readonly member: boolean }
  | {
      readonly kind: 'consent';
      readonly channel: JourneyChannel;
      readonly consentType: string;
      readonly granted: boolean;
    }
  | {
      readonly kind: 'send_outcome';
      /** Key of a `send_message` node on every path to this condition. */
      readonly sendNodeKey: string;
      readonly outcome: 'delivered' | 'read' | 'failed';
    };

export type JourneyContactUpdate =
  | { readonly op: 'add_tag'; readonly tag: string }
  | { readonly op: 'remove_tag'; readonly tag: string }
  | { readonly op: 'set_attribute'; readonly field: string; readonly value: JourneyValueSource };

export type JourneyNode =
  | { readonly type: 'entry'; readonly trigger: JourneyTrigger; readonly next: string }
  | {
      readonly type: 'send_message';
      readonly channel: JourneyChannel;
      readonly templateId: string;
      readonly variables: Readonly<Record<string, JourneyValueSource>>;
      readonly onSuppressed: 'continue' | 'exit';
      readonly onRefused: 'continue' | 'exit';
      readonly next: string;
    }
  | { readonly type: 'wait_duration'; readonly seconds: number; readonly next: string }
  | { readonly type: 'wait_until'; readonly at: string; readonly next: string }
  | {
      readonly type: 'wait_window';
      readonly startTime: string;
      readonly endTime: string;
      readonly daysOfWeek?: readonly number[];
      readonly timeZone: string;
      readonly next: string;
    }
  | {
      readonly type: 'condition';
      readonly rule: JourneyConditionRule;
      readonly onTrue: string;
      readonly onFalse: string;
    }
  | {
      readonly type: 'wait_for_outcome';
      readonly sendNodeKey: string;
      readonly outcome: 'delivered' | 'read';
      readonly timeoutSeconds: number;
      readonly onOutcome: string;
      readonly onTimeout: string;
    }
  | {
      readonly type: 'update_contact';
      readonly operations: readonly JourneyContactUpdate[];
      readonly next: string;
    }
  | { readonly type: 'exit'; readonly reason?: string }
  | {
      readonly type: 'webhook' | 'crm_action' | 'human_handoff' | 'ai_handoff';
      readonly label?: string;
      readonly next: string;
    };

export type JourneyNodeType = JourneyNode['type'];

export interface JourneyGraph {
  readonly schemaVersion: typeof JOURNEY_GRAPH_SCHEMA_VERSION;
  readonly entry: string;
  readonly nodes: Readonly<Record<string, JourneyNode>>;
}

/** Edge fields per node type, in a stable order (used by validation and the builder). */
export const JOURNEY_NODE_EDGES: Readonly<Record<JourneyNodeType, readonly string[]>> =
  Object.freeze({
    entry: ['next'],
    send_message: ['next'],
    wait_duration: ['next'],
    wait_until: ['next'],
    wait_window: ['next'],
    condition: ['onTrue', 'onFalse'],
    wait_for_outcome: ['onOutcome', 'onTimeout'],
    update_contact: ['next'],
    exit: [],
    webhook: ['next'],
    crm_action: ['next'],
    human_handoff: ['next'],
    ai_handoff: ['next'],
  });

/**
 * The node catalogue the builder renders. `placeholder` nodes are recorded and do nothing:
 * webhook/API actions (owner decision 3, 10-Nov-2026) and the handoff/CRM targets that need
 * Phases 8D, 8F and 10 (`ROADMAP.md` §11c).
 */
export const JOURNEY_NODE_CATALOGUE: Readonly<
  Record<JourneyNodeType, { readonly category: string; readonly placeholder: boolean }>
> = Object.freeze({
  entry: { category: 'trigger', placeholder: false },
  send_message: { category: 'action', placeholder: false },
  wait_duration: { category: 'wait', placeholder: false },
  wait_until: { category: 'wait', placeholder: false },
  wait_window: { category: 'wait', placeholder: false },
  condition: { category: 'branch', placeholder: false },
  wait_for_outcome: { category: 'branch', placeholder: false },
  update_contact: { category: 'action', placeholder: false },
  exit: { category: 'exit', placeholder: false },
  webhook: { category: 'action', placeholder: true },
  crm_action: { category: 'action', placeholder: true },
  human_handoff: { category: 'action', placeholder: true },
  ai_handoff: { category: 'action', placeholder: true },
});

export const JOURNEY_NODE_TYPES = Object.freeze(
  Object.keys(JOURNEY_NODE_CATALOGUE) as JourneyNodeType[],
);

export const JOURNEY_GRAPH_ISSUE_CODES = Object.freeze([
  'GRAPH_NOT_OBJECT',
  'GRAPH_TOO_LARGE',
  'SCHEMA_VERSION_UNSUPPORTED',
  'ENTRY_MISSING',
  'TOO_MANY_NODES',
  'NODE_KEY_INVALID',
  'NODE_INVALID',
  'NODE_TYPE_UNKNOWN',
  'FIELD_INVALID',
  'EDGE_MISSING',
  'EDGE_TARGET_UNKNOWN',
  'EDGE_TO_ENTRY',
  'MULTIPLE_ENTRY_NODES',
  'UNREACHABLE_NODE',
  'CYCLE',
  'NO_EXIT',
  'SEND_REFERENCE_INVALID',
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_NOT_APPROVED',
  'TEMPLATE_CHANNEL_MISMATCH',
  'TEMPLATE_VARIABLE_UNMAPPED',
  'TEMPLATE_VARIABLE_UNKNOWN',
  'SEGMENT_NOT_FOUND',
  'PLACEHOLDER_NODE',
] as const);
export type JourneyGraphIssueCode = (typeof JOURNEY_GRAPH_ISSUE_CODES)[number];

export interface JourneyGraphIssue {
  readonly code: JourneyGraphIssueCode;
  readonly message: string;
  readonly nodeKey?: string;
  /** Dotted path inside the node (`rule.field`, `variables.name`), when narrower than the node. */
  readonly path?: string;
}

export interface JourneyGraphValidationReport {
  readonly valid: boolean;
  readonly errors: readonly JourneyGraphIssue[];
  /** Never block publication (e.g. placeholder nodes). */
  readonly warnings: readonly JourneyGraphIssue[];
}

/** The minimal valid graph every new journey starts with. */
export function defaultJourneyGraph(): JourneyGraph {
  return {
    schemaVersion: JOURNEY_GRAPH_SCHEMA_VERSION,
    entry: 'start',
    nodes: {
      start: { type: 'entry', trigger: { kind: 'api' }, next: 'finish' },
      finish: { type: 'exit' },
    },
  };
}

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace. The API hashes
 * this form (`graph_sha256`), so the hash does not depend on key order.
 */
export function canonicalJourneyJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJourneyJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map(
      (k) => `${JSON.stringify(k)}:${canonicalJourneyJson((value as Record<string, unknown>)[k])}`,
    );
  return `{${entries.join(',')}}`;
}

// --- structural validation ---------------------------------------------------------------

/**
 * Own-property membership. Graph keys and node types come from untrusted JSON, so `in` (which
 * follows the prototype chain) would accept `constructor`, `toString` or `__proto__` as known
 * names. Every membership test in the validator uses this instead.
 */
const own = (o: object, key: unknown): key is string =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(o, key);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number = JOURNEY_GRAPH_LIMITS.maxStringLength): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFieldRef = (v: unknown): v is string =>
  typeof v === 'string' &&
  ((JOURNEY_STANDARD_FIELDS as readonly string[]).includes(v) ||
    JOURNEY_CUSTOM_FIELD_PATTERN.test(v));

/** True when `tz` is an IANA time zone this runtime knows (`Intl` only; no data files). */
export function isJourneyTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isIsoInstant(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
    !Number.isNaN(Date.parse(v))
  );
}

function validDays(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 7 &&
    v.every((d) => isInt(d) && d >= 1 && d <= 7) &&
    new Set(v).size === v.length
  );
}

function valueSourceIssue(v: unknown): string | null {
  if (!isObject(v)) return 'must be an object';
  if (v.source === 'contact_field')
    return isFieldRef(v.field) ? null : 'field is not a contact field';
  if (v.source === 'literal')
    return typeof v.value === 'string' && v.value.length <= JOURNEY_GRAPH_LIMITS.maxStringLength
      ? null
      : 'value must be a string of at most 500 characters';
  return "source must be 'contact_field' or 'literal'";
}

/** Field-level checks of one node; edges are checked separately. */
function nodeFieldIssues(key: string, node: Record<string, unknown>): JourneyGraphIssue[] {
  const out: JourneyGraphIssue[] = [];
  const bad = (path: string, message: string) =>
    out.push({ code: 'FIELD_INVALID', nodeKey: key, path, message });
  const L = JOURNEY_GRAPH_LIMITS;
  switch (node.type) {
    case 'entry': {
      const t = node.trigger;
      if (!isObject(t)) {
        bad('trigger', 'trigger must be an object');
        break;
      }
      if (t.kind === 'api') break;
      if (t.kind === 'event') {
        if (!(JOURNEY_TRIGGER_EVENTS as readonly string[]).includes(t.event as string))
          bad('trigger.event', 'unknown trigger event');
        if (t.event === 'contact.tag_added' && !isText(t.tag, 100))
          bad('trigger.tag', 'contact.tag_added needs a tag');
        if (t.event !== 'contact.tag_added' && t.tag !== undefined)
          bad('trigger.tag', 'tag applies to contact.tag_added only');
        break;
      }
      if (t.kind === 'schedule') {
        if (typeof t.segmentId !== 'string' || !UUID.test(t.segmentId))
          bad('trigger.segmentId', 'segmentId must be a UUID');
        const s = t.schedule;
        if (!isObject(s)) bad('trigger.schedule', 'schedule must be an object');
        else if (s.type === 'once') {
          if (!isIsoInstant(s.at)) bad('trigger.schedule.at', 'at must be an ISO-8601 instant');
        } else if (s.type === 'recurring') {
          if (s.frequency !== 'daily' && s.frequency !== 'weekly')
            bad('trigger.schedule.frequency', "frequency must be 'daily' or 'weekly'");
          if (typeof s.time !== 'string' || !HHMM.test(s.time))
            bad('trigger.schedule.time', 'time must be HH:MM');
          if (!isJourneyTimeZone(s.timeZone))
            bad('trigger.schedule.timeZone', 'timeZone must be an IANA time zone');
          if (s.frequency === 'weekly' && !validDays(s.daysOfWeek))
            bad('trigger.schedule.daysOfWeek', 'weekly schedules need distinct days 1–7');
          if (s.frequency === 'daily' && s.daysOfWeek !== undefined)
            bad('trigger.schedule.daysOfWeek', 'daily schedules take no days');
        } else bad('trigger.schedule.type', "type must be 'once' or 'recurring'");
        break;
      }
      bad('trigger.kind', "kind must be 'api', 'event' or 'schedule'");
      break;
    }
    case 'send_message': {
      if (!(JOURNEY_CHANNELS as readonly string[]).includes(node.channel as string))
        bad('channel', 'unknown channel');
      if (typeof node.templateId !== 'string' || !UUID.test(node.templateId))
        bad('templateId', 'templateId must be a UUID');
      if (!isObject(node.variables)) bad('variables', 'variables must be an object');
      else {
        const names = Object.keys(node.variables);
        if (names.length > L.maxVariables) bad('variables', `at most ${L.maxVariables} variables`);
        for (const name of names) {
          const issue = valueSourceIssue(node.variables[name]);
          if (issue) bad(`variables.${name}`, issue);
        }
      }
      for (const f of ['onSuppressed', 'onRefused'] as const)
        if (node[f] !== 'continue' && node[f] !== 'exit') bad(f, "must be 'continue' or 'exit'");
      break;
    }
    case 'wait_duration':
      if (
        !isInt(node.seconds) ||
        node.seconds < L.minWaitSeconds ||
        node.seconds > L.maxWaitSeconds
      )
        bad(
          'seconds',
          `seconds must be an integer from ${L.minWaitSeconds} to ${L.maxWaitSeconds}`,
        );
      break;
    case 'wait_until':
      if (!isIsoInstant(node.at)) bad('at', 'at must be an ISO-8601 instant');
      break;
    case 'wait_window':
      if (typeof node.startTime !== 'string' || !HHMM.test(node.startTime))
        bad('startTime', 'startTime must be HH:MM');
      if (typeof node.endTime !== 'string' || !HHMM.test(node.endTime))
        bad('endTime', 'endTime must be HH:MM');
      if (node.startTime === node.endTime) bad('endTime', 'the window must not be empty');
      if (node.daysOfWeek !== undefined && !validDays(node.daysOfWeek))
        bad('daysOfWeek', 'daysOfWeek must be distinct days 1–7');
      if (!isJourneyTimeZone(node.timeZone)) bad('timeZone', 'timeZone must be an IANA time zone');
      break;
    case 'condition': {
      const r = node.rule;
      if (!isObject(r)) {
        bad('rule', 'rule must be an object');
        break;
      }
      if (r.kind === 'attribute') {
        if (!isFieldRef(r.field)) bad('rule.field', 'field is not a contact field');
        if (!['eq', 'neq', 'exists', 'not_exists'].includes(r.op as string))
          bad('rule.op', 'unknown operator');
        const needsValue = r.op === 'eq' || r.op === 'neq';
        if (needsValue && !(typeof r.value === 'string' && r.value.length <= L.maxStringLength))
          bad('rule.value', 'eq/neq need a string value');
        if (!needsValue && r.value !== undefined)
          bad('rule.value', 'exists/not_exists take no value');
      } else if (r.kind === 'tag') {
        if (!isText(r.tag, 100)) bad('rule.tag', 'tag must be a non-empty string');
        if (typeof r.present !== 'boolean') bad('rule.present', 'present must be a boolean');
      } else if (r.kind === 'segment') {
        if (typeof r.segmentId !== 'string' || !UUID.test(r.segmentId))
          bad('rule.segmentId', 'segmentId must be a UUID');
        if (typeof r.member !== 'boolean') bad('rule.member', 'member must be a boolean');
      } else if (r.kind === 'consent') {
        if (!(JOURNEY_CHANNELS as readonly string[]).includes(r.channel as string))
          bad('rule.channel', 'unknown channel');
        if (!isText(r.consentType, 100)) bad('rule.consentType', 'consentType must be a string');
        if (typeof r.granted !== 'boolean') bad('rule.granted', 'granted must be a boolean');
      } else if (r.kind === 'send_outcome') {
        if (typeof r.sendNodeKey !== 'string') bad('rule.sendNodeKey', 'sendNodeKey is required');
        if (!['delivered', 'read', 'failed'].includes(r.outcome as string))
          bad('rule.outcome', 'unknown outcome');
      } else bad('rule.kind', 'unknown condition kind');
      break;
    }
    case 'wait_for_outcome':
      if (typeof node.sendNodeKey !== 'string') bad('sendNodeKey', 'sendNodeKey is required');
      if (node.outcome !== 'delivered' && node.outcome !== 'read')
        bad('outcome', "outcome must be 'delivered' or 'read'");
      if (
        !isInt(node.timeoutSeconds) ||
        node.timeoutSeconds < L.minWaitSeconds ||
        node.timeoutSeconds > L.maxWaitSeconds
      )
        bad(
          'timeoutSeconds',
          `timeoutSeconds must be an integer from ${L.minWaitSeconds} to ${L.maxWaitSeconds}`,
        );
      break;
    case 'update_contact': {
      const ops = node.operations;
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > L.maxUpdateOperations) {
        bad('operations', `operations must hold 1 to ${L.maxUpdateOperations} entries`);
        break;
      }
      ops.forEach((op: unknown, i) => {
        if (!isObject(op)) {
          bad(`operations.${i}`, 'must be an object');
          return;
        }
        if (op.op === 'add_tag' || op.op === 'remove_tag') {
          if (!isText(op.tag, 100)) bad(`operations.${i}.tag`, 'tag must be a non-empty string');
        } else if (op.op === 'set_attribute') {
          if (!isFieldRef(op.field)) bad(`operations.${i}.field`, 'field is not a contact field');
          const issue = valueSourceIssue(op.value);
          if (issue) bad(`operations.${i}.value`, issue);
        } else bad(`operations.${i}.op`, 'unknown operation');
      });
      break;
    }
    case 'exit':
      if (node.reason !== undefined && !isText(node.reason, 100))
        bad('reason', 'reason must be a short string');
      break;
    case 'webhook':
    case 'crm_action':
    case 'human_handoff':
    case 'ai_handoff':
      if (node.label !== undefined && !isText(node.label, 100))
        bad('label', 'label must be a short string');
      break;
  }
  return out;
}

/**
 * Structural validation: shape, limits, edges, reachability, acyclicity, exit reachability
 * and `send_message` references. Referential checks against the organisation's templates and
 * segments are the API's (`JourneysService`), which merges its findings into the same report.
 */
export function validateJourneyGraph(graph: unknown): JourneyGraphValidationReport {
  const errors: JourneyGraphIssue[] = [];
  const warnings: JourneyGraphIssue[] = [];
  const done = () => ({ valid: errors.length === 0, errors, warnings });

  if (!isObject(graph)) {
    errors.push({ code: 'GRAPH_NOT_OBJECT', message: 'graph must be an object' });
    return done();
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(graph);
  } catch {
    errors.push({ code: 'GRAPH_NOT_OBJECT', message: 'graph must be JSON' });
    return done();
  }
  if (serialized.length > JOURNEY_GRAPH_LIMITS.maxSerializedLength) {
    errors.push({ code: 'GRAPH_TOO_LARGE', message: 'graph exceeds the size limit' });
    return done();
  }
  if (graph.schemaVersion !== JOURNEY_GRAPH_SCHEMA_VERSION) {
    errors.push({ code: 'SCHEMA_VERSION_UNSUPPORTED', message: 'schemaVersion must be 1' });
    return done();
  }
  if (!isObject(graph.nodes)) {
    errors.push({ code: 'NODE_INVALID', message: 'nodes must be an object' });
    return done();
  }
  const nodes = graph.nodes;
  const keys = Object.keys(nodes);
  if (keys.length > JOURNEY_GRAPH_LIMITS.maxNodes) {
    errors.push({
      code: 'TOO_MANY_NODES',
      message: `at most ${JOURNEY_GRAPH_LIMITS.maxNodes} nodes`,
    });
    return done();
  }

  const edges = new Map<string, string[]>();
  for (const key of keys) {
    if (!JOURNEY_NODE_KEY_PATTERN.test(key))
      errors.push({
        code: 'NODE_KEY_INVALID',
        nodeKey: key,
        message: 'node keys are [a-z][a-z0-9_]{0,63}',
      });
    const node = nodes[key];
    if (!isObject(node)) {
      errors.push({ code: 'NODE_INVALID', nodeKey: key, message: 'node must be an object' });
      continue;
    }
    if (!own(JOURNEY_NODE_EDGES, node.type) || !own(JOURNEY_NODE_CATALOGUE, node.type)) {
      errors.push({ code: 'NODE_TYPE_UNKNOWN', nodeKey: key, message: `unknown node type` });
      continue;
    }
    const type = node.type as JourneyNodeType;
    errors.push(...nodeFieldIssues(key, node));
    if (JOURNEY_NODE_CATALOGUE[type].placeholder)
      warnings.push({
        code: 'PLACEHOLDER_NODE',
        nodeKey: key,
        message: `${type} is a placeholder: it is recorded and performs no action`,
      });
    const targets: string[] = [];
    for (const field of JOURNEY_NODE_EDGES[type]) {
      const target = own(node, field) ? node[field] : undefined;
      if (typeof target !== 'string' || target.length === 0) {
        errors.push({
          code: 'EDGE_MISSING',
          nodeKey: key,
          path: field,
          message: `${field} is required`,
        });
      } else if (!own(nodes, target)) {
        errors.push({
          code: 'EDGE_TARGET_UNKNOWN',
          nodeKey: key,
          path: field,
          message: `${field} names an unknown node`,
        });
      } else {
        targets.push(target);
      }
    }
    edges.set(key, targets);
  }

  const entryKey = graph.entry;
  const entryNodes = keys.filter(
    (k) => isObject(nodes[k]) && (nodes[k] as Record<string, unknown>).type === 'entry',
  );
  if (
    !own(nodes, entryKey) ||
    !isObject(nodes[entryKey]) ||
    (nodes[entryKey] as Record<string, unknown>).type !== 'entry'
  ) {
    errors.push({ code: 'ENTRY_MISSING', message: 'entry must name an entry node' });
    return done();
  }
  if (entryNodes.length > 1)
    errors.push({ code: 'MULTIPLE_ENTRY_NODES', message: 'a graph has exactly one entry node' });
  for (const [from, targets] of edges)
    if (targets.includes(entryKey))
      errors.push({
        code: 'EDGE_TO_ENTRY',
        nodeKey: from,
        message: 'no edge may lead back to the entry',
      });

  // Reachability and acyclicity: iterative DFS with colours.
  const colour = new Map<string, 0 | 1 | 2>();
  const order: string[] = [];
  let cycle = false;
  const stack: { key: string; i: number }[] = [{ key: entryKey, i: 0 }];
  colour.set(entryKey, 1);
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const out = edges.get(top.key) ?? [];
    if (top.i < out.length) {
      const next = out[top.i++]!;
      const c = colour.get(next) ?? 0;
      if (c === 1) cycle = true;
      else if (c === 0) {
        colour.set(next, 1);
        stack.push({ key: next, i: 0 });
      }
    } else {
      colour.set(top.key, 2);
      order.push(top.key);
      stack.pop();
    }
  }
  if (cycle) errors.push({ code: 'CYCLE', message: 'version 1 graphs must be acyclic' });
  for (const key of keys)
    if (!colour.has(key))
      errors.push({
        code: 'UNREACHABLE_NODE',
        nodeKey: key,
        message: 'node is not reachable from the entry',
      });
  if (!keys.some((k) => colour.has(k) && (nodes[k] as Record<string, unknown>)?.type === 'exit'))
    errors.push({ code: 'NO_EXIT', message: 'at least one exit node must be reachable' });

  // send_message references: the referenced node must be a send node that lies on EVERY path
  // from the entry to the referencing node (it dominates it), so its outcome always exists.
  if (!cycle) {
    const preds = new Map<string, string[]>();
    for (const [from, targets] of edges)
      for (const t of targets) preds.set(t, [...(preds.get(t) ?? []), from]);
    const topo = [...order].reverse().filter((k) => colour.has(k));
    const dom = new Map<string, Set<string>>();
    for (const k of topo) {
      const ps = (preds.get(k) ?? []).filter((p) => colour.has(p));
      let set: Set<string>;
      if (k === entryKey || ps.length === 0) set = new Set();
      else {
        set = new Set([...dom.get(ps[0]!)!, ps[0]!]);
        for (const p of ps.slice(1)) {
          const pd = new Set([...dom.get(p)!, p]);
          for (const x of set) if (!pd.has(x)) set.delete(x);
        }
      }
      dom.set(k, set);
    }
    for (const key of keys) {
      const node = nodes[key] as Record<string, unknown> | undefined;
      if (!isObject(node) || !colour.has(key)) continue;
      const ref =
        node.type === 'wait_for_outcome'
          ? node.sendNodeKey
          : node.type === 'condition' && isObject(node.rule) && node.rule.kind === 'send_outcome'
            ? node.rule.sendNodeKey
            : undefined;
      if (ref === undefined) continue;
      const target = own(nodes, ref)
        ? (nodes[ref] as Record<string, unknown> | undefined)
        : undefined;
      if (!isObject(target) || target.type !== 'send_message' || !dom.get(key)?.has(ref as string))
        errors.push({
          code: 'SEND_REFERENCE_INVALID',
          nodeKey: key,
          path: node.type === 'condition' ? 'rule.sendNodeKey' : 'sendNodeKey',
          message: 'sendNodeKey must name a send_message node on every path to this node',
        });
    }
  }
  return done();
}

// --- API records ---------------------------------------------------------------------------

export interface JourneyVersionSummary {
  readonly id: string;
  readonly versionNumber: number;
  readonly status: JourneyVersionStatus;
  readonly graphSha256: string;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JourneyVersionRecord extends JourneyVersionSummary {
  readonly journeyId: string;
  readonly workspaceId: string;
  readonly graphSchemaVersion: number;
  readonly graph: JourneyGraph;
  readonly createdBy: string | null;
  readonly publishedBy: string | null;
}

export interface JourneyRecord {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: JourneyStatus;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The current draft, if any. */
  readonly draftVersion: JourneyVersionSummary | null;
  /** The highest published version, if any. */
  readonly latestPublishedVersion: JourneyVersionSummary | null;
}

/** Audit actions written by the journeys module. */
export const JOURNEY_AUDIT_ACTIONS = Object.freeze({
  CREATED: 'journey.created',
  UPDATED: 'journey.updated',
  DELETED: 'journey.deleted',
  VERSION_CREATED: 'journey.version_created',
  GRAPH_UPDATED: 'journey.graph_updated',
  VERSION_PUBLISHED: 'journey.version_published',
});
