-- Strict, rerunnable base-schema migration for bird passports.
-- Existing objects are accepted only when their definitions match exactly.
-- This migration never repairs data, advances/resets the code sequence, or
-- modifies existing application rows.
BEGIN;

DO $precheck$
DECLARE
  object_name text;
  object_kind "char";
BEGIN
  IF to_regprocedure('public.uuid_generate_v4()') IS NULL
     AND to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'uuid_generate_v4() is required by the project UUID convention';
  END IF;

  SELECT c.relkind
  INTO object_kind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'bird_passport_code_seq';

  IF FOUND AND object_kind <> 'S' THEN
    RAISE EXCEPTION
      'public.bird_passport_code_seq exists with relkind %, expected sequence',
      object_kind;
  END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'bird_passports',
    'bird_vaccine_records',
    'bird_feeding_records',
    'bird_veterinary_visits',
    'bird_passport_otps'
  ] LOOP
    SELECT c.relkind
    INTO object_kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = object_name;

    IF FOUND AND object_kind <> 'r' THEN
      RAISE EXCEPTION 'public.% exists with relkind %, expected table', object_name, object_kind;
    END IF;
  END LOOP;
END
$precheck$;

CREATE SEQUENCE IF NOT EXISTS public.bird_passport_code_seq
  AS bigint
  START WITH 25543210
  INCREMENT BY 1
  MINVALUE 25543210
  MAXVALUE 99999999
  NO CYCLE;

DO $enum$
DECLARE
  enum_kind "char";
  enum_labels text[];
BEGIN
  SELECT t.typtype
  INTO enum_kind
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname = 'bird_passports_status_enum';

  IF NOT FOUND THEN
    CREATE TYPE public.bird_passports_status_enum AS ENUM ('draft', 'active', 'archived');
  ELSIF enum_kind <> 'e' THEN
    RAISE EXCEPTION
      'public.bird_passports_status_enum exists with typtype %, expected enum',
      enum_kind;
  END IF;

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO enum_labels
  FROM pg_catalog.pg_enum e
  WHERE e.enumtypid = 'public.bird_passports_status_enum'::regtype;

  IF enum_labels IS DISTINCT FROM ARRAY['draft', 'active', 'archived'] THEN
    RAISE EXCEPTION 'bird passport status enum labels/order mismatch: %', enum_labels;
  END IF;
END
$enum$;

CREATE TABLE IF NOT EXISTS public.bird_passports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code varchar(9) NOT NULL,
  "ownerMobile" varchar(11) NOT NULL,
  "imagePath" text NULL,
  "birthDate" date NOT NULL,
  species varchar NOT NULL,
  subspecies varchar NOT NULL,
  status public.bird_passports_status_enum NOT NULL DEFAULT 'draft',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_bird_passports_code" UNIQUE (code),
  CONSTRAINT "CHK_bird_passports_code_format" CHECK (code ~ '^B[0-9]{8}$'),
  CONSTRAINT "CHK_bird_passports_owner_mobile_format" CHECK ("ownerMobile" ~ '^09[0-9]{9}$')
);

CREATE TABLE IF NOT EXISTS public.bird_vaccine_records (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "passportId" uuid NOT NULL,
  "vaccineName" varchar NOT NULL,
  "vaccinationDate" date NOT NULL,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "FK_bird_vaccine_records_passport"
    FOREIGN KEY ("passportId") REFERENCES public.bird_passports(id) ON DELETE CASCADE,
  CONSTRAINT "CHK_bird_vaccine_records_sort_order" CHECK ("sortOrder" >= 0)
);

CREATE TABLE IF NOT EXISTS public.bird_feeding_records (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "passportId" uuid NOT NULL,
  "ageRange" varchar NOT NULL,
  description text NOT NULL,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "FK_bird_feeding_records_passport"
    FOREIGN KEY ("passportId") REFERENCES public.bird_passports(id) ON DELETE CASCADE,
  CONSTRAINT "CHK_bird_feeding_records_sort_order" CHECK ("sortOrder" >= 0)
);

CREATE TABLE IF NOT EXISTS public.bird_veterinary_visits (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "passportId" uuid NOT NULL,
  "visitDate" date NOT NULL,
  "clinicalNotes" text NOT NULL,
  "veterinaryActions" text NOT NULL,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "FK_bird_veterinary_visits_passport"
    FOREIGN KEY ("passportId") REFERENCES public.bird_passports(id) ON DELETE CASCADE,
  CONSTRAINT "CHK_bird_veterinary_visits_sort_order" CHECK ("sortOrder" >= 0)
);

