-- Strict, rerunnable additive migration for Bird Passport gender.
-- Existing rows receive UNKNOWN through the non-null enum column default.
BEGIN;

DO $precheck$
DECLARE
  table_kind "char";
  gender_type_oid oid;
  gender_type_kind "char";
  gender_labels text[];
BEGIN
  SELECT c.relkind
  INTO table_kind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'bird_passports';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'public.bird_passports is required before adding gender';
  END IF;
  IF table_kind <> 'r' THEN
    RAISE EXCEPTION
      'public.bird_passports has relkind %, expected table',
      table_kind;
  END IF;

  SELECT t.oid, t.typtype
  INTO gender_type_oid, gender_type_kind
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
    AND t.typname = 'bird_passports_gender_enum';

  IF NOT FOUND THEN
    CREATE TYPE public.bird_passports_gender_enum AS ENUM (
      'MALE',
      'FEMALE',
      'UNKNOWN'
    );
    gender_type_oid := 'public.bird_passports_gender_enum'::regtype;
    gender_type_kind := 'e';
  END IF;

  IF gender_type_kind <> 'e' THEN
    RAISE EXCEPTION
      'public.bird_passports_gender_enum has type kind %, expected enum',
      gender_type_kind;
  END IF;

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO gender_labels
  FROM pg_catalog.pg_enum e
  WHERE e.enumtypid = gender_type_oid;

  IF gender_labels IS DISTINCT FROM ARRAY['MALE', 'FEMALE', 'UNKNOWN']::text[] THEN
    RAISE EXCEPTION
      'public.bird_passports_gender_enum labels mismatch: %',
      gender_labels;
  END IF;
END
$precheck$;

ALTER TABLE public.bird_passports
  ADD COLUMN IF NOT EXISTS gender public.bird_passports_gender_enum
  NOT NULL DEFAULT 'UNKNOWN';

DO $verify$
DECLARE
  expected_type_oid oid := 'public.bird_passports_gender_enum'::regtype;
  actual_type_oid oid;
  is_not_null boolean;
  identity_kind "char";
  generated_kind "char";
  default_expression text;
BEGIN
  SELECT
    a.atttypid,
    a.attnotnull,
    a.attidentity,
    a.attgenerated,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid)
  INTO
    actual_type_oid,
    is_not_null,
    identity_kind,
    generated_kind,
    default_expression
  FROM pg_catalog.pg_attribute a
  LEFT JOIN pg_catalog.pg_attrdef d
    ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.bird_passports'::regclass
    AND a.attname = 'gender'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'public.bird_passports.gender is missing';
  END IF;
  IF actual_type_oid IS DISTINCT FROM expected_type_oid
     OR is_not_null IS DISTINCT FROM true
     OR identity_kind IS DISTINCT FROM ''::"char"
     OR generated_kind IS DISTINCT FROM ''::"char"
     OR default_expression !~ '^''UNKNOWN''::(public\.)?bird_passports_gender_enum$' THEN
    RAISE EXCEPTION
      'bird_passports.gender definition mismatch: type=%, not_null=%, identity=%, generated=%, default=%',
      pg_catalog.format_type(actual_type_oid, NULL),
      is_not_null,
      identity_kind,
      generated_kind,
      default_expression;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bird_passports
    WHERE gender IS NULL
       OR gender::text NOT IN ('MALE', 'FEMALE', 'UNKNOWN')
  ) THEN
    RAISE EXCEPTION 'bird_passports contains invalid gender data';
  END IF;
END
$verify$;

COMMIT;
