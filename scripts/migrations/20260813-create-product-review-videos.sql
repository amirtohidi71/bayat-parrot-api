\set ON_ERROR_STOP on

BEGIN;

DO $preflight$
DECLARE
  object_kind "char";
BEGIN
  SELECT c.relkind
  INTO object_kind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'product_review_videos';

  IF object_kind IS NOT NULL AND object_kind <> 'r' THEN
    RAISE EXCEPTION
      'public.product_review_videos exists with incompatible relkind %',
      object_kind;
  END IF;

  IF pg_catalog.to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'required table public.products does not exist';
  END IF;

  IF pg_catalog.to_regprocedure('public.uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'required function public.uuid_generate_v4() does not exist';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.product_review_videos (
  id uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "productId" uuid NOT NULL,
  "videoPath" text NOT NULL,
  "coverPath" text NOT NULL,
  "videoMimeType" varchar(50) NOT NULL,
  "displayOrder" integer NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_review_videos_pkey PRIMARY KEY (id),
  CONSTRAINT "FK_product_review_videos_product"
    FOREIGN KEY ("productId") REFERENCES public.products(id) ON DELETE CASCADE,
  CONSTRAINT "CHK_product_review_videos_display_order"
    CHECK ("displayOrder" >= 0)
);

CREATE INDEX IF NOT EXISTS "IDX_product_review_videos_product_order"
  ON public.product_review_videos USING btree ("productId", "displayOrder", id);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_product_review_videos_video_path"
  ON public.product_review_videos USING btree ("videoPath");

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_product_review_videos_cover_path"
  ON public.product_review_videos USING btree ("coverPath");

DO $verification$
DECLARE
  actual_count integer;
  expected_count integer;
  actual_definition text;
  primary_column smallint;
  source_column smallint;
  target_column smallint;
  index_columns text[];
  index_unique boolean;
  index_valid boolean;
  index_ready boolean;
  index_predicate text;
  index_method name;