CREATE TABLE IF NOT EXISTS public.bird_passport_otps (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "birdPassportId" uuid NOT NULL,
  phone varchar(11) NOT NULL,
  purpose varchar NOT NULL DEFAULT 'bird-passport-lookup',
  "codeHash" varchar NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "FK_bird_passport_otps_passport"
    FOREIGN KEY ("birdPassportId") REFERENCES public.bird_passports(id) ON DELETE CASCADE,
  CONSTRAINT "CHK_bird_passport_otps_phone_format" CHECK (phone ~ '^09[0-9]{9}$'),
  CONSTRAINT "CHK_bird_passport_otps_attempts" CHECK (attempts >= 0),
  CONSTRAINT "CHK_bird_passport_otps_purpose" CHECK (purpose = 'bird-passport-lookup')
);

CREATE INDEX IF NOT EXISTS "IDX_bird_passports_status"
  ON public.bird_passports USING btree (status);
CREATE INDEX IF NOT EXISTS "IDX_bird_vaccine_records_passport_sort"
  ON public.bird_vaccine_records USING btree ("passportId", "sortOrder");
CREATE INDEX IF NOT EXISTS "IDX_bird_feeding_records_passport_sort"
  ON public.bird_feeding_records USING btree ("passportId", "sortOrder");
CREATE INDEX IF NOT EXISTS "IDX_bird_veterinary_visits_passport_sort"
  ON public.bird_veterinary_visits USING btree ("passportId", "sortOrder");
CREATE INDEX IF NOT EXISTS "IDX_bird_veterinary_visits_passport_date"
  ON public.bird_veterinary_visits USING btree ("passportId", "visitDate");
CREATE INDEX IF NOT EXISTS "IDX_bird_passport_otps_lookup"
  ON public.bird_passport_otps USING btree
    ("birdPassportId", phone, consumed, "createdAt");
CREATE INDEX IF NOT EXISTS "IDX_bird_passport_otps_expiry"
  ON public.bird_passport_otps USING btree ("expiresAt");

DO $function_creation$
DECLARE
  matching_functions integer;
  function_return regtype;
  function_language text;
  function_arguments text;
  function_source text;
  function_volatility "char";
  function_security_definer boolean;
  function_strict boolean;
BEGIN
  SELECT COUNT(*)
  INTO matching_functions
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reject_bird_passport_code_update';

  IF matching_functions = 0 THEN
    EXECUTE $create_function$
      CREATE FUNCTION public.reject_bird_passport_code_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      BEGIN
        IF NEW.code IS DISTINCT FROM OLD.code THEN
          RAISE EXCEPTION 'bird passport code is immutable'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $body$
    $create_function$;
  ELSIF matching_functions <> 1 THEN
    RAISE EXCEPTION
      'public.reject_bird_passport_code_update has % overloads; expected one zero-argument function',
      matching_functions;
  ELSE
    SELECT
      p.prorettype::regtype,
      l.lanname,
      pg_catalog.pg_get_function_identity_arguments(p.oid),
      p.prosrc,
      p.provolatile,
      p.prosecdef,
      p.proisstrict
    INTO
      function_return, function_language, function_arguments, function_source,
      function_volatility, function_security_definer, function_strict
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND p.proname = 'reject_bird_passport_code_update';

    IF function_return <> 'trigger'::regtype
       OR function_language <> 'plpgsql'
       OR function_arguments <> ''
       OR function_volatility <> 'v'
       OR function_security_definer
       OR function_strict
       OR regexp_replace(function_source, '\s+', '', 'g')
          <> regexp_replace($expected_source$
            BEGIN
              IF NEW.code IS DISTINCT FROM OLD.code THEN
                RAISE EXCEPTION 'bird passport code is immutable'
                  USING ERRCODE = 'check_violation';
              END IF;
              RETURN NEW;
            END;
          $expected_source$, '\s+', '', 'g') THEN
      RAISE EXCEPTION 'public.reject_bird_passport_code_update() definition mismatch';
    END IF;
  END IF;
END
$function_creation$;

DO $trigger_creation$
DECLARE
  trigger_count integer;
