\set ON_ERROR_STOP on
-- Forward only. Run after the two breeder schema foundation migrations.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:breeder-listing-foundation-v1',0));
DO $preflight$
DECLARE target text; candidate record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bayat_app') THEN
    RAISE EXCEPTION 'Required breeder runtime role is missing';
  END IF;
  FOREACH target IN ARRAY ARRAY['bird_species','bird_subspecies','breeder_species_permissions','breeder_subspecies_permissions','breeder_permission_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||target) AND relkind='r') THEN
      RAISE EXCEPTION 'Required breeder foundation table is missing';
    END IF;
    -- NOINHERIT does not prevent SET ROLE. Fail closed on destructive
    -- privileges or ownership through any direct/indirect membership path.
    FOR candidate IN SELECT oid FROM pg_roles WHERE pg_has_role('bayat_app',oid,'MEMBER') LOOP
      IF candidate.oid=(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.'||target))
        OR has_table_privilege(candidate.oid,to_regclass('public.'||target),'DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR (target='breeder_permission_events' AND has_table_privilege(candidate.oid,to_regclass('public.'||target),'UPDATE')) THEN
        RAISE EXCEPTION 'Unexpected destructive breeder runtime privileges';
      END IF;
    END LOOP;
  END LOOP;
END $preflight$;
GRANT USAGE ON SCHEMA public TO bayat_app;
GRANT SELECT, INSERT, UPDATE ON public.bird_species, public.bird_subspecies,
  public.breeder_species_permissions, public.breeder_subspecies_permissions TO bayat_app;
GRANT SELECT, INSERT ON public.breeder_permission_events TO bayat_app;
GRANT EXECUTE ON FUNCTION public.guard_breeder_identity_v1(),
  public.guard_breeder_event_append_only_v1(), public.assert_breeder_permission_audit_v1(),
  public.assert_breeder_event_chain_v1(), public.guard_listing_submission_identity_v1(),
  public.assert_listing_submission_pair_v1() TO bayat_app;
COMMIT;