BEGIN
  IF pg_catalog.to_regclass('public.product_review_videos') IS NULL THEN
    RAISE EXCEPTION 'public.product_review_videos was not created';
  END IF;

  WITH expected(name, type_name, not_null, default_expression) AS (
    VALUES
      ('id', 'uuid', true, 'uuid_generate_v4()'),
      ('productId', 'uuid', true, NULL::text),
      ('videoPath', 'text', true, NULL::text),
      ('coverPath', 'text', true, NULL::text),
      ('videoMimeType', 'character varying(50)', true, NULL::text),
      ('displayOrder', 'integer', true, NULL::text),
      ('createdAt', 'timestamp with time zone', true, 'now()'),
      ('updatedAt', 'timestamp with time zone', true, 'now()')
  ),
  actual AS (
    SELECT
      a.attname::text AS name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_name,
      a.attnotnull AS not_null,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.product_review_videos'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
  )
  SELECT COUNT(*) INTO actual_count FROM actual;

  expected_count := 8;
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION
      'product_review_videos column count mismatch: expected %, actual %',
      expected_count,
      actual_count;
  END IF;

  IF EXISTS (
    WITH expected(name, type_name, not_null, default_expression) AS (
      VALUES
        ('id', 'uuid', true, 'uuid_generate_v4()'),
        ('productId', 'uuid', true, NULL::text),
        ('videoPath', 'text', true, NULL::text),
        ('coverPath', 'text', true, NULL::text),
        ('videoMimeType', 'character varying(50)', true, NULL::text),
        ('displayOrder', 'integer', true, NULL::text),
        ('createdAt', 'timestamp with time zone', true, 'now()'),
        ('updatedAt', 'timestamp with time zone', true, 'now()')
    ),
    actual AS (
      SELECT
        a.attname::text,
        pg_catalog.format_type(a.atttypid, a.atttypmod),
        a.attnotnull,
        pg_catalog.pg_get_expr(d.adbin, d.adrelid)
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d
        ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.product_review_videos'::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'product_review_videos column definition mismatch';
  END IF;

  SELECT COUNT(*)
  INTO actual_count
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.product_review_videos'::regclass;

  expected_count := 3;
  IF actual_count <> expected_count OR EXISTS (
    WITH expected(name) AS (
      VALUES
        ('product_review_videos_pkey'),
        ('FK_product_review_videos_product'),
        ('CHK_product_review_videos_display_order')
    ),
    actual(name) AS (
      SELECT c.conname::text
      FROM pg_catalog.pg_constraint c
      WHERE c.conrelid = 'public.product_review_videos'::regclass
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'product_review_videos constraint set mismatch';
  END IF;

  SELECT a.attnum INTO primary_column
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.product_review_videos'::regclass
    AND a.attname = 'id';

  PERFORM 1
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.product_review_videos'::regclass
    AND c.conname = 'product_review_videos_pkey'
    AND c.contype = 'p'
    AND c.conkey = ARRAY[primary_column]::smallint[]
    AND c.convalidated;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_review_videos primary key definition mismatch';
  END IF;

  SELECT a.attnum INTO source_column
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.product_review_videos'::regclass
    AND a.attname = 'productId';

  SELECT a.attnum INTO target_column
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.products'::regclass
    AND a.attname = 'id';

  PERFORM 1
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.product_review_videos'::regclass
    AND c.conname = 'FK_product_review_videos_product'
    AND c.contype = 'f'
    AND c.confrelid = 'public.products'::regclass
    AND c.conkey = ARRAY[source_column]::smallint[]
    AND c.confkey = ARRAY[target_column]::smallint[]
    AND c.confdeltype = 'c'
    AND c.convalidated;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_review_videos FK definition mismatch';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid, false)
  INTO actual_definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.product_review_videos'::regclass
    AND c.conname = 'CHK_product_review_videos_display_order'
    AND c.contype = 'c'
    AND c.convalidated;
  IF actual_definition IS NULL OR
     regexp_replace(actual_definition, '[()"[:space:]]', '', 'g') <>
       'CHECKdisplayOrder>=0' THEN
    RAISE EXCEPTION 'product_review_videos displayOrder check mismatch: %',
      actual_definition;
  END IF;

  SELECT COUNT(*)
  INTO actual_count
  FROM pg_catalog.pg_index i
  WHERE i.indrelid = 'public.product_review_videos'::regclass;
  expected_count := 4;
  IF actual_count <> expected_count OR EXISTS (
    WITH expected(name) AS (
      VALUES
        ('product_review_videos_pkey'),
        ('IDX_product_review_videos_product_order'),
        ('UQ_product_review_videos_video_path'),
        ('UQ_product_review_videos_cover_path')
    ),
    actual(name) AS (
      SELECT index_class.relname::text
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class index_class ON index_class.oid = i.indexrelid
      WHERE i.indrelid = 'public.product_review_videos'::regclass
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'product_review_videos index set mismatch';
  END IF;

  SELECT
    array_agg(a.attname::text ORDER BY keys.ordinality),
    i.indisunique,
    i.indisvalid,
    i.indisready,
    pg_catalog.pg_get_expr(i.indpred, i.indrelid),
    am.amname
  INTO
    index_columns,
    index_unique,
    index_valid,
    index_ready,
    index_predicate,
    index_method
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class index_class ON index_class.oid = i.indexrelid
  JOIN pg_catalog.pg_class table_class ON table_class.oid = i.indrelid
  JOIN pg_catalog.pg_am am ON am.oid = index_class.relam
  CROSS JOIN LATERAL unnest(i.indkey::smallint[]) WITH ORDINALITY AS keys(attnum, ordinality)
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = table_class.oid AND a.attnum = keys.attnum
  WHERE table_class.oid = 'public.product_review_videos'::regclass
    AND index_class.relname = 'IDX_product_review_videos_product_order'
  GROUP BY
    i.indisunique,
    i.indisvalid,
    i.indisready,
    i.indpred,
    i.indrelid,
    am.amname;

  IF index_columns IS DISTINCT FROM ARRAY['productId', 'displayOrder', 'id']
     OR index_unique IS DISTINCT FROM false
     OR index_valid IS DISTINCT FROM true
     OR index_ready IS DISTINCT FROM true
     OR index_predicate IS NOT NULL
     OR index_method IS DISTINCT FROM 'btree' THEN
    RAISE EXCEPTION 'product_review_videos ordering index mismatch';
  END IF;

  IF EXISTS (
    WITH expected(
      name,
      columns,
      is_unique,
      is_valid,
      is_ready,
      predicate,
      method
    ) AS (
      VALUES
        (
          'UQ_product_review_videos_video_path',
          ARRAY['videoPath']::text[],
          true,
          true,
          true,
          NULL::text,
          'btree'::name
        ),
        (
          'UQ_product_review_videos_cover_path',
          ARRAY['coverPath']::text[],
          true,
          true,
          true,
          NULL::text,
          'btree'::name
        )
    ),
    actual AS (
      SELECT
        index_class.relname::text AS name,
        ARRAY(
          SELECT a.attname::text
          FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS keys(attnum, ordinality)
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = i.indrelid AND a.attnum = keys.attnum
          ORDER BY keys.ordinality
        ) AS columns,
        i.indisunique AS is_unique,
        i.indisvalid AS is_valid,
        i.indisready AS is_ready,
        pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate,
        am.amname AS method
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class index_class ON index_class.oid = i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid = index_class.relam
      WHERE i.indrelid = 'public.product_review_videos'::regclass
        AND index_class.relname IN (
          'UQ_product_review_videos_video_path',
          'UQ_product_review_videos_cover_path'
        )
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'product_review_videos unique path index definition mismatch';
  END IF;
END
$verification$;

COMMIT;