BEGIN
  SELECT COUNT(*)
  INTO trigger_count
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.bird_passports'::regclass
    AND t.tgname = 'TRG_bird_passports_code_immutable'
    AND NOT t.tgisinternal;

  IF trigger_count = 0 THEN
    CREATE TRIGGER "TRG_bird_passports_code_immutable"
    BEFORE UPDATE OF code ON public.bird_passports
    FOR EACH ROW
    EXECUTE FUNCTION public.reject_bird_passport_code_update();
  ELSIF trigger_count <> 1 THEN
    RAISE EXCEPTION 'bird passport immutability trigger count mismatch: %', trigger_count;
  END IF;
END
$trigger_creation$;

DO $strict_verification$
DECLARE
  column_spec jsonb;
  table_spec jsonb;
  expected_columns jsonb := jsonb_build_array(
    jsonb_build_object('table','bird_passports','columns',jsonb_build_array(
      jsonb_build_array('id','uuid',-1,true,'uuid_generate_v4()'),
      jsonb_build_array('code','character varying',13,true,NULL),
      jsonb_build_array('ownerMobile','character varying',15,true,NULL),
      jsonb_build_array('imagePath','text',-1,false,NULL),
      jsonb_build_array('birthDate','date',-1,true,NULL),
      jsonb_build_array('species','character varying',-1,true,NULL),
      jsonb_build_array('subspecies','character varying',-1,true,NULL),
      jsonb_build_array('status','bird_passports_status_enum',-1,true,'''draft''::bird_passports_status_enum'),
      jsonb_build_array('createdAt','timestamp with time zone',-1,true,'now()'),
      jsonb_build_array('updatedAt','timestamp with time zone',-1,true,'now()')
    )),
    jsonb_build_object('table','bird_vaccine_records','columns',jsonb_build_array(
      jsonb_build_array('id','uuid',-1,true,'uuid_generate_v4()'),
      jsonb_build_array('passportId','uuid',-1,true,NULL),
      jsonb_build_array('vaccineName','character varying',-1,true,NULL),
      jsonb_build_array('vaccinationDate','date',-1,true,NULL),
      jsonb_build_array('sortOrder','integer',-1,true,'0'),
      jsonb_build_array('createdAt','timestamp with time zone',-1,true,'now()'),
      jsonb_build_array('updatedAt','timestamp with time zone',-1,true,'now()')
    )),
    jsonb_build_object('table','bird_feeding_records','columns',jsonb_build_array(
      jsonb_build_array('id','uuid',-1,true,'uuid_generate_v4()'),
      jsonb_build_array('passportId','uuid',-1,true,NULL),
      jsonb_build_array('ageRange','character varying',-1,true,NULL),
      jsonb_build_array('description','text',-1,true,NULL),
      jsonb_build_array('sortOrder','integer',-1,true,'0'),
      jsonb_build_array('createdAt','timestamp with time zone',-1,true,'now()'),
      jsonb_build_array('updatedAt','timestamp with time zone',-1,true,'now()')
    )),
    jsonb_build_object('table','bird_veterinary_visits','columns',jsonb_build_array(
      jsonb_build_array('id','uuid',-1,true,'uuid_generate_v4()'),
      jsonb_build_array('passportId','uuid',-1,true,NULL),
      jsonb_build_array('visitDate','date',-1,true,NULL),
      jsonb_build_array('clinicalNotes','text',-1,true,NULL),
      jsonb_build_array('veterinaryActions','text',-1,true,NULL),
      jsonb_build_array('sortOrder','integer',-1,true,'0'),
      jsonb_build_array('createdAt','timestamp with time zone',-1,true,'now()'),
      jsonb_build_array('updatedAt','timestamp with time zone',-1,true,'now()')
    )),
    jsonb_build_object('table','bird_passport_otps','columns',jsonb_build_array(
      jsonb_build_array('id','uuid',-1,true,'uuid_generate_v4()'),
      jsonb_build_array('birdPassportId','uuid',-1,true,NULL),
      jsonb_build_array('phone','character varying',15,true,NULL),
      jsonb_build_array('purpose','character varying',-1,true,'''bird-passport-lookup''::character varying'),
      jsonb_build_array('codeHash','character varying',-1,true,NULL),
      jsonb_build_array('expiresAt','timestamp with time zone',-1,true,NULL),
      jsonb_build_array('attempts','integer',-1,true,'0'),
      jsonb_build_array('consumed','boolean',-1,true,'false'),
      jsonb_build_array('createdAt','timestamp with time zone',-1,true,'now()')
    ))
  );
  actual_type text;
  actual_type_oid oid;
  actual_typmod integer;
  actual_not_null boolean;
  actual_default text;
  expected_default text;
  actual_column_count integer;
  expected_column_count integer;
  sequence_kind "char";
  sequence_type regtype;
  sequence_start bigint;
  sequence_increment bigint;
  sequence_min bigint;
  sequence_max bigint;
  sequence_cycle boolean;
  sequence_last bigint;
  sequence_called boolean;
  next_allocatable numeric;
  max_existing_code bigint;
  code_attribute smallint;
  trigger_function oid;
  expected_trigger_function oid;
  trigger_type smallint;
  trigger_attributes text;
  trigger_enabled "char";
  user_trigger_count integer;
BEGIN
  FOR table_spec IN SELECT value FROM jsonb_array_elements(expected_columns) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = table_spec->>'table'
        AND c.relkind = 'r'
        AND c.relpersistence = 'p'
    ) THEN
      RAISE EXCEPTION 'public.% is missing or is not a table', table_spec->>'table';
    END IF;

    SELECT COUNT(*)
    INTO actual_column_count
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = format('public.%I', table_spec->>'table')::regclass
      AND a.attnum > 0 AND NOT a.attisdropped;
    expected_column_count := jsonb_array_length(table_spec->'columns');
    IF actual_column_count <> expected_column_count THEN
      RAISE EXCEPTION
        'public.% column count mismatch: expected %, found %',
        table_spec->>'table', expected_column_count, actual_column_count;
    END IF;

    FOR column_spec IN SELECT value FROM jsonb_array_elements(table_spec->'columns') LOOP
      SELECT
        pg_catalog.format_type(a.atttypid, NULL),
        a.atttypid,
        a.atttypmod,
        a.attnotnull,
        pg_catalog.pg_get_expr(d.adbin, d.adrelid)
      INTO actual_type, actual_type_oid, actual_typmod, actual_not_null, actual_default
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d
        ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = format('public.%I', table_spec->>'table')::regclass
        AND a.attname = column_spec->>0
        AND a.attnum > 0 AND NOT a.attisdropped;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'public.%.% is missing', table_spec->>'table', column_spec->>0;
      END IF;

      expected_default := column_spec->>4;
      IF (
           column_spec->>1 = 'bird_passports_status_enum'
           AND actual_type_oid <> 'public.bird_passports_status_enum'::regtype
         )
         OR (
           column_spec->>1 <> 'bird_passports_status_enum'
           AND actual_type <> column_spec->>1
         )
         OR actual_typmod <> (column_spec->>2)::integer
         OR actual_not_null <> (column_spec->>3)::boolean
         OR regexp_replace(
              replace(COALESCE(actual_default, ''), 'public.', ''),
              '\s+', '', 'g'
            )
            <> regexp_replace(
              replace(COALESCE(expected_default, ''), 'public.', ''),
              '\s+', '', 'g'
            ) THEN
        RAISE EXCEPTION
          'public.%.% definition mismatch (type=%, typmod=%, notnull=%, default=%)',
          table_spec->>'table', column_spec->>0,
          actual_type, actual_typmod, actual_not_null, actual_default;
      END IF;
    END LOOP;
  END LOOP;

  SELECT c.relkind
  INTO sequence_kind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'bird_passport_code_seq';
  IF sequence_kind IS DISTINCT FROM 'S' THEN
    RAISE EXCEPTION 'public.bird_passport_code_seq is missing or is not a sequence';
  END IF;

  SELECT s.seqtypid::regtype, s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcycle
  INTO sequence_type, sequence_start, sequence_increment, sequence_min, sequence_max, sequence_cycle
  FROM pg_catalog.pg_sequence s
  WHERE s.seqrelid = 'public.bird_passport_code_seq'::regclass;
  IF NOT FOUND
     OR sequence_type <> 'bigint'::regtype
     OR sequence_start <> 25543210
     OR sequence_increment <> 1
     OR sequence_min <> 25543210
     OR sequence_max <> 99999999
     OR sequence_cycle THEN
    RAISE EXCEPTION 'public.bird_passport_code_seq configuration mismatch';
  END IF;

  EXECUTE 'SELECT last_value, is_called FROM public.bird_passport_code_seq'
  INTO sequence_last, sequence_called;
  IF sequence_last < sequence_min OR sequence_last > sequence_max THEN
    RAISE EXCEPTION 'bird passport sequence position % is outside configured bounds', sequence_last;
  END IF;

  SELECT MAX(substring(code FROM 2)::bigint)
  INTO max_existing_code
  FROM public.bird_passports
  WHERE code ~ '^B[0-9]{8}$';

  IF NOT sequence_called THEN
    next_allocatable := sequence_last;
  ELSIF sequence_last <= sequence_max - sequence_increment THEN
    next_allocatable := sequence_last + sequence_increment;
  ELSE
    next_allocatable := NULL;
  END IF;

  IF max_existing_code IS NOT NULL
     AND next_allocatable IS NOT NULL
     AND next_allocatable <= max_existing_code THEN
    RAISE EXCEPTION
      'bird passport sequence is behind existing codes: next %, maximum code %',
      next_allocatable, max_existing_code;
  END IF;

  IF max_existing_code IS NOT NULL
     AND next_allocatable IS NULL
     AND NOT (sequence_called AND sequence_last = sequence_max) THEN
    RAISE EXCEPTION 'bird passport sequence has an invalid exhausted position';
  END IF;

  SELECT a.attnum
  INTO code_attribute
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.bird_passports'::regclass
    AND a.attname = 'code' AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT p.oid
  INTO expected_trigger_function
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'reject_bird_passport_code_update'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = '';

  SELECT t.tgfoid, t.tgtype, t.tgattr::text, t.tgenabled
  INTO trigger_function, trigger_type, trigger_attributes, trigger_enabled
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.bird_passports'::regclass
    AND t.tgname = 'TRG_bird_passports_code_immutable'
    AND NOT t.tgisinternal;

  IF NOT FOUND
     OR trigger_function <> expected_trigger_function
     OR trigger_type <> 19
     OR trigger_attributes <> code_attribute::text
     OR trigger_enabled <> 'O' THEN
    RAISE EXCEPTION 'bird passport code immutability trigger definition mismatch';
  END IF;

  SELECT COUNT(*)
  INTO user_trigger_count
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.bird_passports'::regclass
    AND NOT t.tgisinternal;
  IF user_trigger_count <> 1 THEN
    RAISE EXCEPTION
      'public.bird_passports user trigger set mismatch: expected 1, found %',
      user_trigger_count;
  END IF;
