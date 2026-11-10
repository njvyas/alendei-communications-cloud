-- Phase 8A.2: Contact Import & Export permissions and keyset pagination index.
INSERT INTO permissions (key, domain, action, description, classification, allowed_scope_types) VALUES
  ('contacts.import', 'contacts', 'import',
   'Import contacts, identities and consent records into a workspace', 'tenant_content', '{organization,workspace}'),
  ('contacts.export', 'contacts', 'export',
   'Export contacts, identities and consent records from a workspace', 'tenant_content', '{organization,workspace}')
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

SELECT set_config('app.provisioning', 'on', true);--> statement-breakpoint

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NOT NULL
  AND r.is_system_role
  AND r.key = 'org_admin'
  AND p.key IN ('contacts.import', 'contacts.export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

SELECT set_config('app.provisioning', 'off', true);--> statement-breakpoint

CREATE INDEX "contacts_workspace_id_id_idx" ON "contacts" USING btree ("workspace_id","id");
