-- Strict, rerunnable additive migration for Bird Passport page-one names.
-- Columns remain nullable only so existing passports are not assigned fabricated
-- identity data. Application create/activation rules require real values.
BEGIN;

DO $precheck$
DECLARE
  table_kind "char";
BEGIN
  SELECT c.relkind
  INTO table_kind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'bird_passports';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'public.bird_passports is required before adding name metadata';
  END IF;
  IF table_kind <> 'r' THEN
    RAISE EXCEPTION
      'public.bird_passports has relkind %, expected table',
      table_kind;
  END IF;
END
$precheck$;

ALTER TABLE public.bird_passports
  ADD COLUMN IF NOT EXISTS "ownerFullName" varchar(150) NULL,
  ADD COLUMN IF NOT EXISTS "birdName" varchar(100) NULL;

DO $verify$
DECLARE
  column_name text;
  expected_type text;
  actual_type text;
  is_not_null boolean;
  identity_kind "char";
  generated_kind "char";
  default_expression text;
BEGIN
  FOREACH column_name IN ARRAY ARRAY['ownerFullName', 'birdName'] LOOP
    expected_type := CASE column_name
      WHEN 'ownerFullName' THEN 'character varying(150)'
      WHEN 'birdName' THEN 'character varying(100)'
    END;
    actual_type := NULL;
    is_not_null := NULL;
    identity_kind := NULL;
    generated_kind := NULL;
    default_expression := NULL;

    SELECT
      pg_catalog.format_type(a.atttypid, a.atttypmod),
      a.attnotnull,
      a.attidentity,
      a.attgenerated,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid)
    INTO
      actual_type,
      is_not_null,
      identity_kind,
      generated_kind,
      default_expression
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relname = 'bird_passports'
      AND a.attname = column_name
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'bird_passports.% is missing', column_name;
    END IF;
    IF actual_type IS DISTINCT FROM expected_type
       OR is_not_null IS DISTINCT FROM false
       OR identity_kind IS DISTINCT FROM ''::"char"
       OR generated_kind IS DISTINCT FROM ''::"char"
       OR default_expression IS NOT NULL THEN
      RAISE EXCEPTION
        'bird_passports.% definition mismatch: type=%, not_null=%, identity=%, generated=%, default=%',
        column_name,
        actual_type,
        is_not_null,
        identity_kind,
        generated_kind,
        default_expression;
    END IF;
  END LOOP;
END
$verify$;

COMMIT;