END
$strict_verification$;

DO $constraint_fk_index_verification$
DECLARE
  spec jsonb;
  constraint_oid oid;
  actual_definition text;
  normalized_actual text;
  normalized_expected text;
  source_column smallint;
  target_column smallint;
  index_oid oid;
  index_method text;
  index_unique boolean;
  index_columns text[];
  index_valid boolean;
  index_ready boolean;
  index_live boolean;
  index_default_ordering boolean;
  index_column_collations boolean;
  index_default_opclasses boolean;
  code_unique_index_count integer;
  owner_mobile_index_count integer;
  actual_name_count integer;
  expected_name_count integer;
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','bird_passports'),
    jsonb_build_object('table','bird_vaccine_records'),
    jsonb_build_object('table','bird_feeding_records'),
    jsonb_build_object('table','bird_veterinary_visits'),
    jsonb_build_object('table','bird_passport_otps')
  )) LOOP
    PERFORM 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = format('public.%I', spec->>'table')::regclass
      AND c.contype = 'p'
      AND c.conkey = ARRAY[(
        SELECT a.attnum
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attname = 'id'
      )]::smallint[];
    IF NOT FOUND THEN
      RAISE EXCEPTION 'public.% primary key must be exactly (id)', spec->>'table';
    END IF;
  END LOOP;

  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','bird_passports','name','CHK_bird_passports_code_format','type','c','definition','CHECK(code~''^B[0-9]{8}$'')'),
    jsonb_build_object('table','bird_passports','name','CHK_bird_passports_owner_mobile_format','type','c','definition','CHECK(ownerMobile~''^09[0-9]{9}$'')'),
    jsonb_build_object('table','bird_vaccine_records','name','CHK_bird_vaccine_records_sort_order','type','c','definition','CHECK(sortOrder>=0)'),
    jsonb_build_object('table','bird_feeding_records','name','CHK_bird_feeding_records_sort_order','type','c','definition','CHECK(sortOrder>=0)'),
    jsonb_build_object('table','bird_veterinary_visits','name','CHK_bird_veterinary_visits_sort_order','type','c','definition','CHECK(sortOrder>=0)'),
    jsonb_build_object('table','bird_passport_otps','name','CHK_bird_passport_otps_phone_format','type','c','definition','CHECK(phone~''^09[0-9]{9}$'')'),
    jsonb_build_object('table','bird_passport_otps','name','CHK_bird_passport_otps_attempts','type','c','definition','CHECK(attempts>=0)'),
    jsonb_build_object('table','bird_passport_otps','name','CHK_bird_passport_otps_purpose','type','c','definition','CHECK(purpose=''bird-passport-lookup'')')
  )) LOOP
    SELECT c.oid, pg_catalog.pg_get_constraintdef(c.oid, false)
    INTO constraint_oid, actual_definition
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = format('public.%I', spec->>'table')::regclass
      AND c.conname = spec->>'name'
      AND c.contype = (spec->>'type')::"char"
      AND c.convalidated;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'constraint public.%.% is missing or has the wrong type', spec->>'table', spec->>'name';
    END IF;

    normalized_actual := regexp_replace(actual_definition, '[\s()"]|::text|::character varying', '', 'g');
    normalized_expected := regexp_replace(spec->>'definition', '[\s()"]', '', 'g');
    IF normalized_actual <> normalized_expected THEN
      RAISE EXCEPTION 'constraint public.%.% definition mismatch: %', spec->>'table', spec->>'name', actual_definition;
    END IF;
  END LOOP;

  SELECT c.oid
  INTO constraint_oid
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.bird_passports'::regclass
    AND c.conname = 'UQ_bird_passports_code'
    AND c.contype = 'u'
    AND c.convalidated
    AND NOT c.condeferrable
    AND NOT c.condeferred
    AND c.conkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = c.conrelid AND attname = 'code')]::smallint[];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UQ_bird_passports_code is missing or does not uniquely constrain code';
  END IF;

  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','bird_vaccine_records','name','FK_bird_vaccine_records_passport','column','passportId'),
    jsonb_build_object('table','bird_feeding_records','name','FK_bird_feeding_records_passport','column','passportId'),
    jsonb_build_object('table','bird_veterinary_visits','name','FK_bird_veterinary_visits_passport','column','passportId'),
    jsonb_build_object('table','bird_passport_otps','name','FK_bird_passport_otps_passport','column','birdPassportId')
  )) LOOP
    SELECT a.attnum INTO source_column
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = format('public.%I', spec->>'table')::regclass
      AND a.attname = spec->>'column';
    SELECT a.attnum INTO target_column
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.bird_passports'::regclass AND a.attname = 'id';

    PERFORM 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = format('public.%I', spec->>'table')::regclass
      AND c.conname = spec->>'name'
      AND c.contype = 'f'
      AND c.confrelid = 'public.bird_passports'::regclass
      AND c.conkey = ARRAY[source_column]::smallint[]
      AND c.confkey = ARRAY[target_column]::smallint[]
      AND c.confdeltype = 'c'
      AND c.confupdtype = 'a'
      AND c.confmatchtype = 's'
      AND c.convalidated
      AND NOT c.condeferrable
      AND NOT c.condeferred;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'foreign key public.%.% definition mismatch', spec->>'table', spec->>'name';
    END IF;
  END LOOP;

  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','bird_passports','name','IDX_bird_passports_status','unique',false,'columns',jsonb_build_array('status')),
    jsonb_build_object('table','bird_vaccine_records','name','IDX_bird_vaccine_records_passport_sort','unique',false,'columns',jsonb_build_array('passportId','sortOrder')),
    jsonb_build_object('table','bird_feeding_records','name','IDX_bird_feeding_records_passport_sort','unique',false,'columns',jsonb_build_array('passportId','sortOrder')),
    jsonb_build_object('table','bird_veterinary_visits','name','IDX_bird_veterinary_visits_passport_sort','unique',false,'columns',jsonb_build_array('passportId','sortOrder')),
    jsonb_build_object('table','bird_veterinary_visits','name','IDX_bird_veterinary_visits_passport_date','unique',false,'columns',jsonb_build_array('passportId','visitDate')),
    jsonb_build_object('table','bird_passport_otps','name','IDX_bird_passport_otps_lookup','unique',false,'columns',jsonb_build_array('birdPassportId','phone','consumed','createdAt')),
    jsonb_build_object('table','bird_passport_otps','name','IDX_bird_passport_otps_expiry','unique',false,'columns',jsonb_build_array('expiresAt'))
  )) LOOP
    SELECT
      i.indexrelid,
      am.amname,
      i.indisunique,
      array_agg(a.attname ORDER BY key.ordinality),
      i.indisvalid,
      i.indisready,
      i.indislive,
      bool_and(i.indoption[key.ordinality::integer - 1] = 0),
      bool_and(
        i.indcollation[key.ordinality::integer - 1] = a.attcollation
      ),
      bool_and(opclass.opcdefault)
    INTO
      index_oid, index_method, index_unique, index_columns,
      index_valid, index_ready, index_live,
      index_default_ordering, index_column_collations,
      index_default_opclasses
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid = ic.relam
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
    JOIN pg_catalog.pg_opclass opclass
      ON opclass.oid = i.indclass[key.ordinality::integer - 1]
     AND opclass.opcmethod = ic.relam
    WHERE i.indrelid = format('public.%I', spec->>'table')::regclass
      AND ic.relname = spec->>'name'
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = jsonb_array_length(spec->'columns')
      AND i.indnatts = jsonb_array_length(spec->'columns')
    GROUP BY
      i.indexrelid, am.amname, i.indisunique,
      i.indisvalid, i.indisready, i.indislive;

    IF NOT FOUND
       OR index_method <> 'btree'
       OR index_unique <> (spec->>'unique')::boolean
       OR NOT index_valid
       OR NOT index_ready
       OR NOT index_live
       OR NOT index_default_ordering
       OR NOT index_column_collations
       OR NOT index_default_opclasses
       OR index_columns <> ARRAY(
         SELECT expected.value
         FROM jsonb_array_elements_text(spec->'columns')
           WITH ORDINALITY AS expected(value, ordinality)
         ORDER BY expected.ordinality
       ) THEN
      RAISE EXCEPTION 'index public.% definition mismatch', spec->>'name';
    END IF;
  END LOOP;

  SELECT COUNT(*)
  INTO code_unique_index_count
  FROM pg_catalog.pg_index i
  WHERE i.indrelid = 'public.bird_passports'::regclass
    AND i.indisunique AND NOT i.indisprimary
    AND i.indnkeyatts = 1
    AND i.indkey::text = (SELECT attnum::text FROM pg_catalog.pg_attribute WHERE attrelid = i.indrelid AND attname = 'code');
  IF code_unique_index_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one unique code index, found %', code_unique_index_count;
  END IF;

  SELECT COUNT(*)
  INTO owner_mobile_index_count
  FROM pg_catalog.pg_index i
  WHERE i.indrelid = 'public.bird_passports'::regclass
    AND i.indnkeyatts = 1
    AND i.indkey::text = (SELECT attnum::text FROM pg_catalog.pg_attribute WHERE attrelid = i.indrelid AND attname = 'ownerMobile');
  IF owner_mobile_index_count <> 0 THEN
    RAISE EXCEPTION 'ownerMobile must not have a standalone index';
  END IF;

  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','bird_passports','constraints',jsonb_build_array('bird_passports_pkey','UQ_bird_passports_code','CHK_bird_passports_code_format','CHK_bird_passports_owner_mobile_format'),'indexes',jsonb_build_array('bird_passports_pkey','UQ_bird_passports_code','IDX_bird_passports_status')),
    jsonb_build_object('table','bird_vaccine_records','constraints',jsonb_build_array('bird_vaccine_records_pkey','FK_bird_vaccine_records_passport','CHK_bird_vaccine_records_sort_order'),'indexes',jsonb_build_array('bird_vaccine_records_pkey','IDX_bird_vaccine_records_passport_sort')),
    jsonb_build_object('table','bird_feeding_records','constraints',jsonb_build_array('bird_feeding_records_pkey','FK_bird_feeding_records_passport','CHK_bird_feeding_records_sort_order'),'indexes',jsonb_build_array('bird_feeding_records_pkey','IDX_bird_feeding_records_passport_sort')),
    jsonb_build_object('table','bird_veterinary_visits','constraints',jsonb_build_array('bird_veterinary_visits_pkey','FK_bird_veterinary_visits_passport','CHK_bird_veterinary_visits_sort_order'),'indexes',jsonb_build_array('bird_veterinary_visits_pkey','IDX_bird_veterinary_visits_passport_sort','IDX_bird_veterinary_visits_passport_date')),
    jsonb_build_object('table','bird_passport_otps','constraints',jsonb_build_array('bird_passport_otps_pkey','FK_bird_passport_otps_passport','CHK_bird_passport_otps_phone_format','CHK_bird_passport_otps_attempts','CHK_bird_passport_otps_purpose'),'indexes',jsonb_build_array('bird_passport_otps_pkey','IDX_bird_passport_otps_lookup','IDX_bird_passport_otps_expiry'))
  )) LOOP
    SELECT COUNT(*)
    INTO actual_name_count
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = format('public.%I', spec->>'table')::regclass;
    expected_name_count := jsonb_array_length(spec->'constraints');
    IF actual_name_count <> expected_name_count
       OR EXISTS (
         (SELECT c.conname::text COLLATE "C"
          FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = format('public.%I', spec->>'table')::regclass)
         EXCEPT
         (SELECT expected.value COLLATE "C"
          FROM jsonb_array_elements_text(spec->'constraints') AS expected(value))
       )
       OR EXISTS (
         (SELECT expected.value COLLATE "C"
          FROM jsonb_array_elements_text(spec->'constraints') AS expected(value))
         EXCEPT
         (SELECT c.conname::text COLLATE "C"
          FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = format('public.%I', spec->>'table')::regclass)
       ) THEN
      RAISE EXCEPTION
        'public.% constraint set mismatch: expected % names, found %',
        spec->>'table', expected_name_count, actual_name_count;
    END IF;

    SELECT COUNT(*)
    INTO actual_name_count
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = format('public.%I', spec->>'table')::regclass;
    expected_name_count := jsonb_array_length(spec->'indexes');
    IF actual_name_count <> expected_name_count
       OR EXISTS (
         (SELECT ic.relname::text COLLATE "C"
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = format('public.%I', spec->>'table')::regclass)
         EXCEPT
         (SELECT expected.value COLLATE "C"
          FROM jsonb_array_elements_text(spec->'indexes') AS expected(value))
       )
       OR EXISTS (
         (SELECT expected.value COLLATE "C"
          FROM jsonb_array_elements_text(spec->'indexes') AS expected(value))
         EXCEPT
         (SELECT ic.relname::text COLLATE "C"
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = format('public.%I', spec->>'table')::regclass)
       ) THEN
      RAISE EXCEPTION
        'public.% index set mismatch: expected % names, found %',
        spec->>'table', expected_name_count, actual_name_count;
    END IF;
  END LOOP;
