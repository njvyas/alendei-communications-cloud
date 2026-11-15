-- =============================================================================
-- Migration: 0069_phase8b3_campaign_recipient_unique_guard   (Phase 8B PR 8B-3a)
--
-- GUARD ONLY. This migration never creates, alters or drops anything.
--
-- K1 (PHASE-8B-3-HANDOVER-Rev2 §4.3, owner decision OD-8B3-2), the one-message-per-campaign-
-- recipient backstop:
--
--   uq_messages_campaign_recipient : UNIQUE (org_id, campaign_id, campaign_recipient_id)
--                                    WHERE campaign_recipient_id IS NOT NULL
--
-- must be built with CREATE UNIQUE INDEX CONCURRENTLY, which cannot run inside a transaction,
-- and drizzle applies every pending migration in one transaction. `db:migrate` therefore
-- builds and verifies it AFTER 0068 (which adds the column) and BEFORE this migration (barrier
-- MESSAGES_CAMPAIGN_RECIPIENT_INDEX_BARRIER in packages/db/src/cli/schema-migrate.ts; spec in
-- packages/db/src/maintenance/messages-campaign-recipient.ts). This migration re-checks the
-- catalogue inside the migration transaction and FAILS CLOSED: if the index is absent, not an
-- index, not on public.messages, not unique, differently keyed, ordered, classed or collated,
-- not partial on exactly that predicate, deferrable, an expression index, backing a constraint,
-- not valid/ready/live (an interrupted concurrent build) or duplicated under another name, it
-- raises, the whole transaction rolls back and no history row is recorded.
--
-- Never apply this migration with plain drizzle or `drizzle-kit migrate`, and never regenerate
-- it with `db:generate`. Recover an interrupted build with
--   npm run db:index:messages-campaign-recipient --workspace @acc/db -- --recover-invalid
-- =============================================================================
DO $guard$
DECLARE
  tbl        oid := to_regclass('public.messages');
  org_att    int2;
  camp_att   int2;
  recip_att  int2;
  uuid_opc   oid;
  t          record;
  problems   text[] := ARRAY[]::text[];
  equivalent text;
