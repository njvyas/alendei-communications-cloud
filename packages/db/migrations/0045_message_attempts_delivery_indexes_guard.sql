-- =============================================================================
-- Migration: 0045_message_attempts_delivery_indexes_guard   (Phase 5.0, M2)
--
-- GUARD ONLY. This migration never creates, alters or drops anything.
--
-- Two UNIQUE indexes on public.message_attempts must be built with CREATE UNIQUE
-- INDEX CONCURRENTLY, which cannot run inside a transaction — and drizzle applies
-- every pending migration in one transaction. `db:migrate` therefore builds and
-- verifies them BEFORE applying this migration (the barrier
-- MESSAGE_ATTEMPTS_DELIVERY_INDEXES_BARRIER in packages/db/src/cli/schema-migrate.ts;
-- specs in packages/db/src/maintenance/message-attempts-delivery.ts), and this
-- migration re-checks the catalogue inside the migration transaction: if either
-- index is absent, invalid, not ready, not live, not unique or differently
-- defined, it raises, the whole transaction rolls back and no history row is
-- recorded.
--
--   message_attempts_provider_message_uq : (provider_id, provider_message_id) WHERE provider_message_id IS NOT NULL
--   uq_message_attempts_id_message_id    : (id, message_id)  — attached as a constraint by 0046
--
-- Never apply this migration with plain drizzle or `drizzle-kit migrate`, and never
-- regenerate it with `db:generate`. Recover an interrupted build with
--   npm run db:index:message-attempts-delivery --workspace @acc/db -- --recover-invalid
-- =============================================================================
DO $guard$
DECLARE
  spec record;
  t    record;
BEGIN
  IF to_regclass('public.message_attempts') IS NULL THEN
    RAISE EXCEPTION 'Phase 5.0 guard: public.message_attempts does not exist';
  END IF;
  FOR spec IN
    SELECT * FROM (VALUES
      ('message_attempts_provider_message_uq',
       'CREATE UNIQUE INDEX message_attempts_provider_message_uq ON public.message_attempts USING btree (provider_id, provider_message_id) WHERE (provider_message_id IS NOT NULL)',
       true),
      ('uq_message_attempts_id_message_id',
       'CREATE UNIQUE INDEX uq_message_attempts_id_message_id ON public.message_attempts USING btree (id, message_id)',
       false)
    ) AS s(name, def, partial)
  LOOP
    SELECT i.indisunique, i.indisvalid, i.indisready, i.indislive, i.indimmediate,
           (i.indpred IS NOT NULL) AS has_pred, (i.indexprs IS NOT NULL) AS has_exprs,
           it.relname AS table_name, pg_get_indexdef(i.indexrelid) AS def
      INTO t
      FROM pg_class ic
      JOIN pg_namespace n ON n.oid = ic.relnamespace
      JOIN pg_index i ON i.indexrelid = ic.oid
      JOIN pg_class it ON it.oid = i.indrelid
     WHERE n.nspname = 'public' AND ic.relname = spec.name;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phase 5.0 guard: index public.% is absent. db:migrate builds it CONCURRENTLY before this migration; never apply 0045 with plain drizzle.', spec.name;
    END IF;
    IF t.table_name IS DISTINCT FROM 'message_attempts' OR t.indisunique IS DISTINCT FROM true
       OR t.indimmediate IS DISTINCT FROM true OR t.has_exprs OR t.has_pred IS DISTINCT FROM spec.partial
       OR t.def IS DISTINCT FROM spec.def THEN
      RAISE EXCEPTION 'Phase 5.0 guard: public.% is not as required (definition is %)', spec.name, coalesce(t.def, 'NULL');
    END IF;
    IF t.indisvalid IS DISTINCT FROM true OR t.indisready IS DISTINCT FROM true OR t.indislive IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Phase 5.0 guard: public.% is not usable (indisvalid=% indisready=% indislive=%) — an interrupted concurrent build; recover with the index runner --recover-invalid', spec.name, t.indisvalid, t.indisready, t.indislive;
    END IF;
  END LOOP;
END
$guard$;
