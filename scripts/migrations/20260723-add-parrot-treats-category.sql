-- Operational prerequisites (verify before execution):
-- 1. Check the PostgreSQL server version with: SHOW server_version;
-- 2. This migration is designed and reviewed for PostgreSQL 12 and later.
-- 3. Run this file in autocommit mode; do not run it inside an external
--    transaction.
-- 4. Run this migration before starting or restarting the new backend version
--    that recognizes the parrot-treats enum value.
-- 5. After an enum value is added, there is no simple, safe rollback that
--    removes it. Reversal requires a separately reviewed migration.
--
-- Adds the parrot-treats value to the PostgreSQL enum used by
-- products.categorySlug without assuming the generated enum type name.
--
-- Run this file with psql in its normal autocommit mode. Do not wrap it in an
-- outer BEGIN/COMMIT block and do not use psql --single-transaction. PostgreSQL
-- cannot use a newly added enum value until the transaction that added it has
-- committed. The DO block below is one transaction and commits before the
-- post-migration verification query when autocommit is enabled.
--
-- PostgreSQL does not provide a simple, safe rollback for removing an enum
-- value. Rolling this change back requires a separately reviewed enum-type
-- replacement migration. This migration does not modify any product rows.

-- Pre-migration verification: identify the exact enum backing the column and
-- report whether the requested value already exists.
SELECT
  table_namespace.nspname AS table_schema,
  table_class.relname AS table_name,
  column_attribute.attname AS column_name,
  enum_namespace.nspname AS enum_schema,
  enum_type.typname AS enum_name,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum existing_value
    WHERE existing_value.enumtypid = enum_type.oid
      AND existing_value.enumlabel = 'parrot-treats'
  ) AS value_already_exists
FROM pg_catalog.pg_attribute column_attribute
JOIN pg_catalog.pg_class table_class
  ON table_class.oid = column_attribute.attrelid
JOIN pg_catalog.pg_namespace table_namespace
  ON table_namespace.oid = table_class.relnamespace
JOIN pg_catalog.pg_type enum_type
  ON enum_type.oid = column_attribute.atttypid
 AND enum_type.typtype = 'e'
JOIN pg_catalog.pg_namespace enum_namespace
  ON enum_namespace.oid = enum_type.typnamespace
WHERE table_class.relname = 'products'
  AND column_attribute.attname = 'categorySlug'
  AND column_attribute.attnum > 0
  AND NOT column_attribute.attisdropped
  AND table_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND table_namespace.nspname NOT LIKE 'pg_toast%';

DO $migration$
DECLARE
  target_count integer;
  target_enum_schema text;
  target_enum_name text;
  target_enum_oid oid;
BEGIN
  SELECT COUNT(*)
  INTO target_count
  FROM pg_catalog.pg_attribute column_attribute
  JOIN pg_catalog.pg_class table_class
    ON table_class.oid = column_attribute.attrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_class.relnamespace
  JOIN pg_catalog.pg_type enum_type
    ON enum_type.oid = column_attribute.atttypid
   AND enum_type.typtype = 'e'
  JOIN pg_catalog.pg_namespace enum_namespace
    ON enum_namespace.oid = enum_type.typnamespace
  WHERE table_class.relname = 'products'
    AND column_attribute.attname = 'categorySlug'
    AND column_attribute.attnum > 0
    AND NOT column_attribute.attisdropped
    AND table_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND table_namespace.nspname NOT LIKE 'pg_toast%';

  IF target_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one enum-backed products.categorySlug column, found %',
      target_count;
  END IF;

  SELECT
    enum_namespace.nspname,
    enum_type.typname,
    enum_type.oid
  INTO
    target_enum_schema,
    target_enum_name,
    target_enum_oid
  FROM pg_catalog.pg_attribute column_attribute
  JOIN pg_catalog.pg_class table_class
    ON table_class.oid = column_attribute.attrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_class.relnamespace
  JOIN pg_catalog.pg_type enum_type
    ON enum_type.oid = column_attribute.atttypid
   AND enum_type.typtype = 'e'
  JOIN pg_catalog.pg_namespace enum_namespace
    ON enum_namespace.oid = enum_type.typnamespace
  WHERE table_class.relname = 'products'
    AND column_attribute.attname = 'categorySlug'
    AND column_attribute.attnum > 0
    AND NOT column_attribute.attisdropped
    AND table_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND table_namespace.nspname NOT LIKE 'pg_toast%';

  EXECUTE format(
    'ALTER TYPE %I.%I ADD VALUE IF NOT EXISTS %L',
    target_enum_schema,
    target_enum_name,
    'parrot-treats'
  );

  RAISE NOTICE 'Verified enum type %.% (oid=%)',
    target_enum_schema,
    target_enum_name,
    target_enum_oid;
END
$migration$;

-- Post-migration verification: this must return one parrot-treats row.
SELECT
  enum_namespace.nspname AS enum_schema,
  enum_type.typname AS enum_name,
  enum_value.enumlabel AS added_value,
  enum_value.enumsortorder
FROM pg_catalog.pg_attribute column_attribute
JOIN pg_catalog.pg_class table_class
  ON table_class.oid = column_attribute.attrelid
JOIN pg_catalog.pg_namespace table_namespace
  ON table_namespace.oid = table_class.relnamespace
JOIN pg_catalog.pg_type enum_type
  ON enum_type.oid = column_attribute.atttypid
 AND enum_type.typtype = 'e'
JOIN pg_catalog.pg_namespace enum_namespace
  ON enum_namespace.oid = enum_type.typnamespace
JOIN pg_catalog.pg_enum enum_value
  ON enum_value.enumtypid = enum_type.oid
 AND enum_value.enumlabel = 'parrot-treats'
WHERE table_class.relname = 'products'
  AND column_attribute.attname = 'categorySlug'
  AND column_attribute.attnum > 0
  AND NOT column_attribute.attisdropped
  AND table_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND table_namespace.nspname NOT LIKE 'pg_toast%';
