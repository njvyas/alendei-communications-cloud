/**
 * Phase 5.0 PR-C — shared fixtures for the webhook ingress suites.
 *
 * TEST-ONLY key material: the pepper and the simulator signing key below exist only in this
 * file and are injected through the env secrets backend for the duration of a suite; nothing
 * here is, or resembles, a provider credential.
 */
import { createHash, randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  SimulatorWebhookFactory,
  type SimulatorReceiptElement,
} from '../src/provider-adapters/simulator-webhook';
import { generateIngressKey, hashIngressKey } from '../src/webhooks/ingress-key';
// Types only: importing a value from auth-harness would load AppModule — and validate the
// configuration — before a suite has set its environment (ConfigModule.forRoot runs at import).
import type { Harness, TenantFixture } from './auth-harness';

export const INGRESS_PREFIX = 'api/v1';

export const TEST_PEPPER = 'test-only-webhook-ingress-pepper-0123456789abcdef';
export const TEST_SIGNING_KEY = 'test-only-simulator-signing-key-0123456789abcdef';
export const factory = new SimulatorWebhookFactory(new TextEncoder().encode(TEST_SIGNING_KEY));

/** Sets the webhook environment for one suite; returns the function that restores it. */
export function webhookEnvironment(overrides: Record<string, string> = {}): () => void {
  const values: Record<string, string> = {
    ACC_TEST_WEBHOOK_PEPPER: TEST_PEPPER,
    ACC_TEST_SIMULATOR_SIGNING_KEY: TEST_SIGNING_KEY,
    WEBHOOK_INGRESS_KEY_PEPPER_REF: 'env:ACC_TEST_WEBHOOK_PEPPER',
    SIMULATOR_WEBHOOK_SIGNING_KEY_REF: 'env:ACC_TEST_SIMULATOR_SIGNING_KEY',
    ...overrides,
  };
  const before = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export interface WebhookWorld {
  readonly channelId: string;
  readonly providers: string[];
  readonly contacts: Map<string, string>;
}

export async function channelId(h: Harness, code: string): Promise<string> {
  const [c] = await h.admin
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.code, code as never));
  return c!.id;
}

/** A simulator provider with an ingress key (hash only stored) and its ingress switched on. */
export async function ingressProvider(
  h: Harness,
  world: WebhookWorld,
  options: { receipts?: string[] | null; enabled?: boolean; label?: string; channel?: string } = {},
): Promise<{ id: string; key: string }> {
  const slug = `${options.label ?? 'wh'}-${randomBytes(4).toString('hex')}`;
  const [p] = await h.admin
    .insert(schema.providers)
    .values({
      channelId: options.channel ?? world.channelId,
      name: `P50C ${slug}`,
      slug,
      adapterKey: 'simulator',
      status: 'active',
      healthState: 'healthy',
      circuitState: 'closed',
    })
    .returning();
  world.providers.push(p!.id);
  const receipts =
    options.receipts === undefined ? ['delivered', 'undelivered', 'read'] : options.receipts;
  if (receipts) {
    await h.admin
      .insert(schema.providerCapabilities)
      .values({ providerId: p!.id, capabilityKey: 'delivery_receipts', value: receipts });
  }
  const key = generateIngressKey();
  await h.admin.execute(sql`
    UPDATE providers SET webhook_ingress_key_hash = ${hashIngressKey(TEST_PEPPER, key)},
                         webhook_ingress_key_rotated_at = now(),
                         webhook_ingress_enabled = ${options.enabled ?? true}
     WHERE id = ${p!.id}`);
  return { id: p!.id, key };
}

/**
 * A message with one attempt per entry, planted by the owner (a maintenance session, so the
 * insert guard admits the settled state a dispatcher settlement would have written).
 */