END
$constraint_fk_index_verification$;

DO $existing_data_verification$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bird_passports
    WHERE code !~ '^B[0-9]{8}$'
       OR "ownerMobile" !~ '^09[0-9]{9}$'
       OR status::text NOT IN ('draft', 'active', 'archived')
  ) THEN
    RAISE EXCEPTION 'bird_passports contains invalid code, ownerMobile, or status data';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bird_vaccine_records child
    LEFT JOIN public.bird_passports parent ON parent.id = child."passportId"
    WHERE parent.id IS NULL OR child."sortOrder" < 0
  ) OR EXISTS (
    SELECT 1 FROM public.bird_feeding_records child
    LEFT JOIN public.bird_passports parent ON parent.id = child."passportId"
    WHERE parent.id IS NULL OR child."sortOrder" < 0
  ) OR EXISTS (
    SELECT 1 FROM public.bird_veterinary_visits child
    LEFT JOIN public.bird_passports parent ON parent.id = child."passportId"
    WHERE parent.id IS NULL OR child."sortOrder" < 0
  ) THEN
    RAISE EXCEPTION 'a bird passport child table contains an orphan or negative sortOrder';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bird_passport_otps otp
    LEFT JOIN public.bird_passports parent ON parent.id = otp."birdPassportId"
    WHERE parent.id IS NULL
       OR otp.attempts < 0
       OR otp.purpose <> 'bird-passport-lookup'
       OR otp.phone !~ '^09[0-9]{9}$'
  ) THEN
    RAISE EXCEPTION 'bird_passport_otps contains invalid or orphaned data';
  END IF;
END
$existing_data_verification$;

COMMIT;