BEGIN
  IF tbl IS NULL THEN
    RAISE EXCEPTION '8B-3a guard: public.messages does not exist';
  END IF;
  SELECT attnum INTO org_att FROM pg_attribute WHERE attrelid = tbl AND attname = 'org_id' AND NOT attisdropped;
  SELECT attnum INTO camp_att FROM pg_attribute WHERE attrelid = tbl AND attname = 'campaign_id' AND NOT attisdropped;
  SELECT attnum INTO recip_att FROM pg_attribute WHERE attrelid = tbl AND attname = 'campaign_recipient_id' AND NOT attisdropped;
  IF org_att IS NULL OR camp_att IS NULL OR recip_att IS NULL THEN
    RAISE EXCEPTION '8B-3a guard: public.messages lacks org_id, campaign_id or campaign_recipient_id';
  END IF;
  SELECT opc.oid INTO uuid_opc FROM pg_opclass opc JOIN pg_am am ON am.oid = opc.opcmethod
   WHERE am.amname = 'btree' AND opc.opcintype = 'uuid'::regtype AND opc.opcdefault;

  SELECT ic.relkind, ic.relpersistence, (i.indexrelid IS NOT NULL) AS is_index,
         tn.nspname AS table_schema, it.relname AS table_name, am.amname,
         i.indnatts, i.indnkeyatts,
         string_to_array(i.indkey::text, ' ')::int2[] AS keys, string_to_array(i.indoption::text, ' ')::int2[] AS opts,
         string_to_array(i.indclass::text, ' ')::oid[] AS classes, string_to_array(i.indcollation::text, ' ')::oid[] AS colls,
         i.indisunique, i.indisprimary, i.indisexclusion, i.indimmediate,
         (i.indpred IS NOT NULL) AS has_pred, (i.indexprs IS NOT NULL) AS has_exprs,
         i.indisvalid, i.indisready, i.indislive,
         EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ic.oid) AS backs_constraint,
         CASE WHEN i.indexrelid IS NULL THEN NULL ELSE pg_get_indexdef(i.indexrelid) END AS def
    INTO t
    FROM pg_class ic
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    LEFT JOIN pg_index i ON i.indexrelid = ic.oid
    LEFT JOIN pg_class it ON it.oid = i.indrelid
    LEFT JOIN pg_namespace tn ON tn.oid = it.relnamespace
    LEFT JOIN pg_am am ON am.oid = ic.relam
   WHERE n.nspname = 'public' AND ic.relname = 'uq_messages_campaign_recipient';
  IF NOT FOUND THEN
    RAISE EXCEPTION '8B-3a guard: index public.uq_messages_campaign_recipient is absent. db:migrate builds it CONCURRENTLY before this migration; never apply 0069 with plain drizzle.';
  END IF;
  IF NOT t.is_index OR t.relkind <> 'i' THEN
    RAISE EXCEPTION '8B-3a guard: public.uq_messages_campaign_recipient exists but is not an index';
  END IF;
  IF t.table_schema IS DISTINCT FROM 'public' OR t.table_name IS DISTINCT FROM 'messages' THEN problems := array_append(problems, 'not on public.messages'); END IF;
  IF t.amname IS DISTINCT FROM 'btree' THEN problems := array_append(problems, 'access method is not btree'); END IF;
  IF t.indnatts <> 3 OR t.indnkeyatts <> 3 THEN problems := array_append(problems, 'not exactly three key columns (or has INCLUDE columns)'); END IF;
  IF t.keys IS DISTINCT FROM ARRAY[org_att, camp_att, recip_att]::int2[] THEN problems := array_append(problems, 'key columns are not (org_id, campaign_id, campaign_recipient_id)'); END IF;
  IF t.opts IS DISTINCT FROM ARRAY[0, 0, 0]::int2[] THEN problems := array_append(problems, 'sort options are not all ASC'); END IF;
  IF uuid_opc IS NULL OR t.classes IS DISTINCT FROM ARRAY[uuid_opc, uuid_opc, uuid_opc]::oid[] THEN problems := array_append(problems, 'operator classes are not the default uuid btree class'); END IF;
  IF t.colls IS DISTINCT FROM ARRAY[0, 0, 0]::oid[] THEN problems := array_append(problems, 'collations are not [0,0,0]'); END IF;
  IF t.indisunique IS DISTINCT FROM true THEN problems := array_append(problems, 'is not UNIQUE'); END IF;
  IF t.indisprimary IS DISTINCT FROM false THEN problems := array_append(problems, 'is a primary key'); END IF;
  IF t.indisexclusion IS DISTINCT FROM false THEN problems := array_append(problems, 'is an exclusion index'); END IF;
  IF t.indimmediate IS DISTINCT FROM true THEN problems := array_append(problems, 'is not immediate'); END IF;
  IF t.has_pred IS DISTINCT FROM true THEN problems := array_append(problems, 'is not partial'); END IF;
  IF t.has_exprs IS DISTINCT FROM false THEN problems := array_append(problems, 'has expression columns'); END IF;
  IF t.relpersistence IS DISTINCT FROM 'p' THEN problems := array_append(problems, 'is not permanent'); END IF;
  IF t.backs_constraint THEN problems := array_append(problems, 'backs a constraint'); END IF;
  IF t.def IS DISTINCT FROM 'CREATE UNIQUE INDEX uq_messages_campaign_recipient ON public.messages USING btree (org_id, campaign_id, campaign_recipient_id) WHERE (campaign_recipient_id IS NOT NULL)' THEN
    problems := array_append(problems, ('definition is ' || coalesce(t.def, 'NULL')));
  END IF;
  IF t.indisvalid IS DISTINCT FROM true OR t.indisready IS DISTINCT FROM true OR t.indislive IS DISTINCT FROM true THEN
    problems := array_append(problems, format('not usable (indisvalid=%s indisready=%s indislive=%s) — an interrupted concurrent build; recover with npm run db:index:messages-campaign-recipient --workspace @acc/db -- --recover-invalid', t.indisvalid, t.indisready, t.indislive));
  END IF;
  SELECT string_agg(ic.relname, ', ' ORDER BY ic.relname) INTO equivalent
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
   WHERE i.indrelid = tbl AND ic.relname <> 'uq_messages_campaign_recipient'
     AND i.indnkeyatts = 3 AND string_to_array(i.indkey::text, ' ')::int2[] = ARRAY[org_att, camp_att, recip_att]::int2[];
  IF equivalent IS NOT NULL THEN problems := array_append(problems, ('equivalent index under another name: ' || equivalent)); END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION '8B-3a guard: public.uq_messages_campaign_recipient is not as required: %', array_to_string(problems, '; ');
  END IF;
END
$guard$;
