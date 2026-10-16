#!/usr/bin/env node
/**
 * Isolated Phase 3 E2E test fixture setup script (Gate E.5).
 *
 * Provisions the minimum prerequisites for WhatsApp Management Console E2E tests:
 * 1. Resolves Org A1 (acc-fixture-a1), user a1Admin (a1-admin@acc-fixture.test), and WhatsApp channel.
 * 2. Creates the WhatsApp simulator provider in the catalogue if not present.
 * 3. Associates provider capability simulator_behavior = 'SUCCESS'.
 * 4. Inserts an active organization-provider assignment for Org A1 on the WhatsApp channel.
 * 5. Creates a custom tenant role `acc_fixture_whatsapp_admin` in Org A1 holding Phase 3 permissions
 *    (templates.read, templates.manage, contacts.read, contacts.manage, messages.read, messages.send).
 * 6. Grants `acc_fixture_whatsapp_admin` to a1Admin at organization scope.
 * 7. Grants platform role `acc_fixture_providers_reader` to a1Admin at platform scope so channel resolution succeeds.
 *
 * Does NOT alter frozen system roles (org_admin remains untouched) and preserves canonical RBAC rules.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

async function run() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error('whatsapp-e2e-fixture: DATABASE_ADMIN_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Bypass RLS / platform-admin check during fixture provisioning
    await client.query("SELECT set_config('app.is_platform_admin', 'on', true)");

    // 1. Resolve Organization A1
    const { rows: orgRows } = await client.query(
      "SELECT id FROM organizations WHERE slug = 'acc-fixture-a1' OR name = 'Organization A1' LIMIT 1",
    );
    if (orgRows.length === 0) {
      throw new Error('Organization A1 (acc-fixture-a1) not found');
    }
    const orgId = orgRows[0].id;

    // 2. Resolve User a1Admin
    const { rows: userRows } = await client.query(
      "SELECT id FROM users WHERE email = 'a1-admin@acc-fixture.test' LIMIT 1",
    );
    if (userRows.length === 0) {
      throw new Error('User a1Admin (a1-admin@acc-fixture.test) not found');
    }
    const a1AdminId = userRows[0].id;

    // 3. Resolve WhatsApp Channel
    const { rows: channelRows } = await client.query(
      "SELECT id FROM channels WHERE code = 'whatsapp' LIMIT 1",
    );
    if (channelRows.length === 0) {
      throw new Error('WhatsApp channel not found in channels catalogue');
    }
    const whatsappChannelId = channelRows[0].id;

    // 4. Ensure WhatsApp simulator provider exists
    let providerId;
    const { rows: provRows } = await client.query(
      "SELECT id FROM providers WHERE channel_id = $1 AND name = 'ACC Fixture WhatsApp Primary'",
      [whatsappChannelId],
    );
    if (provRows.length > 0) {
      providerId = provRows[0].id;
    } else {
      const { rows: newProvRows } = await client.query(
        `INSERT INTO providers (
          id, channel_id, name, adapter_key, status, health_state, circuit_state,
          circuit_generation, circuit_probes, circuit_probe_successes
        ) VALUES (
          gen_random_uuid(), $1, 'ACC Fixture WhatsApp Primary', 'simulator', 'active', 'healthy', 'closed',
          0, '[]'::jsonb, 0
        ) RETURNING id`,
        [whatsappChannelId],
      );
      providerId = newProvRows[0].id;
    }

    // 5. Ensure provider capability simulator_behavior = "SUCCESS" exists
    const { rows: capRows } = await client.query(
      "SELECT id FROM provider_capabilities WHERE provider_id = $1 AND capability_key = 'simulator_behavior'",
      [providerId],
    );
    if (capRows.length === 0) {
      await client.query(
        `INSERT INTO provider_capabilities (id, provider_id, capability_key, value)
         VALUES (gen_random_uuid(), $1, 'simulator_behavior', '"SUCCESS"'::jsonb)`,
        [providerId],
      );
    }

    // 6. Ensure active organization-provider assignment exists for Org A1 & WhatsApp channel
    const { rows: assignRows } = await client.query(
      'SELECT id FROM organization_provider_assignments WHERE org_id = $1 AND channel_id = $2',
      [orgId, whatsappChannelId],
    );
    if (assignRows.length === 0) {
      await client.query(
        `INSERT INTO organization_provider_assignments (
          id, org_id, provider_id, channel_id, priority, status
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, 1, 'active'
        )`,
        [orgId, providerId, whatsappChannelId],
      );
    }

    // 7. Ensure custom tenant role acc_fixture_whatsapp_admin exists in Org A1
    let tenantRoleId;
    const { rows: roleRows } = await client.query(
      "SELECT id FROM roles WHERE org_id = $1 AND key = 'acc_fixture_whatsapp_admin'",
      [orgId],
    );
    if (roleRows.length > 0) {
      tenantRoleId = roleRows[0].id;
    } else {
      const { rows: newRoleRows } = await client.query(
        `INSERT INTO roles (
          id, org_id, key, name, description, is_system_role, allowed_scope_types
        ) VALUES (
          gen_random_uuid(), $1, 'acc_fixture_whatsapp_admin', 'ACC Fixture WhatsApp Admin',
          'Grants Phase 3 WhatsApp management permissions', false, ARRAY['organization']::role_scope_type[]
        ) RETURNING id`,
        [orgId],
      );
      tenantRoleId = newRoleRows[0].id;
    }

    // 8. Attach Phase 3 permissions to acc_fixture_whatsapp_admin
    const targetPermKeys = [
      'templates.read',
      'templates.manage',
      'contacts.read',
      'contacts.manage',
      'messages.read',
      'messages.send',
    ];

    for (const permKey of targetPermKeys) {
      const { rows: permRows } = await client.query('SELECT id FROM permissions WHERE key = $1', [
        permKey,
      ]);
      if (permRows.length > 0) {
        const permId = permRows[0].id;
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [tenantRoleId, permId],
        );
      }
    }

    // 9. Grant acc_fixture_whatsapp_admin to a1Admin at organization scope
    const { rows: grantRows } = await client.query(
      `SELECT id FROM user_roles
       WHERE user_id = $1 AND role_id = $2 AND scope_type = 'organization' AND scope_id = $3`,
      [a1AdminId, tenantRoleId, orgId],
    );
    if (grantRows.length === 0) {
      await client.query(
        `INSERT INTO user_roles (id, user_id, role_id, org_id, scope_type, scope_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'organization', $3)`,
        [a1AdminId, tenantRoleId, orgId],
      );
    }

    // 10. Ensure platform role acc_fixture_providers_reader exists and grant to a1Admin at platform scope
    let platRoleId;
    const { rows: platRoleRows } = await client.query(
      "SELECT id FROM roles WHERE org_id IS NULL AND key = 'acc_fixture_providers_reader'",
    );
    if (platRoleRows.length > 0) {
      platRoleId = platRoleRows[0].id;
    } else {
      const { rows: newPlatRoleRows } = await client.query(
        `INSERT INTO roles (
          id, org_id, key, name, description, is_system_role, allowed_scope_types
        ) VALUES (
          gen_random_uuid(), NULL, 'acc_fixture_providers_reader', 'ACC Fixture Providers Reader',
          'Reads channels and providers catalogue', false, ARRAY['platform']::role_scope_type[]
        ) RETURNING id`,
      );
      platRoleId = newPlatRoleRows[0].id;
      const { rows: pRows } = await client.query(
        "SELECT id FROM permissions WHERE key = 'providers.read'",
      );
      if (pRows.length > 0) {
        await client.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [platRoleId, pRows[0].id],
        );
      }
    }

    const { rows: platGrantRows } = await client.query(
      `SELECT id FROM user_roles
       WHERE user_id = $1 AND role_id = $2 AND scope_type = 'platform'`,
      [a1AdminId, platRoleId],
    );
    if (platGrantRows.length === 0) {
      await client.query(
        `INSERT INTO user_roles (id, user_id, role_id, org_id, scope_type, scope_id)
         VALUES (gen_random_uuid(), $1, $2, NULL, 'platform', NULL)`,
        [a1AdminId, platRoleId],
      );
    }

    // 11. Ensure dedicated zero-org user exists for E2E-WA-01
    const { rows: zeroOrgRows } = await client.query(
      "SELECT id FROM users WHERE email = 'zero-org@acc-fixture.test' LIMIT 1",
    );
    if (zeroOrgRows.length === 0) {
      const { rows: a1AdminUser } = await client.query(
        "SELECT password_hash FROM users WHERE email = 'a1-admin@acc-fixture.test' LIMIT 1",
      );
      if (a1AdminUser.length > 0 && a1AdminUser[0].password_hash) {
        await client.query(
          `INSERT INTO users (id, email, password_hash, status, password_updated_at)
           VALUES (gen_random_uuid(), 'zero-org@acc-fixture.test', $1, 'active', now())`,
          [a1AdminUser[0].password_hash],
        );
      }
    }

    await client.query('COMMIT');
    process.stderr.write(
      'whatsapp-e2e-fixture: successfully provisioned WhatsApp provider, assignment, and permissions.\n',
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    process.stderr.write(
      `whatsapp-e2e-fixture error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    throw err;
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