export async function plantMessage(
  h: Harness,
  world: WebhookWorld,
  tenant: TenantFixture,
  attempts: Array<{
    provider: string;
    status: 'submitting' | 'accepted' | 'failed' | 'outcome_unknown';
    pmid?: string | null;
    delivery?: string | null;
  }>,
  messageStatus?: string,
): Promise<{ messageId: string; attemptIds: string[] }> {
  let contactId = world.contacts.get(tenant.orgId);
  if (!contactId) {
    contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      displayName: 'P50C recipient',
    });
    world.contacts.set(tenant.orgId, contactId);
  }
  for (const a of attempts) {
    await h.admin.execute(sql`
      INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority, status)
      SELECT ${tenant.orgId}, ${a.provider}, ${world.channelId},
             (SELECT coalesce(max(priority), 0) + 1 FROM organization_provider_assignments WHERE org_id = ${tenant.orgId}),
             'active'
       WHERE NOT EXISTS (SELECT 1 FROM organization_provider_assignments
                          WHERE org_id = ${tenant.orgId} AND provider_id = ${a.provider})`);
  }
  const messageId = uuidv7();
  const last = attempts.at(-1);
  // Inserted `submitting` and settled after the attempts exist: the terminal guard refuses any
  // non-delivery change to a message once it is accepted, failed or outcome_unknown.
  await h.admin.execute(sql`
    INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address,
                          payload, correlation_id)
    VALUES (${messageId}, ${tenant.orgId}, ${tenant.workspaceId}, ${contactId}, ${world.channelId},
            'submitting', '+12025550190', '{"text":"P50C"}'::jsonb, ${uuidv7()})`);
  const attemptIds: string[] = [];
  let n = 1;
  for (const a of attempts) {
    const id = uuidv7();
    await h.admin.execute(sql`
      INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number,
                                    fencing_epoch, claim_token, status, provider_message_id, delivery_status)
      VALUES (${id}, ${messageId}, ${tenant.orgId}, ${a.provider}, ${world.channelId}, ${n}, ${n},
              ${uuidv7()}, ${a.status}, ${a.pmid === undefined ? (a.status === 'accepted' ? `sim-${id}` : null) : a.pmid},
              ${a.delivery === undefined ? (a.status === 'accepted' || a.status === 'outcome_unknown' ? 'pending' : null) : a.delivery}::message_delivery_status)`);
    attemptIds.push(id);
    n += 1;
  }
  const finalStatus = messageStatus ?? last?.status ?? 'submitting';
  await h.admin.execute(sql`
    UPDATE messages
       SET status = ${finalStatus}::message_status,
           current_attempt_id = ${attemptIds.at(-1) ?? null},
           delivery_status = (SELECT delivery_status FROM message_attempts WHERE id = ${attemptIds.at(-1) ?? null})
     WHERE id = ${messageId}`);
  return { messageId, attemptIds };
}

/** POSTs a signed simulator receipt request over real HTTP. */
export function post(
  h: Harness,
  key: string,
  elements: readonly SimulatorReceiptElement[],
  options: { signature?: 'VALID' | 'INVALID' | 'STALE'; nowMs?: number } = {},
) {
  const signed = factory.request(elements, {
    nowMs: options.nowMs ?? Date.now(),
    ...(options.signature ? { signature: options.signature } : {}),
  });
  return postRaw(h, key, signed.rawBody, signed.headers);
}

export function postRaw(
  h: Harness,
  key: string,
  body: Uint8Array | string,
  headers: Record<string, string>,
) {
  let r = request(h.app.getHttpServer()).post(`/${INGRESS_PREFIX}/webhooks/providers/${key}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  // The exact bytes as UTF-8 text: given a Buffer with a JSON content type, supertest would
  // JSON-encode the Buffer object itself (and the signature would rightly fail).
  return r.send(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
}

export const delivered = (attemptId: string, extra: Partial<SimulatorReceiptElement> = {}) => ({
  type: 'delivery',
  eventId: `evt-${uuidv7()}`,
  providerMessageId: `sim-${attemptId}`,
  clientReference: attemptId,
  status: 'DELIVERED',
  ...extra,
});

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Removes everything the world planted. Tenants are destroyed by the caller. */
export async function cleanWorld(h: Harness, world: WebhookWorld, orgIds: string[]): Promise<void> {
  if (world.providers.length > 0) {
    await h.admin.execute(
      sql`DELETE FROM webhook_events WHERE provider_id IN (${sql.join(
        world.providers.map((p) => sql`${p}::uuid`),
        sql`, `,
      )})`,
    );
  }
  if (orgIds.length > 0) {
    await h.admin
      .delete(schema.messageDispatchQueue)
      .where(inArray(schema.messageDispatchQueue.orgId, orgIds));
    await h.admin.execute(
      sql`ALTER TABLE message_events DISABLE TRIGGER trg_message_events_immutable`,
    );
    try {
      await h.admin.delete(schema.messageEvents).where(inArray(schema.messageEvents.orgId, orgIds));
    } finally {
      await h.admin.execute(
        sql`ALTER TABLE message_events ENABLE TRIGGER trg_message_events_immutable`,
      );
    }
    await h.admin.execute(sql`ALTER TABLE messages DISABLE TRIGGER USER`);
    try {
      await h.admin.execute(
        sql`UPDATE messages SET delivered_attempt_id = NULL WHERE org_id IN (${sql.join(
          orgIds.map((o) => sql`${o}::uuid`),
          sql`, `,
        )})`,
      );
    } finally {
      await h.admin.execute(sql`ALTER TABLE messages ENABLE TRIGGER USER`);
    }
    await h.admin
      .delete(schema.messageAttempts)
      .where(inArray(schema.messageAttempts.orgId, orgIds));
    await h.admin.delete(schema.messages).where(inArray(schema.messages.orgId, orgIds));
    await h.admin.delete(schema.contacts).where(inArray(schema.contacts.orgId, orgIds));
    await h.admin
      .delete(schema.organizationProviderAssignments)
      .where(inArray(schema.organizationProviderAssignments.orgId, orgIds));
  }
  if (world.providers.length > 0) {
    await h.admin
      .delete(schema.providerCapabilities)
      .where(inArray(schema.providerCapabilities.providerId, world.providers));
    await h.admin.delete(schema.providers).where(inArray(schema.providers.id, world.providers));
  }
}
